import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  SingleFlightDerivation,
  getSingleFlightDerivation,
  resetSingleFlightDerivation,
  type DerivationResult,
} from "../../src/utils/single-flight-derivation";

describe("SingleFlightDerivation", () => {
  beforeEach(() => {
    resetSingleFlightDerivation();
  });

  describe("shouldRetry", () => {
    test("allows retry when no previous failures", () => {
      const singleFlight = new SingleFlightDerivation();
      const { canRetry, waitMs } = singleFlight.shouldRetry();
      assert.strictEqual(canRetry, true);
      assert.strictEqual(waitMs, 0);
    });

    test("blocks retry during backoff period", async () => {
      const singleFlight = new SingleFlightDerivation({
        initialBackoffMs: 100,
        maxBackoffMs: 200,
        backoffMultiplier: 2,
      });

      // Trigger a failure
      await singleFlight.derive(async () => ({
        success: false,
        error: "Test failure",
      }));

      const { canRetry, waitMs, reason } = singleFlight.shouldRetry();
      assert.strictEqual(canRetry, false);
      assert.ok(waitMs > 0);
      assert.ok(reason?.includes("Backoff"));
    });

    test("allows retry after backoff expires", async () => {
      const singleFlight = new SingleFlightDerivation({
        initialBackoffMs: 50, // Short for testing
        maxBackoffMs: 200,
        backoffMultiplier: 2,
      });

      // Trigger a failure - backoff becomes 50 * 2 = 100ms
      await singleFlight.derive(async () => ({
        success: false,
        error: "Test failure",
      }));

      // Wait for backoff to expire (100ms + buffer)
      await new Promise((resolve) => setTimeout(resolve, 120));

      const { canRetry } = singleFlight.shouldRetry();
      assert.strictEqual(canRetry, true);
    });
  });

  describe("derive", () => {
    test("executes derivation function on first call", async () => {
      const singleFlight = new SingleFlightDerivation();
      let callCount = 0;

      const result = await singleFlight.derive(async () => {
        callCount++;
        return {
          success: true,
          creds: { key: "test", secret: "test", passphrase: "test" },
        };
      });

      assert.strictEqual(callCount, 1);
      assert.strictEqual(result.success, true);
    });

    test("returns cached result on success", async () => {
      const singleFlight = new SingleFlightDerivation();
      let callCount = 0;

      const deriveFn = async (): Promise<DerivationResult> => {
        callCount++;
        return {
          success: true,
          creds: { key: "test", secret: "test", passphrase: "test" },
        };
      };

      // First call
      const result1 = await singleFlight.derive(deriveFn);
      // Second call - should return cached
      const result2 = await singleFlight.derive(deriveFn);

      assert.strictEqual(callCount, 1); // Only called once
      assert.deepStrictEqual(result1, result2);
    });

    test("blocks derivation during backoff", async () => {
      const singleFlight = new SingleFlightDerivation({
        initialBackoffMs: 1000,
        maxBackoffMs: 2000,
        backoffMultiplier: 2,
      });

      // First call - failure
      await singleFlight.derive(async () => ({
        success: false,
        error: "Test failure",
      }));

      // Second call - should be blocked
      const result = await singleFlight.derive(async () => ({
        success: true,
        creds: { key: "test", secret: "test", passphrase: "test" },
      }));

      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes("blocked"));
    });

    test("increases backoff exponentially on failures", async () => {
      const singleFlight = new SingleFlightDerivation({
        initialBackoffMs: 50,
        maxBackoffMs: 400,
        backoffMultiplier: 2,
      });

      // First failure
      await singleFlight.derive(async () => ({
        success: false,
        error: "Failure 1",
      }));

      let state = singleFlight.getState();
      assert.strictEqual(state.failureCount, 1);
      assert.strictEqual(state.currentBackoffMs, 100); // 50 * 2

      // Wait and trigger second failure
      await new Promise((resolve) => setTimeout(resolve, 110));

      await singleFlight.derive(async () => ({
        success: false,
        error: "Failure 2",
      }));

      state = singleFlight.getState();
      assert.strictEqual(state.failureCount, 2);
      assert.strictEqual(state.currentBackoffMs, 200); // 100 * 2
    });

    test("caps backoff at maxBackoffMs", async () => {
      const singleFlight = new SingleFlightDerivation({
        initialBackoffMs: 50,
        maxBackoffMs: 100,
        backoffMultiplier: 2,
      });

      // First failure
      await singleFlight.derive(async () => ({
        success: false,
        error: "Failure 1",
      }));

      // Wait and trigger multiple failures
      await new Promise((resolve) => setTimeout(resolve, 110));
      await singleFlight.derive(async () => ({
        success: false,
        error: "Failure 2",
      }));

      const state = singleFlight.getState();
      // Should be capped at 100
      assert.ok(state.currentBackoffMs <= 100);
    });

    test("resets backoff on success", async () => {
      const singleFlight = new SingleFlightDerivation({
        initialBackoffMs: 50,
        maxBackoffMs: 200,
        backoffMultiplier: 2,
      });

      // Trigger a failure
      await singleFlight.derive(async () => ({
        success: false,
        error: "Failure",
      }));

      let state = singleFlight.getState();
      assert.strictEqual(state.failureCount, 1);

      // Wait for backoff and succeed
      await new Promise((resolve) => setTimeout(resolve, 110));

      await singleFlight.derive(async () => ({
        success: true,
        creds: { key: "test", secret: "test", passphrase: "test" },
      }));

      state = singleFlight.getState();
      assert.strictEqual(state.failureCount, 0);
      assert.strictEqual(state.currentBackoffMs, 50); // Reset to initial
    });

    test("concurrent calls await in-flight derivation", async () => {
      const singleFlight = new SingleFlightDerivation();
      let callCount = 0;

      const deriveFn = async (): Promise<DerivationResult> => {
        callCount++;
        // Simulate async work
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          success: true,
          creds: { key: "test", secret: "test", passphrase: "test" },
        };
      };

      // Start multiple concurrent calls
      const promises = [
        singleFlight.derive(deriveFn),
        singleFlight.derive(deriveFn),
        singleFlight.derive(deriveFn),
      ];

      const results = await Promise.all(promises);

      // Only one actual call should have been made
      assert.strictEqual(callCount, 1);

      // All results should be the same
      assert.deepStrictEqual(results[0], results[1]);
      assert.deepStrictEqual(results[1], results[2]);
    });
  });

  describe("reset", () => {
    test("clears cached result and backoff state", async () => {
      const singleFlight = new SingleFlightDerivation({
        initialBackoffMs: 50,
      });

      // Create a cached result
      await singleFlight.derive(async () => ({
        success: true,
        creds: { key: "test", secret: "test", passphrase: "test" },
      }));

      let state = singleFlight.getState();
      assert.strictEqual(state.hasCachedResult, true);

      // Reset
      singleFlight.reset();

      state = singleFlight.getState();
      assert.strictEqual(state.hasCachedResult, false);
      assert.strictEqual(state.failureCount, 0);
      assert.strictEqual(state.canRetry, true);
    });
  });

  describe("global singleton", () => {
    test("getSingleFlightDerivation returns same instance", () => {
      const sf1 = getSingleFlightDerivation();
      const sf2 = getSingleFlightDerivation();
      assert.strictEqual(sf1, sf2);
    });

    test("resetSingleFlightDerivation creates new instance", async () => {
      const sf1 = getSingleFlightDerivation();

      // Cache a result
      await sf1.derive(async () => ({
        success: true,
        creds: { key: "test", secret: "test", passphrase: "test" },
      }));

      resetSingleFlightDerivation();

      const sf2 = getSingleFlightDerivation();

      // New instance should not have cached result
      const state = sf2.getState();
      assert.strictEqual(state.hasCachedResult, false);
    });
  });
});
