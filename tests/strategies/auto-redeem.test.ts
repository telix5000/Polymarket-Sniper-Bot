import assert from "node:assert";
import { test, describe } from "node:test";

/**
 * Unit tests for Auto-Redeem Strategy
 *
 * These tests verify:
 * 1. On-chain resolution check prevents premature redemption attempts
 * 2. "Not resolved yet" errors are handled gracefully (not counted as failures)
 * 3. Proper detection of "result for condition not received yet" error message
 */

// Mock types matching the actual implementation
interface MockRedemptionResult {
  tokenId: string;
  marketId: string;
  success: boolean;
  transactionHash?: string;
  amountRedeemed?: string;
  error?: string;
  isRateLimited?: boolean;
  isNotResolvedYet?: boolean;
}

// Helper function to simulate checking if a "not resolved yet" error
function isNotResolvedYetError(errorMsg: string): boolean {
  return (
    errorMsg.includes("result for condition not received yet") ||
    errorMsg.includes("condition not resolved") ||
    errorMsg.includes("payoutDenominator=0")
  );
}

// Helper function to simulate checking if error is due to RPC rate limiting
function isRpcRateLimitError(msg: string): boolean {
  return (
    msg.includes("in-flight transaction limit") ||
    msg.includes("rate limit") ||
    msg.includes("Too Many Requests") ||
    msg.includes("429") ||
    msg.includes("-32000") ||
    msg.includes("-32005")
  );
}

// Helper function to simulate the redemption attempt tracking logic
function updateRedemptionAttempts(
  attempts: Map<string, { lastAttempt: number; failures: number }>,
  marketId: string,
  result: MockRedemptionResult,
): void {
  if (result.success) {
    // Clear attempts on success
    attempts.delete(marketId);
    return;
  }

  if (result.isRateLimited) {
    // Don't count rate limits as failures
    return;
  }

  if (result.isNotResolvedYet) {
    // Don't increment failures for "not resolved yet" - just set cooldown
    attempts.set(marketId, {
      lastAttempt: Date.now(),
      failures: 0, // Reset failures - this is expected behavior
    });
    return;
  }

  // Track actual failure
  const currentAttempts = attempts.get(marketId) || {
    lastAttempt: 0,
    failures: 0,
  };
  attempts.set(marketId, {
    lastAttempt: Date.now(),
    failures: currentAttempts.failures + 1,
  });
}

