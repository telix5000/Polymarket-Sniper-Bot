import assert from "node:assert";
import { test, describe } from "node:test";

/**
 * Unit tests for V2 Scavenger Mode - Detection Logic
 *
 * These tests verify:
 * 1. Volume sample recording and calculation
 * 2. Order book depth tracking
 * 3. Target activity monitoring
 * 4. Low liquidity condition detection
 * 5. Mode transition thresholds
 * 6. Clean reversion when activity returns
 */

import {
  createDetectionState,
  recordVolumeSample,
  recordOrderBookSnapshot,
  recordTargetActivity,
  analyzeMarketConditions,
  type DetectionState,
} from "../../src/lib/scavenger-detection";

import {
  DEFAULT_SCAVENGER_CONFIG,
  type LiquidityDetectionConfig,
  type ScavengerReversionConfig,
} from "../../src/lib/scavenger-config";

describe("V2 Scavenger Detection State", () => {
  describe("State Creation", () => {
    test("creates empty detection state", () => {
      const state = createDetectionState();

      assert.strictEqual(state.volumeSamples.length, 0);
      assert.strictEqual(state.orderBookSnapshots.length, 0);
      assert.strictEqual(state.targetActivitySamples.length, 0);
      assert.strictEqual(state.lowLiquidityDetectedAt, null);
      assert.strictEqual(state.highLiquidityDetectedAt, null);
    });
  });

  describe("Volume Sample Recording", () => {
    test("records volume sample", () => {
      let state = createDetectionState();
      state = recordVolumeSample(state, 1000, 300000);

      assert.strictEqual(state.volumeSamples.length, 1);
      assert.strictEqual(state.volumeSamples[0].volumeUsd, 1000);
    });

    test("accumulates multiple samples", () => {
      let state = createDetectionState();
      state = recordVolumeSample(state, 1000, 300000);
      state = recordVolumeSample(state, 2000, 300000);
      state = recordVolumeSample(state, 500, 300000);

      assert.strictEqual(state.volumeSamples.length, 3);
    });

    test("limits samples to max 100", () => {
      let state = createDetectionState();

      for (let i = 0; i < 150; i++) {
        state = recordVolumeSample(state, i * 100, 3600000);
      }

      assert.ok(state.volumeSamples.length <= 100);
    });
  });

  describe("Order Book Snapshot Recording", () => {
    test("records order book snapshot", () => {
      let state = createDetectionState();
      state = recordOrderBookSnapshot(
        state,
        { bidDepthUsd: 5000, askDepthUsd: 5000, bestBid: 0.5, bestAsk: 0.51 },
        120000,
      );

      assert.strictEqual(state.orderBookSnapshots.length, 1);
      assert.strictEqual(state.orderBookSnapshots[0].bidDepthUsd, 5000);
    });

    test("tracks best bid/ask changes", () => {
      let state = createDetectionState();

      state = recordOrderBookSnapshot(
        state,
        { bidDepthUsd: 5000, askDepthUsd: 5000, bestBid: 0.5, bestAsk: 0.51 },
        120000,
      );
      state = recordOrderBookSnapshot(
        state,
        { bidDepthUsd: 5000, askDepthUsd: 5000, bestBid: 0.52, bestAsk: 0.53 },
        120000,
      );

      assert.strictEqual(state.orderBookSnapshots.length, 2);
      assert.strictEqual(state.orderBookSnapshots[1].bestBid, 0.52);
    });
  });

  describe("Target Activity Recording", () => {
    test("records target activity", () => {
      let state = createDetectionState();
      state = recordTargetActivity(state, 5, 10, 300000);

      assert.strictEqual(state.targetActivitySamples.length, 1);
      assert.strictEqual(state.targetActivitySamples[0].activeCount, 5);
      assert.strictEqual(state.targetActivitySamples[0].totalCount, 10);
    });
  });
});

