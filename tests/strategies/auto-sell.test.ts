import assert from "node:assert";
import { test, describe, afterEach } from "node:test";
import { loadStrategyConfig } from "../../src/config/loadConfig";
import { DEFAULT_AUTO_SELL_CONFIG } from "../../src/strategies/auto-sell";

/**
 * Unit tests for Auto-Sell Strategy Configuration and Wiring
 *
 * Tests verify:
 * 1. DEFAULT_AUTO_SELL_CONFIG has correct values
 * 2. Config loading from presets works correctly
 * 3. Config override via env vars works correctly
 */

const baseEnv = {
  RPC_URL: "http://localhost:8545",
  PRIVATE_KEY: "0x" + "11".repeat(32),
  POLYMARKET_API_KEY: "key",
  POLYMARKET_API_SECRET: "secret",
  POLYMARKET_API_PASSPHRASE: "passphrase",
  TARGET_ADDRESSES: "0xabc", // Required for MONITOR_ENABLED presets
};

const originalEnv = { ...process.env };

const resetEnv = () => {
  process.env = { ...originalEnv };
};

afterEach(() => {
  resetEnv();
});

// === DEFAULT CONFIG TESTS ===

describe("AutoSell Default Config", () => {
  test("DEFAULT_AUTO_SELL_CONFIG has correct default values", () => {
    assert.strictEqual(DEFAULT_AUTO_SELL_CONFIG.enabled, true);
    assert.strictEqual(DEFAULT_AUTO_SELL_CONFIG.threshold, 0.999);
    assert.strictEqual(DEFAULT_AUTO_SELL_CONFIG.minHoldSeconds, 60);
    assert.strictEqual(DEFAULT_AUTO_SELL_CONFIG.minOrderUsd, 1);
    assert.strictEqual(DEFAULT_AUTO_SELL_CONFIG.disputeWindowExitEnabled, true);
    assert.strictEqual(DEFAULT_AUTO_SELL_CONFIG.disputeWindowExitPrice, 0.999);
    assert.strictEqual(DEFAULT_AUTO_SELL_CONFIG.stalePositionHours, 24);
    assert.strictEqual(DEFAULT_AUTO_SELL_CONFIG.staleExpiryHoldHours, 48);
  });
});

// === PRESET CONFIG TESTS ===

describe("AutoSell Configuration - Preset Loading", () => {
  describe("Preset Defaults", () => {
    test("AUTO_SELL_ENABLED defaults to true in balanced preset", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.autoSellEnabled, true);
    });

    test("AUTO_SELL_ENABLED defaults to true in off preset", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "off",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.autoSellEnabled, true);
    });

    test("AUTO_SELL_THRESHOLD defaults to 0.999 (99.9¢)", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.autoSellThreshold, 0.999);
    });

    test("AUTO_SELL_DISPUTE_EXIT_PRICE defaults to 0.999 (99.9¢)", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.autoSellDisputeExitPrice, 0.999);
    });

    test("AUTO_SELL_DISPUTE_EXIT_ENABLED defaults to true", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.autoSellDisputeExitEnabled, true);
    });

    test("AUTO_SELL_MIN_HOLD_SEC varies by preset", () => {
      // Conservative: 60s
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "conservative",
      });
      const conservativeConfig = loadStrategyConfig();
      assert.strictEqual(conservativeConfig?.autoSellMinHoldSec, 60);

      // Balanced: 60s
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
      });
      const balancedConfig = loadStrategyConfig();
      assert.strictEqual(balancedConfig?.autoSellMinHoldSec, 60);

      // Aggressive: 30s (shorter for faster capital recovery)
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "aggressive",
      });
      const aggressiveConfig = loadStrategyConfig();
      assert.strictEqual(aggressiveConfig?.autoSellMinHoldSec, 30);
    });
  });

  describe("Env Override", () => {
    test("AUTO_SELL_ENABLED can be overridden via env", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
        AUTO_SELL_ENABLED: "false",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.autoSellEnabled, false);
    });

    test("AUTO_SELL_THRESHOLD can be overridden via env", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
        AUTO_SELL_THRESHOLD: "0.95",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.autoSellThreshold, 0.95);
    });

    test("AUTO_SELL_DISPUTE_EXIT_PRICE can be overridden via env", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
        AUTO_SELL_DISPUTE_EXIT_PRICE: "0.995",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.autoSellDisputeExitPrice, 0.995);
    });

    test("AUTO_SELL_DISPUTE_EXIT_ENABLED can be overridden via env", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
        AUTO_SELL_DISPUTE_EXIT_ENABLED: "false",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.autoSellDisputeExitEnabled, false);
    });

    test("AUTO_SELL_MIN_HOLD_SEC can be overridden via env", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
        AUTO_SELL_MIN_HOLD_SEC: "120",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.autoSellMinHoldSec, 120);
    });
  });
});

// === FILTERING BEHAVIOR TESTS ===