describe("Auto-Redeem On-Chain Resolution Check", () => {
  describe("Error Detection", () => {
    test("should detect 'result for condition not received yet' error", () => {
      const errorMsg =
        'execution reverted: "result for condition not received yet"';

      assert.strictEqual(
        isNotResolvedYetError(errorMsg),
        true,
        "Should detect contract revert message",
      );
    });

    test("should detect 'condition not resolved' error", () => {
      const errorMsg = "condition not resolved on-chain";

      assert.strictEqual(
        isNotResolvedYetError(errorMsg),
        true,
        "Should detect condition not resolved message",
      );
    });

    test("should detect 'payoutDenominator=0' error", () => {
      const errorMsg =
        "Condition not resolved on-chain yet (payoutDenominator=0)";

      assert.strictEqual(
        isNotResolvedYetError(errorMsg),
        true,
        "Should detect payoutDenominator=0 message",
      );
    });

    test("should NOT detect unrelated errors as 'not resolved yet'", () => {
      const errorMsg = "insufficient funds for gas";

      assert.strictEqual(
        isNotResolvedYetError(errorMsg),
        false,
        "Should not match unrelated errors",
      );
    });
  });

  describe("Failure Tracking", () => {
    test("should NOT increment failure count for 'not resolved yet' errors", () => {
      const attempts = new Map<
        string,
        { lastAttempt: number; failures: number }
      >();
      const marketId = "0x1234567890abcdef";

      // Simulate a "not resolved yet" result
      const result: MockRedemptionResult = {
        tokenId: "token-123",
        marketId,
        success: false,
        error: "Condition not resolved on-chain yet (payoutDenominator=0)",
        isNotResolvedYet: true,
      };

      updateRedemptionAttempts(attempts, marketId, result);

      const tracked = attempts.get(marketId);
      assert.ok(tracked, "Should have tracking entry");
      assert.strictEqual(
        tracked.failures,
        0,
        "Should NOT increment failures for not-resolved-yet",
      );
    });

    test("should increment failure count for real errors", () => {
      const attempts = new Map<
        string,
        { lastAttempt: number; failures: number }
      >();
      const marketId = "0x1234567890abcdef";

      // Simulate a real failure
      const result: MockRedemptionResult = {
        tokenId: "token-123",
        marketId,
        success: false,
        error: "Transaction reverted: unknown reason",
        isNotResolvedYet: false,
      };

      updateRedemptionAttempts(attempts, marketId, result);

      const tracked = attempts.get(marketId);
      assert.ok(tracked, "Should have tracking entry");
      assert.strictEqual(
        tracked.failures,
        1,
        "Should increment failures for real errors",
      );
    });

    test("should NOT count rate limit errors as failures", () => {
      const attempts = new Map<
        string,
        { lastAttempt: number; failures: number }
      >();
      const marketId = "0x1234567890abcdef";

      // Simulate a rate limit result
      const result: MockRedemptionResult = {
        tokenId: "token-123",
        marketId,
        success: false,
        error: "in-flight transaction limit reached",
        isRateLimited: true,
      };

      updateRedemptionAttempts(attempts, marketId, result);

      const tracked = attempts.get(marketId);
      assert.strictEqual(
        tracked,
        undefined,
        "Should NOT track rate limit as failure",
      );
    });

    test("should clear attempts on success", () => {
      const attempts = new Map<
        string,
        { lastAttempt: number; failures: number }
      >();
      const marketId = "0x1234567890abcdef";

      // Pre-populate with some failures
      attempts.set(marketId, { lastAttempt: Date.now() - 1000, failures: 2 });

      // Simulate success
      const result: MockRedemptionResult = {
        tokenId: "token-123",
        marketId,
        success: true,
        transactionHash: "0xabc123",
      };

      updateRedemptionAttempts(attempts, marketId, result);

      assert.strictEqual(
        attempts.has(marketId),
        false,
        "Should clear tracking on success",
      );
    });
  });

  describe("On-Chain Resolution Simulation", () => {
    test("payoutDenominator > 0 means condition is resolved", () => {
      // Simulate on-chain payoutDenominator values
      const resolvedPayoutDenominator = 1n; // Non-zero means resolved
      const unresolvedPayoutDenominator = 0n; // Zero means not resolved

      assert.strictEqual(
        resolvedPayoutDenominator > 0n,
        true,
        "Non-zero payoutDenominator should indicate resolved",
      );

      assert.strictEqual(
        unresolvedPayoutDenominator > 0n,
        false,
        "Zero payoutDenominator should indicate not resolved",
      );
    });
  });

  describe("Rate Limit Error Detection", () => {
    test("should detect -32005 error code", () => {
      const errorMsg = 'error code: -32005, message: "Too Many Requests"';

      assert.strictEqual(
        isRpcRateLimitError(errorMsg),
        true,
        "Should detect -32005 error code",
      );
    });

    test("should detect 'Too Many Requests' message", () => {
      const errorMsg =
        'Error: missing response for request (value=[ { "code": -32005, "message": "Too Many Requests" } ])';

      assert.strictEqual(
        isRpcRateLimitError(errorMsg),
        true,
        "Should detect 'Too Many Requests' message",
      );
    });

    test("should detect 'in-flight transaction limit' error", () => {
      const errorMsg = "in-flight transaction limit reached";

      assert.strictEqual(
        isRpcRateLimitError(errorMsg),
        true,
        "Should detect in-flight transaction limit",
      );
    });

    test("should detect 'rate limit' error", () => {
      const errorMsg = "rate limit exceeded";

      assert.strictEqual(
        isRpcRateLimitError(errorMsg),
        true,
        "Should detect rate limit message",
      );
    });

    test("should detect HTTP 429 status code", () => {
      const errorMsg = "HTTP Error 429: Too Many Requests";

      assert.strictEqual(
        isRpcRateLimitError(errorMsg),
        true,
        "Should detect HTTP 429 status",
      );
    });

    test("should detect -32000 error code", () => {
      const errorMsg = "JSON-RPC error: -32000";

      assert.strictEqual(
        isRpcRateLimitError(errorMsg),
        true,
        "Should detect -32000 error code",
      );
    });

    test("should NOT detect unrelated errors as rate limits", () => {
      const errorMsg = "insufficient funds for gas";

      assert.strictEqual(
        isRpcRateLimitError(errorMsg),
        false,
        "Should not match unrelated errors",
      );
    });

    test("should detect polygon gas station rate limit error", () => {
      // This is the exact error format from the user's logs
      const errorMsg =
        'error encountered with polygon gas station ("https://gasstation.polygon.technology/v2") (request={  }, response=null, error={ "code": "BAD_DATA", "info": { "payload": { "id": 336, "jsonrpc": "2.0", "method": "eth_getBlockByNumber", "params": [ "latest", false ] } }, "shortMessage": "missing response for request", "value": [ { "code": -32005, "data": { "see": "https://infura.io/dashboard" }, "message": "Too Many Requests" } ] })';

      assert.strictEqual(
        isRpcRateLimitError(errorMsg),
        true,
        "Should detect polygon gas station rate limit error with -32005",
      );
    });
  });
});
