import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  AuthFailureRateLimiter,
  getAuthFailureRateLimiter,
  resetAuthFailureRateLimiter,
  type AuthFailureKey,
} from "../../src/utils/auth-failure-rate-limiter";

describe("AuthFailureRateLimiter", () => {
  beforeEach(() => {
    resetAuthFailureRateLimiter();
  });

  describe("shouldLog", () => {
    test("first failure should log full details", () => {
      const limiter = new AuthFailureRateLimiter({
        initialCooldownMs: 5000,
      });

      const failure: AuthFailureKey = {
        endpoint: "/balance-allowance",
        status: 401,
        signerAddress: "0x1234",
        signatureType: 0,
      };

      const result = limiter.shouldLog(failure);

      assert.strictEqual(result.shouldLogFull, true);
      assert.strictEqual(result.shouldLogSummary, false);
      assert.strictEqual(result.suppressedCount, 0);
    });

    test("repeated failures within cooldown should be suppressed", () => {
      const limiter = new AuthFailureRateLimiter({
        initialCooldownMs: 60000, // 1 minute
      });

      const failure: AuthFailureKey = {
        endpoint: "/balance-allowance",
        status: 401,
        signerAddress: "0x1234",
        signatureType: 0,
      };

      // First call - should log full
      const first = limiter.shouldLog(failure);
      assert.strictEqual(first.shouldLogFull, true);

      // Second call - should be suppressed
      const second = limiter.shouldLog(failure);
      assert.strictEqual(second.shouldLogFull, false);
      assert.strictEqual(second.shouldLogSummary, true);
      assert.strictEqual(second.suppressedCount, 1);

      // Third call - should still be suppressed
      const third = limiter.shouldLog(failure);
      assert.strictEqual(third.shouldLogFull, false);
      assert.strictEqual(third.shouldLogSummary, true);
      assert.strictEqual(third.suppressedCount, 2);
    });

    test("different failures should be tracked separately", () => {
      const limiter = new AuthFailureRateLimiter({
        initialCooldownMs: 60000,
      });

      const failure1: AuthFailureKey = {
        endpoint: "/balance-allowance",
        status: 401,
        signerAddress: "0x1234",
        signatureType: 0,
      };

      const failure2: AuthFailureKey = {
        endpoint: "/orders",
        status: 403,
        signerAddress: "0x1234",
        signatureType: 0,
      };

      // Both should log full on first occurrence
      const first1 = limiter.shouldLog(failure1);
      const first2 = limiter.shouldLog(failure2);

      assert.strictEqual(first1.shouldLogFull, true);
      assert.strictEqual(first2.shouldLogFull, true);

      // Both should be suppressed on second occurrence
      const second1 = limiter.shouldLog(failure1);
      const second2 = limiter.shouldLog(failure2);

      assert.strictEqual(second1.shouldLogFull, false);
      assert.strictEqual(second2.shouldLogFull, false);
    });

    test("failure after cooldown expires should log full again", async () => {
      const limiter = new AuthFailureRateLimiter({
        initialCooldownMs: 50, // 50ms for testing
        maxCooldownMs: 100,
        cooldownMultiplier: 2,
      });

      const failure: AuthFailureKey = {
        endpoint: "/balance-allowance",
        status: 401,
        signerAddress: "0x1234",
        signatureType: 0,
      };

      // First call - log full
      const first = limiter.shouldLog(failure);
      assert.strictEqual(first.shouldLogFull, true);

      // Second call immediately - suppressed
      const second = limiter.shouldLog(failure);
      assert.strictEqual(second.shouldLogFull, false);

      // Wait for cooldown to expire
      await new Promise((resolve) => setTimeout(resolve, 60));

      // Third call after cooldown - log full again
      const third = limiter.shouldLog(failure);
      assert.strictEqual(third.shouldLogFull, true);
      assert.ok(third.suppressedCount >= 1); // Should show suppressed count
    });
  });

  describe("getSummary", () => {
    test("returns empty string for first occurrence", () => {
      const limiter = new AuthFailureRateLimiter();

      const failure: AuthFailureKey = {
        endpoint: "/balance-allowance",
        status: 401,
        signerAddress: "0x1234",
        signatureType: 0,
      };

      const summary = limiter.getSummary(failure);
      assert.strictEqual(summary, "");
    });

    test("returns formatted summary for suppressed occurrences", () => {
      const limiter = new AuthFailureRateLimiter({
        initialCooldownMs: 60000,
      });

      const failure: AuthFailureKey = {
        endpoint: "/balance-allowance",
        status: 401,
        signerAddress: "0x1234",
        signatureType: 0,
      };

      // First call
      limiter.shouldLog(failure);

      // Second call - should return summary
      const summary = limiter.getSummary(failure);
      assert.ok(summary.includes("Auth still failing"));
      assert.ok(summary.includes("401"));
      assert.ok(summary.includes("suppressed"));
    });
  });

  describe("reset", () => {
    test("clears all tracked entries", () => {
      const limiter = new AuthFailureRateLimiter();

      const failure: AuthFailureKey = {
        endpoint: "/balance-allowance",
        status: 401,
        signerAddress: "0x1234",
        signatureType: 0,
      };

      limiter.shouldLog(failure);
      assert.strictEqual(limiter.getEntryCount(), 1);

      limiter.reset();
      assert.strictEqual(limiter.getEntryCount(), 0);

      // After reset, first occurrence should log full again
      const result = limiter.shouldLog(failure);
      assert.strictEqual(result.shouldLogFull, true);
    });
  });

  describe("global singleton", () => {
    test("getAuthFailureRateLimiter returns same instance", () => {
      const limiter1 = getAuthFailureRateLimiter();
      const limiter2 = getAuthFailureRateLimiter();
      assert.strictEqual(limiter1, limiter2);
    });

    test("resetAuthFailureRateLimiter creates new instance", () => {
      const limiter1 = getAuthFailureRateLimiter();
      const failure: AuthFailureKey = {
        endpoint: "/test",
        status: 401,
        signerAddress: "0x1234",
        signatureType: 0,
      };
      limiter1.shouldLog(failure);

      resetAuthFailureRateLimiter();

      const limiter2 = getAuthFailureRateLimiter();
      // New instance should log full for same failure
      const result = limiter2.shouldLog(failure);
      assert.strictEqual(result.shouldLogFull, true);
    });
  });
});