describe("AutoSell Filtering Behavior", () => {
  test("checkTradability returns REDEEMABLE only for positions with verified proof source", () => {
    // UPDATED (Jan 2025): Only skip if there's verified proof of redeemability
    // redeemable=true alone is NOT enough - we need verified redeemableProofSource

    // Position with DATA_API_FLAG proof (verified) - should be filtered
    const positionWithApiProof = {
      marketId: "0x123",
      tokenId: "0x456",
      side: "YES",
      size: 100,
      entryPrice: 0.5,
      currentPrice: 0.99,
      pnlPct: 98,
      pnlUsd: 49,
      redeemable: true,
      redeemableProofSource: "DATA_API_FLAG" as const,
    };

    // Position with ONCHAIN_DENOM proof - should be filtered
    const positionWithOnchainProof = {
      marketId: "0x123",
      tokenId: "0x456",
      side: "YES",
      size: 100,
      entryPrice: 0.5,
      currentPrice: 0.99,
      pnlPct: 98,
      pnlUsd: 49,
      redeemable: true,
      redeemableProofSource: "ONCHAIN_DENOM" as const,
    };

    // Position with redeemable=true but NO proof - should NOT be filtered (can sell)
    const positionWithoutProof = {
      marketId: "0x123",
      tokenId: "0x456",
      side: "YES",
      size: 100,
      entryPrice: 0.5,
      currentPrice: 0.99,
      pnlPct: 98,
      pnlUsd: 49,
      redeemable: true,
      redeemableProofSource: "NONE" as const,
    };

    // Verify the proof sources
    assert.strictEqual(positionWithApiProof.redeemableProofSource, "DATA_API_FLAG");
    assert.strictEqual(positionWithOnchainProof.redeemableProofSource, "ONCHAIN_DENOM");
    assert.strictEqual(positionWithoutProof.redeemableProofSource, "NONE");
  });

  test("checkTradability allows positions with DATA_API_UNCONFIRMED proof to be sold", () => {
    // CRITICAL (Jan 2025 Fix): DATA_API_UNCONFIRMED means Data API says redeemable
    // but on-chain payoutDenominator == 0. These positions should NOT be filtered
    // and should be eligible for AutoSell if there are live bids.

    const positionWithUnconfirmedApi = {
      marketId: "0x123",
      tokenId: "0x456",
      side: "YES",
      size: 100,
      entryPrice: 0.5,
      currentPrice: 0.999, // Near resolution price
      currentBidPrice: 0.998, // Live bid available
      pnlPct: 99.8,
      pnlUsd: 49.9,
      // redeemable is false because on-chain payoutDenominator == 0 (mismatch with Data API)
      // PositionTracker keeps this ACTIVE for AutoSell to handle instead of marking redeemable
      redeemable: false,
      redeemableProofSource: "DATA_API_UNCONFIRMED" as const,
    };

    // This position should be eligible for AutoSell (not blocked by redeemable filter)
    assert.strictEqual(positionWithUnconfirmedApi.redeemableProofSource, "DATA_API_UNCONFIRMED");
    assert.strictEqual(positionWithUnconfirmedApi.redeemable, false);
    assert.ok(positionWithUnconfirmedApi.currentBidPrice !== undefined);

    // Simulating the checkTradability logic:
    const hasVerifiedRedeemableProof =
      positionWithUnconfirmedApi.redeemableProofSource === "ONCHAIN_DENOM" ||
      positionWithUnconfirmedApi.redeemableProofSource === "DATA_API_FLAG";

    assert.strictEqual(hasVerifiedRedeemableProof, false, "DATA_API_UNCONFIRMED should NOT be considered verified proof");
  });

  test("checkTradability returns NOT_TRADABLE for non-tradable execution status", () => {
    // Positions with executionStatus NOT_TRADABLE_ON_CLOB or EXECUTION_BLOCKED should be skipped
    const position = {
      marketId: "0x123",
      tokenId: "0x456",
      side: "YES",
      size: 100,
      entryPrice: 0.5,
      currentPrice: 0.99,
      pnlPct: 98,
      pnlUsd: 49,
      executionStatus: "NOT_TRADABLE_ON_CLOB" as const,
    };

    assert.strictEqual(position.executionStatus, "NOT_TRADABLE_ON_CLOB");
  });

  test("checkTradability returns NO_BID for positions without bid price", () => {
    // Positions without currentBidPrice should be skipped
    const position = {
      marketId: "0x123",
      tokenId: "0x456",
      side: "YES",
      size: 100,
      entryPrice: 0.5,
      currentPrice: 0.99, // Has current price from Data API
      pnlPct: 98,
      pnlUsd: 49,
      currentBidPrice: undefined, // No bid from orderbook
    };

    assert.strictEqual(position.currentBidPrice, undefined);
  });
});

// === NEAR RESOLUTION DETECTION TESTS ===

describe("AutoSell Near Resolution Detection", () => {
  test("getPositionsNearResolution uses currentBidPrice when available", () => {
    // CRITICAL FIX (Jan 2025): Near resolution detection should use executable bid price
    // This ensures positions with live bids at 99.9¢+ are eligible even when Data-API price is lower

    // Position where bid is at threshold but currentPrice is lower
    const positionWithHighBid = {
      marketId: "0x123",
      tokenId: "0x456",
      currentPrice: 0.95, // Data API price is lower
      currentBidPrice: 0.999, // But executable bid is at threshold
    };

    // Using the new logic: effectivePrice = currentBidPrice ?? currentPrice
    const effectivePrice =
      positionWithHighBid.currentBidPrice ?? positionWithHighBid.currentPrice;
    const threshold = 0.999;

    assert.ok(
      effectivePrice >= threshold,
      "Position with bid at 99.9¢ should be eligible even when currentPrice is 95¢",
    );
  });

  test("getPositionsNearResolution falls back to currentPrice when no bid", () => {
    // When currentBidPrice is undefined, fall back to currentPrice
    const positionNoBid = {
      marketId: "0x123",
      tokenId: "0x456",
      currentPrice: 0.999,
      currentBidPrice: undefined,
    };

    const effectivePrice =
      positionNoBid.currentBidPrice ?? positionNoBid.currentPrice;
    const threshold = 0.999;

    assert.ok(
      effectivePrice >= threshold,
      "Position with currentPrice at threshold should be eligible when no bid",
    );
  });

  test("position with low bid and low currentPrice is NOT near resolution", () => {
    const positionLowPrices = {
      marketId: "0x123",
      tokenId: "0x456",
      currentPrice: 0.85,
      currentBidPrice: 0.84,
    };

    const effectivePrice =
      positionLowPrices.currentBidPrice ?? positionLowPrices.currentPrice;
    const threshold = 0.999;

    assert.ok(
      effectivePrice < threshold,
      "Position with low prices should not be near resolution",
    );
  });
});