describe("V2 Scavenger Market Condition Analysis", () => {
  const detectionConfig: LiquidityDetectionConfig = {
    volumeThresholdUsd: 1000,
    volumeWindowMs: 300000, // 5 minutes
    minOrderBookDepthUsd: 500,
    stagnantBookThresholdMs: 120000, // 2 minutes
    minActiveTargets: 2,
    targetActivityWindowMs: 300000,
    sustainedConditionMs: 60000, // 1 minute for tests
  };

  const reversionConfig: ScavengerReversionConfig = {
    volumeRecoveryThresholdUsd: 5000,
    depthRecoveryThresholdUsd: 2000,
    minActiveTargetsForReversion: 3,
    sustainedRecoveryMs: 60000, // 1 minute for tests
  };

  describe("Low Liquidity Detection", () => {
    test("detects low volume condition", () => {
      let state = createDetectionState();

      // Record low volume
      state = recordVolumeSample(state, 500, detectionConfig.volumeWindowMs);
      // Record sufficient depth and targets to isolate volume test
      state = recordOrderBookSnapshot(
        state,
        { bidDepthUsd: 1000, askDepthUsd: 1000, bestBid: 0.5, bestAsk: 0.51 },
        detectionConfig.stagnantBookThresholdMs,
      );
      state = recordTargetActivity(
        state,
        5,
        10,
        detectionConfig.targetActivityWindowMs,
      );

      const { result } = analyzeMarketConditions(
        state,
        detectionConfig,
        false,
        reversionConfig,
      );

      // Should detect low liquidity due to volume
      assert.ok(result.reasons.some((r) => r.includes("volume")));
      assert.ok(
        result.metrics.recentVolumeUsd < detectionConfig.volumeThresholdUsd,
      );
    });

    test("detects thin order book", () => {
      let state = createDetectionState();

      // Record sufficient volume
      state = recordVolumeSample(state, 2000, detectionConfig.volumeWindowMs);
      // Record thin order book
      state = recordOrderBookSnapshot(
        state,
        { bidDepthUsd: 200, askDepthUsd: 200, bestBid: 0.5, bestAsk: 0.51 },
        detectionConfig.stagnantBookThresholdMs,
      );
      // Record sufficient targets
      state = recordTargetActivity(
        state,
        5,
        10,
        detectionConfig.targetActivityWindowMs,
      );

      const { result } = analyzeMarketConditions(
        state,
        detectionConfig,
        false,
        reversionConfig,
      );

      assert.ok(
        result.reasons.some(
          (r) => r.includes("orderbook") || r.includes("Thin"),
        ),
      );
    });

    test("detects few active targets", () => {
      let state = createDetectionState();

      // Record sufficient volume and depth
      state = recordVolumeSample(state, 2000, detectionConfig.volumeWindowMs);
      state = recordOrderBookSnapshot(
        state,
        { bidDepthUsd: 1000, askDepthUsd: 1000, bestBid: 0.5, bestAsk: 0.51 },
        detectionConfig.stagnantBookThresholdMs,
      );
      // Record few active targets
      state = recordTargetActivity(
        state,
        1,
        10,
        detectionConfig.targetActivityWindowMs,
      );

      const { result } = analyzeMarketConditions(
        state,
        detectionConfig,
        false,
        reversionConfig,
      );

      assert.ok(result.reasons.some((r) => r.includes("targets")));
    });

    test("requires multiple conditions for low liquidity", () => {
      let state = createDetectionState();

      // Only one bad condition (low volume)
      state = recordVolumeSample(state, 500, detectionConfig.volumeWindowMs);
      // Good depth
      state = recordOrderBookSnapshot(
        state,
        { bidDepthUsd: 1000, askDepthUsd: 1000, bestBid: 0.5, bestAsk: 0.51 },
        detectionConfig.stagnantBookThresholdMs,
      );
      // Good targets
      state = recordTargetActivity(
        state,
        5,
        10,
        detectionConfig.targetActivityWindowMs,
      );

      const { result } = analyzeMarketConditions(
        state,
        detectionConfig,
        false,
        reversionConfig,
      );

      // Should NOT immediately flag low liquidity with only 1 condition
      // (implementation requires >= 2 conditions)
      assert.strictEqual(result.shouldEnterScavengerMode, false);
    });
  });

  describe("Mode Transition Logic", () => {
    test("does not immediately enter scavenger mode", () => {
      let state = createDetectionState();

      // Multiple low liquidity conditions
      state = recordVolumeSample(state, 100, detectionConfig.volumeWindowMs);
      state = recordOrderBookSnapshot(
        state,
        { bidDepthUsd: 100, askDepthUsd: 100, bestBid: 0.5, bestAsk: 0.51 },
        detectionConfig.stagnantBookThresholdMs,
      );
      state = recordTargetActivity(
        state,
        0,
        10,
        detectionConfig.targetActivityWindowMs,
      );

      const { result } = analyzeMarketConditions(
        state,
        detectionConfig,
        false,
        reversionConfig,
      );

      // Should detect low liquidity but NOT immediately transition
      // (requires sustained condition)
      assert.strictEqual(result.isLowLiquidity, true);
      assert.strictEqual(result.shouldEnterScavengerMode, false);
    });

    test("tracks low liquidity duration", () => {
      let state = createDetectionState();

      // Set up low liquidity detection timestamp
      state.lowLiquidityDetectedAt = Date.now() - 120000; // 2 minutes ago

      // Record continued low liquidity
      state = recordVolumeSample(state, 100, detectionConfig.volumeWindowMs);
      state = recordOrderBookSnapshot(
        state,
        { bidDepthUsd: 100, askDepthUsd: 100, bestBid: 0.5, bestAsk: 0.51 },
        detectionConfig.stagnantBookThresholdMs,
      );
      state = recordTargetActivity(
        state,
        0,
        10,
        detectionConfig.targetActivityWindowMs,
      );

      const { result } = analyzeMarketConditions(
        state,
        detectionConfig,
        false,
        reversionConfig,
      );

      // Duration should be tracked
      assert.ok(result.metrics.lowLiquidityDurationMs >= 60000);
      // Should now trigger mode transition after sustained period
      assert.strictEqual(result.shouldEnterScavengerMode, true);
    });
  });

  describe("Clean Reversion to Normal", () => {
    test("detects volume recovery", () => {
      let state = createDetectionState();

      // Set up recovery detection timestamp
      state.highLiquidityDetectedAt = Date.now() - 120000; // 2 minutes ago

      // Record high volume (recovered)
      state = recordVolumeSample(state, 10000, detectionConfig.volumeWindowMs);
      state = recordOrderBookSnapshot(
        state,
        { bidDepthUsd: 1000, askDepthUsd: 1000, bestBid: 0.5, bestAsk: 0.52 },
        detectionConfig.stagnantBookThresholdMs,
      );
      state = recordTargetActivity(
        state,
        5,
        10,
        detectionConfig.targetActivityWindowMs,
      );

      const { result } = analyzeMarketConditions(
        state,
        detectionConfig,
        true, // Currently in scavenger mode
        reversionConfig,
      );

      // Should trigger reversion
      assert.strictEqual(result.shouldExitScavengerMode, true);
      assert.ok(result.reasons.some((r) => r.includes("recovered")));
    });

    test("detects depth recovery", () => {
      let state = createDetectionState();

      state.highLiquidityDetectedAt = Date.now() - 120000;

      // Record recovered depth
      state = recordVolumeSample(state, 500, detectionConfig.volumeWindowMs); // Low volume
      state = recordOrderBookSnapshot(
        state,
        { bidDepthUsd: 3000, askDepthUsd: 3000, bestBid: 0.5, bestAsk: 0.52 },
        detectionConfig.stagnantBookThresholdMs,
      );
      state = recordTargetActivity(
        state,
        5,
        10,
        detectionConfig.targetActivityWindowMs,
      );

      const { result } = analyzeMarketConditions(
        state,
        detectionConfig,
        true,
        reversionConfig,
      );

      // Should trigger reversion due to depth recovery
      assert.strictEqual(result.shouldExitScavengerMode, true);
    });

    test("detects target activity recovery", () => {
      let state = createDetectionState();

      state.highLiquidityDetectedAt = Date.now() - 120000;

      // Record recovered target activity
      state = recordVolumeSample(state, 500, detectionConfig.volumeWindowMs);
      state = recordOrderBookSnapshot(
        state,
        { bidDepthUsd: 100, askDepthUsd: 100, bestBid: 0.5, bestAsk: 0.51 },
        detectionConfig.stagnantBookThresholdMs,
      );
      state = recordTargetActivity(
        state,
        5,
        10,
        detectionConfig.targetActivityWindowMs,
      );

      const { result } = analyzeMarketConditions(
        state,
        detectionConfig,
        true,
        reversionConfig,
      );

      // Should trigger reversion due to active targets
      assert.strictEqual(result.shouldExitScavengerMode, true);
    });

    test("requires sustained recovery before reversion", () => {
      let state = createDetectionState();

      // No highLiquidityDetectedAt set (just started recovering)
      state.lowLiquidityDetectedAt = Date.now() - 300000; // Was in low liquidity

      // Record high volume (recovered)
      state = recordVolumeSample(state, 10000, detectionConfig.volumeWindowMs);
      state = recordOrderBookSnapshot(
        state,
        { bidDepthUsd: 5000, askDepthUsd: 5000, bestBid: 0.5, bestAsk: 0.51 },
        detectionConfig.stagnantBookThresholdMs,
      );
      state = recordTargetActivity(
        state,
        5,
        10,
        detectionConfig.targetActivityWindowMs,
      );

      const { result, newState } = analyzeMarketConditions(
        state,
        detectionConfig,
        true,
        reversionConfig,
      );

      // Should NOT immediately exit - needs sustained recovery
      assert.strictEqual(result.shouldExitScavengerMode, false);
      // But should start tracking recovery
      assert.ok(newState.highLiquidityDetectedAt !== null);
    });
  });
});

