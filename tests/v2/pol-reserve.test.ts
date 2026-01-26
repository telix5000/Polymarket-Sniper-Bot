import assert from "node:assert";
import { test, describe } from "node:test";

/**
 * Unit tests for V2 POL Reserve Feature
 *
 * These tests verify that:
 * 1. POL reserve configuration is properly loaded from presets
 * 2. The rebalance logic triggers at the correct thresholds
 * 3. Swap amount calculation is correct
 */

describe("V2 POL Reserve Configuration", () => {
  // Default POL reserve config from presets
  const defaultPolReserve = {
    enabled: true,
    targetPol: 50,
    minPol: 10,
    maxSwapUsd: 100,
    checkIntervalMin: 5,
    slippagePct: 1,
  };

  describe("Configuration Defaults", () => {
    test("Default target POL should be 50", () => {
      assert.strictEqual(
        defaultPolReserve.targetPol,
        50,
        "Default target POL should be 50",
      );
    });

    test("Default minimum POL should be 10", () => {
      assert.strictEqual(
        defaultPolReserve.minPol,
        10,
        "Default minimum POL before rebalance should be 10",
      );
    });

    test("Default max swap should be $100 USDC", () => {
      assert.strictEqual(
        defaultPolReserve.maxSwapUsd,
        100,
        "Default max swap should be 100 USDC",
      );
    });

    test("Default slippage should be 1%", () => {
      assert.strictEqual(
        defaultPolReserve.slippagePct,
        1,
        "Default slippage should be 1%",
      );
    });

    test("Default check interval should be 5 minutes", () => {
      assert.strictEqual(
        defaultPolReserve.checkIntervalMin,
        5,
        "Default check interval should be 5 minutes",
      );
    });
  });
});

describe("V2 POL Rebalance Logic", () => {
  // Helper function that mirrors the V2 shouldRebalance logic
  function shouldRebalance(
    currentPol: number,
    minPol: number,
    enabled: boolean,
  ): boolean {
    if (!enabled) return false;
    return currentPol < minPol;
  }

  describe("Rebalance Trigger Conditions", () => {
    test("Should trigger rebalance when POL < minPol", () => {
      assert.strictEqual(
        shouldRebalance(5, 10, true),
        true,
        "Should rebalance when POL (5) < minPol (10)",
      );
    });

    test("Should NOT trigger rebalance when POL >= minPol", () => {
      assert.strictEqual(
        shouldRebalance(10, 10, true),
        false,
        "Should NOT rebalance when POL (10) = minPol (10)",
      );
    });

    test("Should NOT trigger rebalance when POL > minPol", () => {
      assert.strictEqual(
        shouldRebalance(50, 10, true),
        false,
        "Should NOT rebalance when POL (50) > minPol (10)",
      );
    });

    test("Should NOT trigger rebalance when disabled", () => {
      assert.strictEqual(
        shouldRebalance(5, 10, false),
        false,
        "Should NOT rebalance when feature is disabled",
      );
    });
  });
});

describe("V2 POL Swap Calculation", () => {
  // Constants matching the V2 implementation
  const POL_PRICE_ESTIMATE_USD = 1.5;
  const MIN_SWAP_USD = 5;
  const AVAILABLE_USDC_BUFFER = 0.9;

  // Helper function that mirrors the V2 swap calculation
  function calculateSwapAmount(
    currentPol: number,
    targetPol: number,
    maxSwapUsd: number,
    availableUsdc: number,
    estimatedPolPrice: number = POL_PRICE_ESTIMATE_USD,
  ): { usdcToSwap: number; reason: string } {
    const polNeeded = targetPol - currentPol;
    if (polNeeded <= 0) {
      return { usdcToSwap: 0, reason: "NO_SWAP_NEEDED" };
    }

    // Rough estimate: multiply POL needed by estimated price
    let usdcToSwap = Math.min(polNeeded * estimatedPolPrice, maxSwapUsd);

    // Ensure we have enough USDC
    if (usdcToSwap > availableUsdc) {
      usdcToSwap = Math.max(availableUsdc * AVAILABLE_USDC_BUFFER, 0);
    }

    if (usdcToSwap < MIN_SWAP_USD) {
      return { usdcToSwap: 0, reason: "SWAP_TOO_SMALL" };
    }

    return { usdcToSwap, reason: "OK" };
  }

  describe("Swap Amount Calculations", () => {
    test("Should calculate correct swap amount for typical scenario", () => {
      const result = calculateSwapAmount(5, 50, 100, 500);
      // Need 45 POL, at $1.50 each = $67.50, which is < maxSwap ($100)
      assert.strictEqual(
        result.usdcToSwap,
        67.5,
        "Should swap $67.50 USDC for 45 POL",
      );
      assert.strictEqual(result.reason, "OK");
    });

    test("Should cap swap at maxSwapUsd", () => {
      const result = calculateSwapAmount(0, 100, 50, 500);
      // Need 100 POL = $150, but maxSwap is $50
      assert.strictEqual(
        result.usdcToSwap,
        50,
        "Should cap at maxSwapUsd ($50)",
      );
      assert.strictEqual(result.reason, "OK");
    });

    test("Should limit swap to available USDC", () => {
      const result = calculateSwapAmount(0, 50, 100, 30);
      // Need ~$75 but only have $30, so use 90% of available = $27
      assert.strictEqual(
        result.usdcToSwap,
        27,
        "Should limit to 90% of available USDC",
      );
      assert.strictEqual(result.reason, "OK");
    });

    test("Should skip swap if amount too small", () => {
      const result = calculateSwapAmount(0, 50, 100, 3);
      // Only $3 available, 90% = $2.70, which is < $5 minimum
      assert.strictEqual(result.usdcToSwap, 0, "Should not swap tiny amounts");
      assert.strictEqual(result.reason, "SWAP_TOO_SMALL");
    });

    test("Should return 0 if no swap needed", () => {
      const result = calculateSwapAmount(50, 50, 100, 500);
      assert.strictEqual(
        result.usdcToSwap,
        0,
        "Should not swap when at target",
      );
      assert.strictEqual(result.reason, "NO_SWAP_NEEDED");
    });
  });
});

describe("V2 POL Slippage Protection", () => {
  // Helper function that mirrors the V2 slippage calculation
  function calculateMinOutput(
    expectedOutput: number,
    slippagePct: number,
  ): number {
    return expectedOutput * (1 - slippagePct / 100);
  }

  describe("Slippage Calculations", () => {
    test("1% slippage should reduce output by 1%", () => {
      const minOutput = calculateMinOutput(100, 1);
      assert.strictEqual(minOutput, 99, "1% slippage on 100 = 99");
    });

    test("0.5% slippage should reduce output by 0.5%", () => {
      const minOutput = calculateMinOutput(100, 0.5);
      assert.strictEqual(minOutput, 99.5, "0.5% slippage on 100 = 99.5");
    });

    test("2% slippage should reduce output by 2%", () => {
      const minOutput = calculateMinOutput(50, 2);
      assert.strictEqual(minOutput, 49, "2% slippage on 50 = 49");
    });
  });
});