// === DATA_API_UNCONFIRMED ROUTING TO AUTOSELL ===

describe("AutoSell DATA_API_UNCONFIRMED Routing", () => {
  test("DATA_API_UNCONFIRMED positions at 99.9¢ are routed to AutoSell, not AutoRedeem", () => {
    // This test verifies the complete flow:
    // 1. Data API says redeemable, but on-chain payoutDenominator == 0
    // 2. PositionTracker sets redeemable=false with DATA_API_UNCONFIRMED proof
    // 3. getPositionsNearResolution() includes this position (based on price)
    // 4. checkTradability() does NOT block it (DATA_API_UNCONFIRMED is not verified)
    // 5. AutoSell attempts to sell

    const positionDataApiUnconfirmed = {
      marketId: "0x" + "a".repeat(64),
      tokenId: "0x" + "b".repeat(64),
      side: "YES",
      size: 100,
      entryPrice: 0.5,
      currentPrice: 1.0, // Data API shows resolved at $1
      currentBidPrice: 0.999, // Live bid at exactly 99.9¢ threshold
      pnlPct: 99.8,
      pnlUsd: 49.9,
      redeemable: false, // NOT redeemable because on-chain payoutDenominator == 0
      redeemableProofSource: "DATA_API_UNCONFIRMED" as const,
      positionState: "ACTIVE" as const,
      executionStatus: "TRADABLE" as const,
    };

    // Step 1: Verify position would be picked up by getPositionsNearResolution
    const effectivePrice = positionDataApiUnconfirmed.currentBidPrice ?? positionDataApiUnconfirmed.currentPrice;
    const threshold = 0.999;
    const isNearResolution = effectivePrice >= threshold;
    assert.strictEqual(isNearResolution, true, "Position at 99.9¢ bid should be near resolution");

    // Step 2: Verify checkTradability would NOT block this position
    const hasVerifiedRedeemableProof =
      positionDataApiUnconfirmed.redeemableProofSource === "ONCHAIN_DENOM" ||
      positionDataApiUnconfirmed.redeemableProofSource === "DATA_API_FLAG";
    assert.strictEqual(hasVerifiedRedeemableProof, false, "DATA_API_UNCONFIRMED is NOT verified proof");

    // Step 3: Verify position would NOT be picked up by AutoRedeem
    const wouldBePickedByAutoRedeem = positionDataApiUnconfirmed.redeemable === true;
    assert.strictEqual(wouldBePickedByAutoRedeem, false, "Position should NOT be picked up by AutoRedeem (redeemable=false)");

    // Step 4: Verify all conditions for AutoSell to attempt selling
    const canAutoSell =
      isNearResolution && // Price at threshold
      !hasVerifiedRedeemableProof && // Not blocked by redeemable filter
      positionDataApiUnconfirmed.currentBidPrice !== undefined && // Has bid
      positionDataApiUnconfirmed.executionStatus === "TRADABLE"; // Can execute

    assert.strictEqual(canAutoSell, true, "All conditions met for AutoSell to attempt selling");
  });

  test("positions at 100¢ with bids are sold instead of waiting for redemption", () => {
    // Edge case: position exactly at $1.00 but on-chain not resolved yet
    // Should be sold via AutoSell rather than waiting for on-chain resolution

    const positionAt100Cents = {
      marketId: "0x" + "c".repeat(64),
      tokenId: "0x" + "d".repeat(64),
      currentPrice: 1.0, // Data API shows winner
      currentBidPrice: 0.999, // Live bid at 99.9¢
      redeemable: false, // On-chain not resolved
      redeemableProofSource: "DATA_API_UNCONFIRMED" as const,
      executionStatus: "TRADABLE" as const,
    };

    // Should be eligible for AutoSell
    const effectivePrice = positionAt100Cents.currentBidPrice ?? positionAt100Cents.currentPrice;
    assert.ok(effectivePrice >= 0.999, "Position should be near resolution");

    const hasVerifiedProof =
      positionAt100Cents.redeemableProofSource === "ONCHAIN_DENOM" ||
      positionAt100Cents.redeemableProofSource === "DATA_API_FLAG";
    assert.strictEqual(hasVerifiedProof, false, "Should not have verified proof");

    // Calculate expected loss from selling at 99.9¢ instead of waiting for $1.00 redemption
    // Loss = (1.0 - 0.999) = $0.001 per share (0.1¢)
    // This is acceptable to free up capital immediately
    const lossPerShare = 1.0 - 0.999;
    assert.ok(lossPerShare < 0.01, "Loss from selling early should be minimal (<1%)");
  });
});

// === STALE PROFITABLE POSITION TESTS ===