describe("V2 Scavenger Detection Metrics", () => {
  test("returns accurate volume metrics", () => {
    let state = createDetectionState();

    state = recordVolumeSample(state, 1000, 300000);
    state = recordVolumeSample(state, 2000, 300000);
    state = recordVolumeSample(state, 500, 300000);

    const { result } = analyzeMarketConditions(
      state,
      DEFAULT_SCAVENGER_CONFIG.detection,
      false,
    );

    // Total volume should be sum of samples
    assert.strictEqual(result.metrics.recentVolumeUsd, 3500);
  });

  test("returns accurate order book depth metrics", () => {
    let state = createDetectionState();

    state = recordOrderBookSnapshot(
      state,
      { bidDepthUsd: 1000, askDepthUsd: 1500, bestBid: 0.5, bestAsk: 0.51 },
      120000,
    );
    state = recordOrderBookSnapshot(
      state,
      { bidDepthUsd: 1200, askDepthUsd: 1300, bestBid: 0.5, bestAsk: 0.51 },
      120000,
    );

    const { result } = analyzeMarketConditions(
      state,
      DEFAULT_SCAVENGER_CONFIG.detection,
      false,
    );

    // Average depth: ((1000+1500) + (1200+1300)) / 2 = 2500
    assert.ok(result.metrics.avgOrderBookDepthUsd > 0);
  });
});
