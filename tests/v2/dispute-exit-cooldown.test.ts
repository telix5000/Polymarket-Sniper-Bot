import assert from "node:assert";
import { test, describe } from "node:test";

/**
 * Unit tests for V2 Dispute Exit Cooldown
 *
 * When a position is at the dispute window exit price (≥0.999) but the sell
 * attempt fails (e.g., SKIP_MIN_ORDER_SIZE), the position is added to a cooldown
 * to prevent repeated sell attempts. The position should wait for redemption.
 *
 * This prevents log spam like:
 * "📢 SELL ❌ | DisputeExit ($1.00) | Team WE $6.16 | SKIP_MIN_ORDER_SIZE"
 */

// Constants that mirror the implementation in src/v2/index.ts
const DISPUTE_EXIT_COOLDOWN_TTL_MS = 10 * 60 * 1000; // 10 minutes
const DISPUTE_EXIT_PRICE_THRESHOLD = 0.999; // 99.9¢

describe("V2 Dispute Exit Cooldown", () => {
  // Simulate the cooldown state
  type CooldownState = Map<string, number>; // tokenId -> timestamp

  /**
   * Helper to check if a position should skip dispute exit sell due to cooldown
   */
  function shouldSkipDisputeExit(
    tokenId: string,
    curPrice: number,
    cooldownState: CooldownState,
    now: number = Date.now(),
  ): { skip: boolean; reason?: string } {
    // First check if position is in dispute exit price range
    if (curPrice < DISPUTE_EXIT_PRICE_THRESHOLD || curPrice >= 1.0) {
      return { skip: false, reason: "Not in dispute exit price range" };
    }

    // Check cooldown
    const cooldownTime = cooldownState.get(tokenId);
    if (cooldownTime && now - cooldownTime < DISPUTE_EXIT_COOLDOWN_TTL_MS) {
      return { skip: true, reason: "In cooldown, waiting for redemption" };
    }

    // TTL expired or not in cooldown
    if (cooldownTime) {
      cooldownState.delete(tokenId);
    }

    return { skip: false };
  }

  /**
   * Helper to add position to cooldown after failed sell
   */
  function addToCooldown(
    tokenId: string,
    cooldownState: CooldownState,
    now: number = Date.now(),
  ): void {
    cooldownState.set(tokenId, now);
  }

  describe("DISPUTE_EXIT_COOLDOWN_TTL_MS constant validation", () => {
    test("DISPUTE_EXIT_COOLDOWN_TTL_MS should be 10 minutes (600000ms)", () => {
      assert.strictEqual(
        DISPUTE_EXIT_COOLDOWN_TTL_MS,
        10 * 60 * 1000,
        "Cooldown TTL should be 10 minutes",
      );
    });

    test("Cooldown TTL should be shorter than 1 hour (to recheck for redemption)", () => {
      const ONE_HOUR_MS = 60 * 60 * 1000;
      assert.ok(
        DISPUTE_EXIT_COOLDOWN_TTL_MS < ONE_HOUR_MS,
        "Cooldown should be shorter than 1 hour to allow periodic rechecks",
      );
    });
  });

  describe("Cooldown logic - preventing repeated sell attempts", () => {
    test("Position NOT in cooldown should NOT be skipped", () => {
      const cooldownState: CooldownState = new Map();
      const tokenId = "test-token-1";
      const curPrice = 0.999; // At dispute exit threshold

      const result = shouldSkipDisputeExit(
        tokenId,
        curPrice,
        cooldownState,
      );

      assert.strictEqual(
        result.skip,
        false,
        "Position not in cooldown should not be skipped",
      );
    });

    test("Position in cooldown within TTL should be skipped", () => {
      const cooldownState: CooldownState = new Map();
      const tokenId = "test-token-1";
      const curPrice = 0.999;
      const now = Date.now();

      // Add to cooldown
      addToCooldown(tokenId, cooldownState, now);

      // Check immediately (within TTL)
      const result = shouldSkipDisputeExit(
        tokenId,
        curPrice,
        cooldownState,
        now + 1000, // 1 second later
      );

      assert.strictEqual(
        result.skip,
        true,
        "Position in cooldown should be skipped",
      );
      assert.ok(
        result.reason?.includes("cooldown"),
        "Reason should mention cooldown",
      );
    });

    test("Position in cooldown after TTL expires should NOT be skipped", () => {
      const cooldownState: CooldownState = new Map();
      const tokenId = "test-token-1";
      const curPrice = 0.999;
      const now = Date.now();

      // Add to cooldown
      addToCooldown(tokenId, cooldownState, now);

      // Check after TTL expires
      const afterTtl = now + DISPUTE_EXIT_COOLDOWN_TTL_MS + 1000;
      const result = shouldSkipDisputeExit(
        tokenId,
        curPrice,
        cooldownState,
        afterTtl,
      );

      assert.strictEqual(
        result.skip,
        false,
        "Position should not be skipped after cooldown TTL expires",
      );
    });

    test("Cooldown map entry should be removed after TTL expires", () => {
      const cooldownState: CooldownState = new Map();
      const tokenId = "test-token-1";
      const curPrice = 0.999;
      const now = Date.now();

      // Add to cooldown
      addToCooldown(tokenId, cooldownState, now);
      assert.strictEqual(cooldownState.has(tokenId), true, "Token should be in cooldown");

      // Check after TTL expires (this should remove the entry)
      const afterTtl = now + DISPUTE_EXIT_COOLDOWN_TTL_MS + 1000;
      shouldSkipDisputeExit(tokenId, curPrice, cooldownState, afterTtl);

      assert.strictEqual(
        cooldownState.has(tokenId),
        false,
        "Token should be removed from cooldown after TTL expires",
      );
    });

    test("Multiple positions can be in cooldown independently", () => {
      const cooldownState: CooldownState = new Map();
      const now = Date.now();

      // Add first token to cooldown
      addToCooldown("token-1", cooldownState, now);

      // Add second token to cooldown later
      addToCooldown("token-2", cooldownState, now + 5 * 60 * 1000); // 5 minutes later

      // Check at 6 minutes: token-1 should still be in cooldown, token-2 as well
      const checkTime = now + 6 * 60 * 1000;
      const result1 = shouldSkipDisputeExit("token-1", 0.999, cooldownState, checkTime);
      const result2 = shouldSkipDisputeExit("token-2", 0.999, cooldownState, checkTime);

      assert.strictEqual(result1.skip, true, "Token-1 should still be in cooldown");
      assert.strictEqual(result2.skip, true, "Token-2 should still be in cooldown");

      // Check at 11 minutes: token-1 should be out of cooldown, token-2 still in
      const laterTime = now + 11 * 60 * 1000;
      const result3 = shouldSkipDisputeExit("token-1", 0.999, cooldownState, laterTime);
      const result4 = shouldSkipDisputeExit("token-2", 0.999, cooldownState, laterTime);

      assert.strictEqual(result3.skip, false, "Token-1 should be out of cooldown");
      assert.strictEqual(result4.skip, true, "Token-2 should still be in cooldown");
    });
  });

  describe("Price range validation", () => {
    test("Position below dispute exit threshold should not be checked for cooldown", () => {
      const cooldownState: CooldownState = new Map();
      const tokenId = "test-token-1";
      const curPrice = 0.95; // Below 0.999 threshold

      // Add to cooldown (simulating a previous failure)
      addToCooldown(tokenId, cooldownState);

      const result = shouldSkipDisputeExit(tokenId, curPrice, cooldownState);

      assert.strictEqual(
        result.skip,
        false,
        "Position below threshold should not be skipped due to cooldown",
      );
      assert.ok(
        result.reason?.includes("Not in dispute exit price range"),
        "Reason should indicate position is not in dispute exit range",
      );
    });

    test("Position at exactly 1.0 should not trigger dispute exit", () => {
      const cooldownState: CooldownState = new Map();
      const tokenId = "test-token-1";
      const curPrice = 1.0; // At $1 exactly - this should be redeemable, not sold

      const result = shouldSkipDisputeExit(tokenId, curPrice, cooldownState);

      assert.strictEqual(
        result.skip,
        false,
        "Position at exactly $1 should not be in dispute exit range",
      );
    });

    test("Position at 0.999 should be in dispute exit range", () => {
      const cooldownState: CooldownState = new Map();
      const tokenId = "test-token-1";
      const curPrice = 0.999;

      const result = shouldSkipDisputeExit(tokenId, curPrice, cooldownState);

      // Should not skip if not in cooldown
      assert.strictEqual(
        result.skip,
        false,
        "Position at 0.999 should be eligible for dispute exit",
      );
      assert.strictEqual(
        result.reason,
        undefined,
        "No reason when eligible for dispute exit",
      );
    });

    test("Position at 0.9999 (99.99¢) should be in dispute exit range", () => {
      const cooldownState: CooldownState = new Map();
      const tokenId = "test-token-1";
      const curPrice = 0.9999;

      const result = shouldSkipDisputeExit(tokenId, curPrice, cooldownState);

      assert.strictEqual(
        result.skip,
        false,
        "Position at 0.9999 should be eligible for dispute exit",
      );
    });
  });

  describe("Edge cases", () => {
    test("Empty cooldown state should not cause errors", () => {
      const cooldownState: CooldownState = new Map();
      const tokenId = "test-token-1";
      const curPrice = 0.999;

      const result = shouldSkipDisputeExit(tokenId, curPrice, cooldownState);

      assert.strictEqual(
        result.skip,
        false,
        "Empty cooldown should not skip",
      );
    });

    test("Checking non-existent token should not cause errors", () => {
      const cooldownState: CooldownState = new Map();
      // Add a different token
      addToCooldown("other-token", cooldownState);

      const result = shouldSkipDisputeExit(
        "test-token-1",
        0.999,
        cooldownState,
      );

      assert.strictEqual(
        result.skip,
        false,
        "Non-existent token should not be skipped",
      );
    });

    test("Re-adding to cooldown should update timestamp", () => {
      const cooldownState: CooldownState = new Map();
      const tokenId = "test-token-1";
      const now = Date.now();

      // Add to cooldown at time T
      addToCooldown(tokenId, cooldownState, now);

      // Add again at time T + 5 minutes
      const laterTime = now + 5 * 60 * 1000;
      addToCooldown(tokenId, cooldownState, laterTime);

      // Check at T + 12 minutes (should still be in cooldown because we updated at T+5)
      const checkTime = now + 12 * 60 * 1000;
      const result = shouldSkipDisputeExit(
        tokenId,
        0.999,
        cooldownState,
        checkTime,
      );

      assert.strictEqual(
        result.skip,
        true,
        "Updated cooldown timestamp should extend the cooldown period",
      );
    });
  });

  describe("Integration scenarios", () => {
    test("Scenario: Failed sell triggers cooldown, then retries after TTL", () => {
      const cooldownState: CooldownState = new Map();
      const tokenId = "dispute-position-1";
      const curPrice = 0.999;
      const now = Date.now();

      // Step 1: Initial check - should NOT skip (not in cooldown)
      let result = shouldSkipDisputeExit(tokenId, curPrice, cooldownState, now);
      assert.strictEqual(result.skip, false, "Initial check should not skip");

      // Step 2: Simulate sell failure - add to cooldown
      addToCooldown(tokenId, cooldownState, now);

      // Step 3: Subsequent checks within TTL should skip
      for (let i = 1; i <= 9; i++) {
        const checkTime = now + i * 60 * 1000; // Every minute
        result = shouldSkipDisputeExit(tokenId, curPrice, cooldownState, checkTime);
        assert.strictEqual(
          result.skip,
          true,
          `Check at minute ${i} should skip (in cooldown)`,
        );
      }

      // Step 4: After TTL expires, should NOT skip
      const afterTtl = now + 11 * 60 * 1000;
      result = shouldSkipDisputeExit(tokenId, curPrice, cooldownState, afterTtl);
      assert.strictEqual(
        result.skip,
        false,
        "Check after TTL should not skip",
      );
    });
  });
});