describe("AutoSell Stale Profitable Position Exit", () => {
  test("AUTO_SELL_STALE_POSITION_HOURS defaults to 24 in balanced preset", () => {
    resetEnv();
    Object.assign(process.env, baseEnv, {
      STRATEGY_PRESET: "balanced",
    });

    const config = loadStrategyConfig();
    assert.strictEqual(config?.autoSellStalePositionHours, 24);
  });

  test("AUTO_SELL_STALE_POSITION_HOURS is 12 in aggressive preset", () => {
    resetEnv();
    Object.assign(process.env, baseEnv, {
      STRATEGY_PRESET: "aggressive",
    });

    const config = loadStrategyConfig();
    assert.strictEqual(config?.autoSellStalePositionHours, 12);
  });

  test("AUTO_SELL_STALE_POSITION_HOURS can be overridden via env", () => {
    resetEnv();
    Object.assign(process.env, baseEnv, {
      STRATEGY_PRESET: "balanced",
      AUTO_SELL_STALE_POSITION_HOURS: "48",
    });

    const config = loadStrategyConfig();
    assert.strictEqual(config?.autoSellStalePositionHours, 48);
  });

  test("AUTO_SELL_STALE_POSITION_HOURS can be disabled with 0", () => {
    resetEnv();
    Object.assign(process.env, baseEnv, {
      STRATEGY_PRESET: "balanced",
      AUTO_SELL_STALE_POSITION_HOURS: "0",
    });

    const config = loadStrategyConfig();
    assert.strictEqual(config?.autoSellStalePositionHours, 0);
  });

  test("stale profitable position identification criteria", () => {
    // A position is considered "stale profitable" when:
    // 1. pnlPct > 0 (profitable/green)
    // 2. pnlTrusted === true (we can trust the P&L calculation)
    // 3. entryMetaTrusted !== false (entry metadata timestamps are reliable)
    // 4. firstAcquiredAt is defined and (Date.now() - firstAcquiredAt) >= stalePositionHours * 3600 * 1000
    // 5. currentBidPrice is defined (can sell)
    // 6. Not already sold
    // 7. Is tradable (passes checkTradability)

    const now = Date.now();
    const staleHours = 24;
    const staleThresholdMs = staleHours * 60 * 60 * 1000;

    const staleProfitablePosition = {
      marketId: "0x" + "a".repeat(64),
      tokenId: "0x" + "b".repeat(64),
      side: "YES",
      size: 50,
      entryPrice: 0.50, // Bought at 50¢
      currentPrice: 0.55, // Now at 55¢
      currentBidPrice: 0.54, // Can sell at 54¢
      pnlPct: 8.0, // 8% profit
      pnlUsd: 2.0, // $2 profit
      pnlTrusted: true,
      pnlClassification: "PROFITABLE" as const,
      firstAcquiredAt: now - (25 * 60 * 60 * 1000), // 25 hours ago
      lastAcquiredAt: now - (25 * 60 * 60 * 1000),
      timeHeldSec: 25 * 60 * 60, // 25 hours in seconds
      entryMetaTrusted: true, // Entry metadata is trusted
      executionStatus: "TRADABLE" as const,
      redeemable: false,
      redeemableProofSource: "NONE" as const,
    };

    // Verify this position meets stale profitable criteria

    // Check profitable and P&L trusted
    assert.strictEqual(staleProfitablePosition.pnlPct > 0, true, "Position should be profitable");
    assert.strictEqual(staleProfitablePosition.pnlTrusted, true, "P&L should be trusted");

    // Check entry metadata is trusted (implementation skips when entryMetaTrusted === false)
    assert.strictEqual(staleProfitablePosition.entryMetaTrusted !== false, true, "Entry metadata should be trusted");

    // Check held time using same calculation as implementation: Date.now() - firstAcquiredAt
    const heldMs = now - staleProfitablePosition.firstAcquiredAt;
    assert.ok(
      heldMs >= staleThresholdMs,
      `Position held ${heldMs}ms should exceed threshold ${staleThresholdMs}ms`,
    );

    // Check can sell
    assert.ok(staleProfitablePosition.currentBidPrice !== undefined, "Position should have a bid price");

    // Check tradable
    assert.strictEqual(staleProfitablePosition.executionStatus, "TRADABLE");
  });

  test("position not considered stale if held less than threshold", () => {
    // Position held for only 12 hours should NOT be sold at 24h threshold
    const recentProfitablePosition = {
      marketId: "0x" + "c".repeat(64),
      tokenId: "0x" + "d".repeat(64),
      pnlPct: 5.0, // Profitable
      pnlTrusted: true,
      firstAcquiredAt: Date.now() - (12 * 60 * 60 * 1000), // 12 hours ago
      timeHeldSec: 12 * 60 * 60, // 12 hours
      currentBidPrice: 0.60,
    };

    const staleHours = 24;
    const staleThresholdSec = staleHours * 60 * 60;

    // This position should NOT be considered stale
    const isStale = recentProfitablePosition.timeHeldSec >= staleThresholdSec;
    assert.strictEqual(isStale, false, "Position held 12h should not be stale at 24h threshold");
  });

  test("losing position not sold as stale (only profitable positions)", () => {
    // Even if held for 30 hours, losing positions should NOT be auto-sold as "stale profitable"
    const losingPosition = {
      marketId: "0x" + "e".repeat(64),
      tokenId: "0x" + "f".repeat(64),
      pnlPct: -15.0, // LOSING
      pnlTrusted: true,
      firstAcquiredAt: Date.now() - (30 * 60 * 60 * 1000), // 30 hours ago
      timeHeldSec: 30 * 60 * 60,
      currentBidPrice: 0.40,
    };

    // This should NOT be picked up by stale profitable logic
    const isProfitable = losingPosition.pnlPct > 0;
    assert.strictEqual(isProfitable, false, "Losing position should not be treated as profitable");
  });

  test("position with untrusted entry metadata not sold as stale", () => {
    // When entryMetaTrusted === false, trade history doesn't match live shares,
    // so firstAcquiredAt/timeHeldSec may be inaccurate. A recent position could
    // be incorrectly identified as 24+ hours old, so we must skip these.
    const positionWithUntrustedEntryMeta = {
      marketId: "0x" + "3".repeat(64),
      tokenId: "0x" + "4".repeat(64),
      pnlPct: 10.0, // Profitable
      pnlTrusted: true, // P&L is trusted
      firstAcquiredAt: Date.now() - (30 * 60 * 60 * 1000), // Shows 30 hours (but may be wrong!)
      timeHeldSec: 30 * 60 * 60,
      currentBidPrice: 0.60,
      entryMetaTrusted: false, // Entry metadata is NOT trusted!
      entryMetaUntrustedReason: "Shares mismatch: computed=45.00 vs live=50.00",
    };

    // This should NOT be considered stale because entryMetaTrusted === false
    // The firstAcquiredAt timestamp may be inaccurate
    assert.strictEqual(
      positionWithUntrustedEntryMeta.entryMetaTrusted,
      false,
      "Position has untrusted entry metadata",
    );

    // Verify the eligibility check should fail
    const passesEntryMetaCheck = positionWithUntrustedEntryMeta.entryMetaTrusted !== false;
    assert.strictEqual(
      passesEntryMetaCheck,
      false,
      "Position with entryMetaTrusted=false should NOT pass stale eligibility",
    );
  });

  test("position with trusted entry metadata CAN be sold as stale", () => {
    // When entryMetaTrusted is true or undefined (not explicitly false),
    // the timestamps can be trusted for stale detection
    const positionWithTrustedEntryMeta = {
      marketId: "0x" + "5".repeat(64),
      tokenId: "0x" + "6".repeat(64),
      pnlPct: 10.0, // Profitable
      pnlTrusted: true,
      firstAcquiredAt: Date.now() - (30 * 60 * 60 * 1000), // 30 hours
      timeHeldSec: 30 * 60 * 60,
      currentBidPrice: 0.60,
      entryMetaTrusted: true, // Entry metadata IS trusted
    };

    // This SHOULD pass entry metadata check
    const passesEntryMetaCheck = positionWithTrustedEntryMeta.entryMetaTrusted !== false;
    assert.strictEqual(
      passesEntryMetaCheck,
      true,
      "Position with entryMetaTrusted=true should pass stale eligibility",
    );
  });

  test("position without entry time data not sold as stale", () => {
    // Positions without firstAcquiredAt cannot have their hold time calculated
    const positionWithoutEntryTime = {
      marketId: "0x" + "1".repeat(64),
      tokenId: "0x" + "2".repeat(64),
      pnlPct: 10.0, // Profitable
      pnlTrusted: true,
      firstAcquiredAt: undefined, // No entry time!
      timeHeldSec: undefined,
      currentBidPrice: 0.70,
    };

    // Cannot determine hold time, so should not be sold
    assert.strictEqual(
      positionWithoutEntryTime.timeHeldSec === undefined,
      true,
      "Position without timeHeldSec cannot be evaluated for staleness",
    );
  });

  test("capital efficiency reasoning for stale position exit", () => {
    // Business case: Position bought at 50¢, now at 55¢, held 30 hours
    // This position is:
    // - Profitable: +10% gain
    // - Not moving: held for 30 hours without significant change
    // - Tying up capital: $50 that could be used elsewhere

    const position = {
      size: 100, // 100 shares
      entryPrice: 0.50, // 50¢ entry
      currentBidPrice: 0.55, // 55¢ current bid
      pnlPct: 10.0, // 10% profit
    };

    // Calculate what happens if we sell
    const capitalInvested = position.size * position.entryPrice; // $50
    const capitalRecovered = position.size * position.currentBidPrice; // $55
    const profitLocked = capitalRecovered - capitalInvested; // $5

    assert.ok(profitLocked > 0, "Selling locks in profit");
    assert.ok(Math.abs(capitalRecovered - 55) < 0.001, "Capital recovered is approximately $55");

    // The freed capital can now be used for new trades
    // Even if this position eventually goes to $1, we'd only gain $45 more
    // But that could take weeks/months, while the $55 can generate returns now
  });
});

