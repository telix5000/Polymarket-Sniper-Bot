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

  describe("parseError", () => {
    it("should parse Cloudflare block correctly", () => {
      const result = parseError("Sorry, you have been blocked");
      assert.strictEqual(result.code, ErrorCode.CLOUDFLARE_BLOCK);
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
});
