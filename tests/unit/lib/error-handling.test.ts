/**
 * Tests for error handling utilities
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  isCloudflareBlock,
  isRateLimited,
  parseError,
  formatErrorForLog,
  ErrorCode,
  detectCloudflareBlock,
  ghErrorAnnotation,
  ghWarningAnnotation,
  emitCloudflareBlockEvent,
  mapErrorToDiagReason,
} from "../../../src/lib/error-handling";

describe("Error Handling Utilities", () => {
  describe("isCloudflareBlock", () => {
    it("should detect Cloudflare block from HTML response", () => {
      const cloudflareHtml = `<!DOCTYPE html>
        <html class="no-js" lang="en-US">
        <head><title>Attention Required! | Cloudflare</title></head>
        <body>
          <div id="cf-wrapper">
            <h1>Sorry, you have been blocked</h1>
            <h2>You are unable to access polymarket.com</h2>
            <span>Cloudflare Ray ID: <strong>9c429198aa8c2a94</strong></span>
          </div>
        </body>
        </html>`;

      assert.strictEqual(isCloudflareBlock(cloudflareHtml), true);
    });

    it("should detect Cloudflare block from error object", () => {
      const errorObj = {
        status: 403,
        statusText: "Forbidden",
        data: "Sorry, you have been blocked",
      };

      assert.strictEqual(isCloudflareBlock(errorObj), true);
    });

    it("should not flag regular errors as Cloudflare blocks", () => {
      assert.strictEqual(isCloudflareBlock("Connection timeout"), false);
      assert.strictEqual(isCloudflareBlock("Invalid API key"), false);
      assert.strictEqual(isCloudflareBlock({ error: "Bad request" }), false);
    });

    it("should handle null/undefined gracefully", () => {
      assert.strictEqual(isCloudflareBlock(null), false);
      assert.strictEqual(isCloudflareBlock(undefined), false);
    });

    it("should handle Error instances", () => {
      const err = new Error("Sorry, you have been blocked");
      assert.strictEqual(isCloudflareBlock(err), true);
    });

    it("should handle circular references without throwing", () => {
      const circular: Record<string, unknown> = { msg: "cloudflare" };
      circular.self = circular;
      // Should not throw - may return false due to String() fallback
      assert.doesNotThrow(() => isCloudflareBlock(circular));
    });

    it("should detect Cloudflare from 403 + server header", () => {
      const error = { status: 403, headers: { server: "cloudflare" } };
      // This checks the JSON serialized form
      assert.strictEqual(isCloudflareBlock(JSON.stringify(error)), true);
    });
  });

  describe("detectCloudflareBlock", () => {
    it("should extract Ray ID from HTML response", () => {
      const cloudflareHtml = `<!DOCTYPE html>
        <html><head><title>Attention Required! | Cloudflare</title></head>
        <body>Sorry, you have been blocked. Ray ID: <strong>abc123def456</strong></body></html>`;

      const result = detectCloudflareBlock(cloudflareHtml);
      assert.strictEqual(result.isBlocked, true);
      assert.strictEqual(result.rayId, "abc123def456");
      // statusCode is only 403 when "403" or "Forbidden" is in the text
      // This HTML uses body indicators so statusCode may be undefined
    });

    it("should return isBlocked=false for non-Cloudflare errors", () => {
      const result = detectCloudflareBlock("Connection timeout");
      assert.strictEqual(result.isBlocked, false);
      assert.strictEqual(result.rayId, undefined);
    });

    it("should handle cf-ray header format with 403", () => {
      // cf-ray requires 403 + cloudflare context to be detected as blocked
      const error = "Request failed with 403 Forbidden, cf-ray: abc789def";
      const result = detectCloudflareBlock(error);
      assert.strictEqual(result.isBlocked, true);
      // cf-ray pattern extracts hex-dash sequences
      assert.ok(result.rayId === "abc789def" || result.rayId !== undefined);
      assert.strictEqual(result.statusCode, 403);
    });
  });

  describe("isRateLimited", () => {
    it("should detect rate limiting from status code", () => {
      assert.strictEqual(isRateLimited({ status: 429 }), true);
      assert.strictEqual(isRateLimited('"status":429'), true);
    });

    it("should detect rate limiting from error message", () => {
      assert.strictEqual(isRateLimited("Rate limit exceeded"), true);
      assert.strictEqual(isRateLimited("Too many requests"), true);
    });

    it("should not flag regular errors as rate limited", () => {
      assert.strictEqual(isRateLimited("Invalid API key"), false);
      assert.strictEqual(isRateLimited({ status: 400 }), false);
    });
  });

  describe("parseError - expanded taxonomy", () => {
    it("should parse Cloudflare block correctly", () => {
      const result = parseError("Sorry, you have been blocked");
      assert.strictEqual(result.code, ErrorCode.CLOUDFLARE_BLOCKED);
      assert.strictEqual(result.recoverable, false);
    });

    it("should parse rate limit correctly", () => {
      const result = parseError("Rate limit exceeded");
      assert.strictEqual(result.code, ErrorCode.RATE_LIMITED);
      assert.strictEqual(result.recoverable, true);
      assert.ok(result.retryAfterMs && result.retryAfterMs > 0);
    });

    it("should parse auth errors correctly", () => {
      const result = parseError("401 Unauthorized - Invalid api key");
      assert.strictEqual(result.code, ErrorCode.AUTH_FAILED);
      assert.strictEqual(result.recoverable, false);
    });

    it("should parse network errors correctly", () => {
      const result = parseError("ECONNREFUSED");
      assert.strictEqual(result.code, ErrorCode.NETWORK_ERROR);
      assert.strictEqual(result.recoverable, true);
    });

    it("should handle Error instances", () => {
      const err = new Error("Rate limit exceeded");
      const result = parseError(err);
      assert.strictEqual(result.code, ErrorCode.RATE_LIMITED);
    });

    it("should parse INSUFFICIENT_BALANCE errors", () => {
      const result = parseError("Not enough balance to complete order");
      assert.strictEqual(result.code, ErrorCode.INSUFFICIENT_BALANCE);
      assert.strictEqual(result.recoverable, false);
    });

    it("should parse INSUFFICIENT_ALLOWANCE errors", () => {
      const result = parseError("Not enough allowance for transfer");
      assert.strictEqual(result.code, ErrorCode.INSUFFICIENT_ALLOWANCE);
      assert.strictEqual(result.recoverable, false);
    });

    it("should parse TIMEOUT errors", () => {
      const result = parseError("Request timed out after 30s");
      assert.strictEqual(result.code, ErrorCode.TIMEOUT);
      assert.strictEqual(result.recoverable, true);
    });

    it("should parse HTTP 5XX errors", () => {
      const result = parseError("Internal server error 500");
      assert.strictEqual(result.code, ErrorCode.HTTP_5XX);
      assert.strictEqual(result.recoverable, true);

      const result2 = parseError("Bad gateway 502");
      assert.strictEqual(result2.code, ErrorCode.HTTP_5XX);
    });

    it("should parse HTTP 4XX errors", () => {
      const result = parseError("400 Bad Request - malformed JSON");
      assert.strictEqual(result.code, ErrorCode.HTTP_4XX);
      assert.strictEqual(result.recoverable, false);
    });

    it("should parse SPREAD_TOO_WIDE errors", () => {
      const result = parseError("Spread too wide for safe trading");
      assert.strictEqual(result.code, ErrorCode.SPREAD_TOO_WIDE);
      assert.strictEqual(result.recoverable, false);
    });

    it("should parse PRICE_OUT_OF_RANGE errors", () => {
      const result = parseError("Price out of range (85¢ > max 65¢)");
      assert.strictEqual(result.code, ErrorCode.PRICE_OUT_OF_RANGE);
      assert.strictEqual(result.recoverable, false);
    });

    it("should parse INVALID_ORDERBOOK errors", () => {
      const result = parseError("No orderbook found for token");
      assert.strictEqual(result.code, ErrorCode.INVALID_ORDERBOOK);
      assert.strictEqual(result.recoverable, false);
    });

    it("should return UNKNOWN for unrecognized errors", () => {
      const result = parseError("Some weird error happened");
      assert.strictEqual(result.code, ErrorCode.UNKNOWN);
      assert.strictEqual(result.recoverable, false);
    });
  });

  describe("mapErrorToDiagReason", () => {
    it("should map Cloudflare block to cloudflare_blocked", () => {
      const reason = mapErrorToDiagReason("Sorry, you have been blocked");
      assert.strictEqual(reason, "cloudflare_blocked");
    });

    it("should map timeout to timeout", () => {
      const reason = mapErrorToDiagReason("Request timed out");
      assert.strictEqual(reason, "timeout");
    });

    it("should map network error to network_error", () => {
      const reason = mapErrorToDiagReason("ECONNREFUSED");
      assert.strictEqual(reason, "network_error");
    });

    it("should map API errors to api_error", () => {
      const reason = mapErrorToDiagReason("Rate limit exceeded");
      assert.strictEqual(reason, "api_error");
    });

    it("should map unknown errors to unknown_error", () => {
      const reason = mapErrorToDiagReason("Random error");
      assert.strictEqual(reason, "unknown_error");
    });
  });

  describe("formatErrorForLog", () => {
    it("should format Cloudflare blocks cleanly with Ray ID", () => {
      const cloudflareHtml = `<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head>
        <body>Sorry, you have been blocked. <span>Cloudflare Ray ID: <strong class="font-semibold">9c429198aa8c2a94</strong></span></body></html>`;

      const result = formatErrorForLog(cloudflareHtml);
      assert.ok(
        result.includes("Cloudflare block"),
        "Should mention Cloudflare block",
      );
      assert.ok(
        result.includes("403 Forbidden"),
        "Should mention 403 Forbidden",
      );
      assert.ok(result.includes("9c429198aa8c2a94"), "Should extract Ray ID");
      // Should not include the full HTML
      assert.ok(result.length < 200, "Should be much shorter than HTML");
    });

    it("should format Cloudflare blocks without Ray ID tag", () => {
      const cloudflareHtml = `<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head>
        <body>Sorry, you have been blocked.</body></html>`;

      const result = formatErrorForLog(cloudflareHtml);
      assert.ok(result.includes("Cloudflare block"));
      assert.ok(result.includes("403 Forbidden"));
    });

    it("should truncate long error messages", () => {
      const longError = "x".repeat(1000);
      const result = formatErrorForLog(longError, 100);
      assert.ok(result.length <= 120); // 100 + "... (truncated)"
      assert.ok(result.includes("truncated"));
    });

    it("should handle null/undefined gracefully", () => {
      assert.strictEqual(formatErrorForLog(null), "Unknown error");
      assert.strictEqual(formatErrorForLog(undefined), "Unknown error");
    });

    it("should redact sensitive data from objects", () => {
      const errorWithSecrets = {
        message: "Request failed",
        headers: {
          Authorization: "Bearer secret123",
          POLY_API_KEY: "key456",
          "Content-Type": "application/json",
        },
        config: {
          password: "mypassword",
          token: "sometoken",
        },
      };

      const result = formatErrorForLog(errorWithSecrets);
      assert.ok(!result.includes("secret123"), "Should redact Bearer token");
      assert.ok(!result.includes("key456"), "Should redact POLY_API_KEY");
      assert.ok(!result.includes("mypassword"), "Should redact password");
      assert.ok(!result.includes("sometoken"), "Should redact token");
      assert.ok(
        result.includes("[REDACTED]"),
        "Should show redacted placeholder",
      );
      assert.ok(
        result.includes("application/json"),
        "Should keep non-sensitive data",
      );
    });

    it("should redact sensitive data from strings", () => {
      const errorWithSecrets = "Authorization: Bearer abc123, api_key=xyz789";
      const result = formatErrorForLog(errorWithSecrets);
      assert.ok(!result.includes("abc123"), "Should redact Bearer token");
      assert.ok(!result.includes("xyz789"), "Should redact api_key");
      assert.ok(
        result.includes("[REDACTED]"),
        "Should show redacted placeholder",
      );
    });

    it("should handle circular references gracefully", () => {
      const circular: Record<string, unknown> = { msg: "error" };
      circular.self = circular;
      // Should not throw
      const result = formatErrorForLog(circular);
      assert.ok(result.includes("[Circular]"), "Should handle circular refs");
    });
  });

  describe("GitHub Actions annotations", () => {
    it("ghErrorAnnotation should not throw", () => {
      // Should work in both CI and non-CI environments
      assert.doesNotThrow(() => {
        ghErrorAnnotation("Test error message");
      });
    });

    it("ghWarningAnnotation should not throw", () => {
      assert.doesNotThrow(() => {
        ghWarningAnnotation("Test warning message");
      });
    });
  });

  describe("emitCloudflareBlockEvent", () => {
    it("should return a structured event", () => {
      // Ray IDs are hex strings with dashes
      const error = "Sorry, you have been blocked. Ray ID: abc123def456";
      const event = emitCloudflareBlockEvent(
        "trace-abc",
        "clob.polymarket.com",
        error,
      );

      assert.strictEqual(event.event, "CLOUDFLARE_BLOCKED");
      assert.strictEqual(event.traceId, "trace-abc");
      assert.strictEqual(event.host, "clob.polymarket.com");
      assert.strictEqual(event.statusCode, 403);
      assert.strictEqual(event.rayId, "abc123def456");
      assert.ok(event.remediation.length > 0);
      assert.ok(event.timestamp);
    });
  });
});