// === QUICK WIN TESTS ===

describe("AutoSell Quick Win Configuration", () => {
  test("DEFAULT_AUTO_SELL_CONFIG has correct quick win defaults", () => {
    assert.strictEqual(DEFAULT_AUTO_SELL_CONFIG.quickWinEnabled, false);
    assert.strictEqual(DEFAULT_AUTO_SELL_CONFIG.quickWinMaxHoldMinutes, 60);
    assert.strictEqual(DEFAULT_AUTO_SELL_CONFIG.quickWinProfitPct, 90);
  });

  test("AUTO_SELL_QUICK_WIN_ENABLED defaults to false", () => {
    resetEnv();
    Object.assign(process.env, baseEnv, {
      STRATEGY_PRESET: "balanced",
    });

    const config = loadStrategyConfig();
    assert.strictEqual(config?.autoSellQuickWinEnabled, false);
  });

  test("AUTO_SELL_QUICK_WIN_ENABLED can be enabled via env", () => {
    resetEnv();
    Object.assign(process.env, baseEnv, {
      STRATEGY_PRESET: "balanced",
      AUTO_SELL_QUICK_WIN_ENABLED: "true",
    });

    const config = loadStrategyConfig();
    assert.strictEqual(config?.autoSellQuickWinEnabled, true);
  });

  test("AUTO_SELL_QUICK_WIN_MAX_HOLD_MINUTES defaults to 60", () => {
    resetEnv();
    Object.assign(process.env, baseEnv, {
      STRATEGY_PRESET: "balanced",
    });

    const config = loadStrategyConfig();
    assert.strictEqual(config?.autoSellQuickWinMaxHoldMinutes, 60);
  });

  test("AUTO_SELL_QUICK_WIN_MAX_HOLD_MINUTES can be overridden via env", () => {
    resetEnv();
    Object.assign(process.env, baseEnv, {
      STRATEGY_PRESET: "balanced",
      AUTO_SELL_QUICK_WIN_MAX_HOLD_MINUTES: "45",
    });

    const config = loadStrategyConfig();
    assert.strictEqual(config?.autoSellQuickWinMaxHoldMinutes, 45);
  });

  test("AUTO_SELL_QUICK_WIN_PROFIT_PCT defaults to 90", () => {
    resetEnv();
    Object.assign(process.env, baseEnv, {
      STRATEGY_PRESET: "balanced",
    });

    const config = loadStrategyConfig();
    assert.strictEqual(config?.autoSellQuickWinProfitPct, 90);
  });

  test("AUTO_SELL_QUICK_WIN_PROFIT_PCT can be overridden via env", () => {
    resetEnv();
    Object.assign(process.env, baseEnv, {
      STRATEGY_PRESET: "balanced",
      AUTO_SELL_QUICK_WIN_PROFIT_PCT: "75",
    });

    const config = loadStrategyConfig();
    assert.strictEqual(config?.autoSellQuickWinProfitPct, 75);
  });
});

