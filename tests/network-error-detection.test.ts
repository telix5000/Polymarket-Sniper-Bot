import assert from "node:assert";
import { test, describe } from "node:test";
import {
  isNetworkError,
  TESTSELL_COMMON_ISSUES,
} from "../src/v2/index";

/**
 * Unit tests for V2 Network Error Detection
 *
 * These tests verify that:
 * 1. isNetworkError correctly identifies DNS/network errors
 * 2. isNetworkError correctly distinguishes network errors from liquidity issues
 * 3. TESTSELL_COMMON_ISSUES includes network/DNS errors
 */

describe("V2 Network Error Detection", () => {
  describe("isNetworkError helper function", () => {
    describe("should detect DNS errors", () => {
      test("EAI_AGAIN error should be detected", () => {
        assert.strictEqual(
          isNetworkError("getaddrinfo EAI_AGAIN clob.polymarket.com"),
          true,
          "EAI_AGAIN should be detected as network error",
        );
      });

      test("ENOTFOUND error should be detected", () => {
        assert.strictEqual(
          isNetworkError("getaddrinfo ENOTFOUND api.example.com"),
          true,
          "ENOTFOUND should be detected as network error",
        );
      });
    });

    describe("should detect connection errors", () => {
      test("ECONNREFUSED error should be detected", () => {
        assert.strictEqual(
          isNetworkError("connect ECONNREFUSED 127.0.0.1:8080"),
          true,
          "ECONNREFUSED should be detected as network error",
        );
      });

      test("ETIMEDOUT error should be detected", () => {
        assert.strictEqual(
          isNetworkError("connect ETIMEDOUT 10.0.0.1:443"),
          true,
          "ETIMEDOUT should be detected as network error",
        );
      });

      test("ECONNRESET error should be detected", () => {
        assert.strictEqual(
          isNetworkError("read ECONNRESET"),
          true,
          "ECONNRESET should be detected as network error",
        );
      });
    });

    describe("should detect generic network keywords", () => {
      test("getaddrinfo keyword should be detected", () => {
        assert.strictEqual(
          isNetworkError("getaddrinfo failed"),
          true,
          "getaddrinfo should be detected as network error",
        );
      });

      test("network keyword should be detected", () => {
        assert.strictEqual(
          isNetworkError("Network request failed"),
          true,
          "network keyword should be detected as network error",
        );
      });

      test("socket keyword should be detected", () => {
        assert.strictEqual(
          isNetworkError("Socket hang up"),
          true,
          "socket keyword should be detected as network error",
        );
      });
    });

    describe("should NOT detect non-network errors", () => {
      test("No bids available should NOT be detected as network error", () => {
        assert.strictEqual(
          isNetworkError("No bids available"),
          false,
          "Liquidity error should not be detected as network error",
        );
      });

      test("404 Not Found should NOT be detected as network error", () => {
        assert.strictEqual(
          isNetworkError("404 Not Found"),
          false,
          "HTTP 404 should not be detected as network error",
        );
      });

      test("Invalid API key should NOT be detected as network error", () => {
        assert.strictEqual(
          isNetworkError("Invalid API key"),
          false,
          "Auth error should not be detected as network error",
        );
      });

      test("Order too small should NOT be detected as network error", () => {
        assert.strictEqual(
          isNetworkError("Order too small"),
          false,
          "Order error should not be detected as network error",
        );
      });

      test("Market closed should NOT be detected as network error", () => {
        assert.strictEqual(
          isNetworkError("Market is closed"),
          false,
          "Market status error should not be detected as network error",
        );
      });

      test("Insufficient balance should NOT be detected as network error", () => {
        assert.strictEqual(
          isNetworkError("Insufficient balance"),
          false,
          "Balance error should not be detected as network error",
        );
      });
    });

    describe("case sensitivity", () => {
      test("lowercase network should be detected", () => {
        assert.strictEqual(
          isNetworkError("network error occurred"),
          true,
          "lowercase network should be detected",
        );
      });

      test("uppercase NETWORK should be detected", () => {
        assert.strictEqual(
          isNetworkError("NETWORK ERROR"),
          true,
          "uppercase NETWORK should be detected",
        );
      });

      test("mixed case Network should be detected", () => {
        assert.strictEqual(
          isNetworkError("Network timeout"),
          true,
          "mixed case Network should be detected",
        );
      });
    });

    describe("empty and edge cases", () => {
      test("empty string should NOT be detected as network error", () => {
        assert.strictEqual(
          isNetworkError(""),
          false,
          "empty string should not be network error",
        );
      });

      test("whitespace only should NOT be detected as network error", () => {
        assert.strictEqual(
          isNetworkError("   "),
          false,
          "whitespace should not be network error",
        );
      });
    });
  });

  describe("TESTSELL_COMMON_ISSUES list", () => {
    test("should include network/DNS errors entry", () => {
      const hasNetworkEntry = TESTSELL_COMMON_ISSUES.some(
        (issue) =>
          issue.includes("Network") &&
          issue.includes("DNS") &&
          issue.includes("EAI_AGAIN"),
      );
      assert.strictEqual(
        hasNetworkEntry,
        true,
        "TESTSELL_COMMON_ISSUES should include Network/DNS errors entry",
      );
    });

    test("should include ECONNREFUSED in network errors entry", () => {
      const hasEconnrefused = TESTSELL_COMMON_ISSUES.some((issue) =>
        issue.includes("ECONNREFUSED"),
      );
      assert.strictEqual(
        hasEconnrefused,
        true,
        "TESTSELL_COMMON_ISSUES should mention ECONNREFUSED",
      );
    });

    test("should include ETIMEDOUT in network errors entry", () => {
      const hasEtimedout = TESTSELL_COMMON_ISSUES.some((issue) =>
        issue.includes("ETIMEDOUT"),
      );
      assert.strictEqual(
        hasEtimedout,
        true,
        "TESTSELL_COMMON_ISSUES should mention ETIMEDOUT",
      );
    });

    test("should have multiple common issues", () => {
      assert.ok(
        TESTSELL_COMMON_ISSUES.length >= 4,
        "Should have at least 4 common issues documented",
      );
    });

    test("should include liquidity-related issues", () => {
      const hasLiquidityIssue = TESTSELL_COMMON_ISSUES.some(
        (issue) =>
          issue.toLowerCase().includes("bid") ||
          issue.toLowerCase().includes("liquidity"),
      );
      assert.strictEqual(
        hasLiquidityIssue,
        true,
        "Should include liquidity-related issues",
      );
    });
  });
});