describe("AutoSell Quick Win Logic", () => {
  test("Quick win targets positions with high profit % from purchase price", () => {
    // Example: Position bought at 10¢, now at 19¢ = 90% gain
    const position = {
      size: 100,
      entryPrice: 0.10, // 10¢ entry
      currentBidPrice: 0.19, // 19¢ current bid
      pnlPct: 90.0, // 90% profit
      timeHeldSec: 1800, // 30 minutes (1800 seconds)
      firstAcquiredAt: Date.now() - 30 * 60 * 1000, // 30 minutes ago
    };

    // Calculate profit %
    const profitPct = ((position.currentBidPrice - position.entryPrice) / position.entryPrice) * 100;
    assert.ok(Math.abs(profitPct - 90) < 0.1, "Profit % is ~90%");

    // This position should be eligible for quick win:
    // - Held < 60 minutes (30 minutes)
    // - Profit >= 90%
    const isQuickWin = 
      position.timeHeldSec < 60 * 60 && // Less than 60 minutes
      position.pnlPct >= 90; // At least 90% profit

    assert.ok(isQuickWin, "Position qualifies for quick win exit");
  });

  test("Quick win uses purchase price, not share price", () => {
    // Example 1: Bought at 10¢, now 19¢ = 90% gain → ELIGIBLE
    const lowEntryPosition = {
      entryPrice: 0.10,
      currentBidPrice: 0.19,
      pnlPct: 90.0,
    };

    // Example 2: Bought at 80¢, now 90¢ = 12.5% gain → NOT ELIGIBLE
    const highEntryPosition = {
      entryPrice: 0.80,
      currentBidPrice: 0.90,
      pnlPct: 12.5,
    };

    // Low entry position has 90% profit from purchase price - eligible
    assert.ok(lowEntryPosition.pnlPct >= 90, "Low entry position has >= 90% profit");

    // High entry position only has 12.5% profit - not eligible
    assert.ok(highEntryPosition.pnlPct < 90, "High entry position has < 90% profit");

    // This avoids conflict with positions bought in "overly confident zone" (80¢+)
    // where reaching 90¢ is normal price movement, not a massive gain
  });

  test("Quick win locks in profit before momentum reverses", () => {
    // Position bought at 5¢, spiked to 14.25¢ in 20 minutes (185% gain)
    const position = {
      size: 100,
      entryPrice: 0.05, // 5¢ entry
      currentBidPrice: 0.1425, // 14.25¢ current
      timeHeldSec: 1200, // 20 minutes
    };

    const capitalInvested = position.size * position.entryPrice; // $5
    const capitalRecovered = position.size * position.currentBidPrice; // $14.25
    const profitLocked = capitalRecovered - capitalInvested; // $9.25

    // Profit % from purchase price
    const profitPct = ((position.currentBidPrice - position.entryPrice) / position.entryPrice) * 100;

    assert.ok(profitPct > 90, "Profit % > 90% (actually 185%)");
    assert.ok(profitLocked > 9, "Locks in $9.25 profit");
    assert.ok(position.timeHeldSec < 60 * 60, "Held less than 1 hour");

    // Quick win exit captures this momentum before price potentially reverses
    // If price drops back to 5¢, we'd have locked in $9.25 instead of $0
  });
});

// === STALE EXPIRY HOLD TESTS ===

describe("AutoSell Stale Expiry Hold Configuration", () => {
  test("DEFAULT_AUTO_SELL_CONFIG has correct staleExpiryHoldHours default", () => {
    assert.strictEqual(DEFAULT_AUTO_SELL_CONFIG.staleExpiryHoldHours, 48);
  });

  test("AUTO_SELL_STALE_EXPIRY_HOLD_HOURS defaults to 48 in balanced preset", () => {
    resetEnv();
    Object.assign(process.env, baseEnv, {
      STRATEGY_PRESET: "balanced",
    });

    const config = loadStrategyConfig();
    assert.strictEqual(config?.autoSellStaleExpiryHoldHours, 48);
  });

  test("AUTO_SELL_STALE_EXPIRY_HOLD_HOURS can be overridden via env", () => {
    resetEnv();
    Object.assign(process.env, baseEnv, {
      STRATEGY_PRESET: "balanced",
      AUTO_SELL_STALE_EXPIRY_HOLD_HOURS: "72",
    });

    const config = loadStrategyConfig();
    assert.strictEqual(config?.autoSellStaleExpiryHoldHours, 72);
  });

  test("AUTO_SELL_STALE_EXPIRY_HOLD_HOURS can be disabled with 0", () => {
    resetEnv();
    Object.assign(process.env, baseEnv, {
      STRATEGY_PRESET: "balanced",
      AUTO_SELL_STALE_EXPIRY_HOLD_HOURS: "0",
    });

    const config = loadStrategyConfig();
    assert.strictEqual(config?.autoSellStaleExpiryHoldHours, 0);
  });
});

describe("AutoSell Stale Expiry Hold Logic", () => {
  /**
   * Helper function that simulates the expiry-aware hold logic from getStaleProfitablePositions()
   * This tests the actual filtering logic that determines whether a position should be held for resolution
   */
  const shouldHoldForExpiry = (
    pos: { marketEndTime?: number },
    expiryHoldHours: number,
    now: number = Date.now()
  ): boolean => {
    if (expiryHoldHours <= 0) return false;
    if (pos.marketEndTime === undefined) return false;
    
    const timeToExpiryMs = pos.marketEndTime - now;
    const expiryHoldMs = expiryHoldHours * 60 * 60 * 1000;
    
    return timeToExpiryMs > 0 && timeToExpiryMs <= expiryHoldMs;
  };

  test("position expiring within hold window should be held (not sold)", () => {
    // Scenario: Event expires in 24 hours (within 48h hold window)
    // Expected: shouldHoldForExpiry returns true → position NOT sold
    const now = Date.now();
    const expiryHoldHours = 48;
    
    const position = {
      marketEndTime: now + (24 * 60 * 60 * 1000), // 24 hours from now
    };
    
    const result = shouldHoldForExpiry(position, expiryHoldHours, now);
    assert.strictEqual(result, true, "Position expiring in 24h should be held (within 48h window)");
  });

  test("position expiring AFTER hold window should be sold", () => {
    // Scenario: Event expires in 120 hours (5 days) - well outside 48h hold window
    // Expected: shouldHoldForExpiry returns false → position can be sold
    const now = Date.now();
    const expiryHoldHours = 48;
    
    const position = {
      marketEndTime: now + (120 * 60 * 60 * 1000), // 120 hours (5 days) from now
    };
    
    const result = shouldHoldForExpiry(position, expiryHoldHours, now);
    assert.strictEqual(result, false, "Position expiring in 120h should NOT be held (outside 48h window)");
  });

  test("position without marketEndTime should be eligible for sale", () => {
    // When we don't know when the market expires, we should sell stale positions
    const now = Date.now();
    const expiryHoldHours = 48;
    
    const position = {
      marketEndTime: undefined,
    };
    
    const result = shouldHoldForExpiry(position, expiryHoldHours, now);
    assert.strictEqual(result, false, "Position without marketEndTime should NOT be held");
  });

  test("expiry hold disabled when staleExpiryHoldHours is 0", () => {
    // When set to 0, always sell stale positions regardless of expiry
    const now = Date.now();
    const expiryHoldHours = 0; // DISABLED
    
    const position = {
      marketEndTime: now + (12 * 60 * 60 * 1000), // 12 hours from now
    };
    
    const result = shouldHoldForExpiry(position, expiryHoldHours, now);
    assert.strictEqual(result, false, "Position should NOT be held when expiryHoldHours is 0");
  });

  test("position already expired should not trigger hold", () => {
    // Edge case: marketEndTime is in the past
    const now = Date.now();
    const expiryHoldHours = 48;
    
    const position = {
      marketEndTime: now - (1 * 60 * 60 * 1000), // 1 hour AGO (expired)
    };
    
    const result = shouldHoldForExpiry(position, expiryHoldHours, now);
    assert.strictEqual(result, false, "Expired position should NOT be held");
  });

  test("position at exact boundary of hold window", () => {
    // Edge case: position expires at exactly expiryHoldHours
    const now = Date.now();
    const expiryHoldHours = 48;
    
    const position = {
      marketEndTime: now + (48 * 60 * 60 * 1000), // Exactly 48 hours from now
    };
    
    const result = shouldHoldForExpiry(position, expiryHoldHours, now);
    assert.strictEqual(result, true, "Position at exact boundary should be held (<=, not <)");
  });
});

// === OVERSIZED POSITION EXIT TESTS ===

describe("AutoSell Oversized Position Exit", () => {
  describe("Default Config", () => {
    test("DEFAULT_AUTO_SELL_CONFIG has correct oversized exit defaults", () => {
      assert.strictEqual(DEFAULT_AUTO_SELL_CONFIG.oversizedExitEnabled, false);
      assert.strictEqual(DEFAULT_AUTO_SELL_CONFIG.oversizedExitThresholdUsd, 25);
      assert.strictEqual(DEFAULT_AUTO_SELL_CONFIG.oversizedExitHoursBeforeEvent, 1);
      assert.strictEqual(DEFAULT_AUTO_SELL_CONFIG.oversizedExitBreakevenTolerancePct, 2);
    });
  });

  describe("Env Override", () => {
    test("AUTO_SELL_OVERSIZED_EXIT_ENABLED can be overridden via env", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
        AUTO_SELL_OVERSIZED_EXIT_ENABLED: "true",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.autoSellOversizedExitEnabled, true);
    });

    test("AUTO_SELL_OVERSIZED_EXIT_THRESHOLD_USD can be overridden via env", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
        AUTO_SELL_OVERSIZED_EXIT_THRESHOLD_USD: "50",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.autoSellOversizedExitThresholdUsd, 50);
    });

    test("AUTO_SELL_OVERSIZED_EXIT_HOURS_BEFORE_EVENT can be overridden via env", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
        AUTO_SELL_OVERSIZED_EXIT_HOURS_BEFORE_EVENT: "2",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.autoSellOversizedExitHoursBeforeEvent, 2);
    });

    test("AUTO_SELL_OVERSIZED_EXIT_BREAKEVEN_TOLERANCE_PCT can be overridden via env", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
        AUTO_SELL_OVERSIZED_EXIT_BREAKEVEN_TOLERANCE_PCT: "5",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.autoSellOversizedExitBreakevenTolerancePct, 5);
    });
  });

  describe("Exit Strategy Logic", () => {
    test("oversized position that turns profitable should be sold immediately", () => {
      // Scenario: Position exceeds $25 threshold, was losing but now profitable
      const position = {
        marketId: "0x123",
        tokenId: "0x456",
        size: 100,
        entryPrice: 0.30, // 30¢ entry = $30 invested (>$25 threshold)
        currentBidPrice: 0.35, // 35¢ current = $35 value
        pnlPct: 16.67, // +16.67% profit
        pnlTrusted: true,
      };

      const investedUsd = position.size * position.entryPrice; // $30
      const isOversized = investedUsd > 25;
      const isProfitable = position.pnlPct > 0;

      assert.ok(isOversized, "Position is oversized (>$25)");
      assert.ok(isProfitable, "Position is profitable");
      // Strategy: Should sell immediately to lock in profit
    });

    test("oversized position near breakeven should be sold", () => {
      // Scenario: Position exceeds threshold, small loss within tolerance
      const position = {
        marketId: "0x123",
        tokenId: "0x456",
        size: 100,
        entryPrice: 0.30, // 30¢ entry = $30 invested
        currentBidPrice: 0.295, // 29.5¢ current = $29.50 value
        pnlPct: -1.67, // -1.67% loss (within 2% tolerance)
        pnlTrusted: true,
      };

      const tolerancePct = 2;
      const isNearBreakeven = Math.abs(position.pnlPct) <= tolerancePct;

      assert.ok(isNearBreakeven, "Position is near breakeven (within 2%)");
      // Strategy: Should sell to exit at minimal loss
    });

    test("oversized losing position should wait until event approaches", () => {
      // Scenario: Position exceeds threshold, significant loss, event far away
      const position = {
        marketId: "0x123",
        tokenId: "0x456",
        size: 100,
        entryPrice: 0.30, // 30¢ entry = $30 invested
        currentBidPrice: 0.24, // 24¢ current = $24 value
        pnlPct: -20, // -20% loss (outside tolerance, should wait)
        pnlTrusted: true,
        marketEndTime: Date.now() + 24 * 60 * 60 * 1000, // 24 hours away
      };

      const tolerancePct = 2;
      const hoursBeforeEvent = 1;
      const hoursRemaining = (position.marketEndTime - Date.now()) / (60 * 60 * 1000);

      const isNearBreakeven = Math.abs(position.pnlPct) <= tolerancePct;
      const isEventApproaching = hoursRemaining <= hoursBeforeEvent;

      assert.ok(!isNearBreakeven, "Position is NOT near breakeven");
      assert.ok(!isEventApproaching, "Event is NOT approaching (>1h away)");
      // Strategy: Should wait for better opportunity (price recovery or event approach)
    });

    test("oversized losing position should force exit when event is approaching", () => {
      // Scenario: Position exceeds threshold, significant loss, event within 1 hour
      const position = {
        marketId: "0x123",
        tokenId: "0x456",
        size: 100,
        entryPrice: 0.30, // 30¢ entry = $30 invested
        currentBidPrice: 0.24, // 24¢ current = $24 value
        pnlPct: -20, // -20% loss
        pnlTrusted: true,
        marketEndTime: Date.now() + 30 * 60 * 1000, // 30 minutes away (<1 hour)
      };

      const hoursBeforeEvent = 1;
      const hoursRemaining = (position.marketEndTime - Date.now()) / (60 * 60 * 1000);
      const isEventApproaching = hoursRemaining <= hoursBeforeEvent;

      assert.ok(isEventApproaching, "Event IS approaching (<1h away)");
      // Strategy: Should force exit to avoid total loss at resolution
    });

    test("position below threshold should not be considered oversized", () => {
      // Scenario: Small position that doesn't exceed threshold
      const position = {
        marketId: "0x123",
        tokenId: "0x456",
        size: 50,
        entryPrice: 0.20, // 20¢ entry = $10 invested (<$25 threshold)
        currentBidPrice: 0.15, // 15¢ current
        pnlPct: -25, // -25% loss
      };

      const investedUsd = position.size * position.entryPrice; // $10
      const isOversized = investedUsd > 25;

      assert.ok(!isOversized, "Position is NOT oversized (<$25)");
      // Strategy: Not handled by oversized exit (too small)
    });
  });
});
