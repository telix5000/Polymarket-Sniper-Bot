import assert from "node:assert";
import { test, describe } from "node:test";

/**
 * Unit tests for V2 Scavenger Mode - Configuration
 *
 * These tests verify:
 * 1. Default configuration values
 * 2. Environment variable overrides
 * 3. Configuration loading
 */

import {
  DEFAULT_SCAVENGER_CONFIG,
  loadScavengerConfig,
  type ScavengerConfig,
} from "../../src/lib/scavenger-config";

describe("V2 Scavenger Configuration", () => {
  describe("Default Configuration", () => {
    test("has sensible detection defaults", () => {
      const cfg = DEFAULT_SCAVENGER_CONFIG.detection;

      assert.strictEqual(cfg.volumeThresholdUsd, 1000);
      assert.strictEqual(cfg.volumeWindowMs, 5 * 60 * 1000);
      assert.strictEqual(cfg.minOrderBookDepthUsd, 500);
      assert.strictEqual(cfg.stagnantBookThresholdMs, 2 * 60 * 1000);
      assert.strictEqual(cfg.minActiveTargets, 1);
      assert.strictEqual(cfg.sustainedConditionMs, 3 * 60 * 1000);
    });

    test("has sensible exit defaults", () => {
      const cfg = DEFAULT_SCAVENGER_CONFIG.exit;

      assert.strictEqual(cfg.stalledPriceThresholdMs, 30 * 1000);
      assert.strictEqual(cfg.minGreenProfitPct, 1);
      assert.strictEqual(cfg.minAcceptableProfitUsd, 0.5);
      assert.strictEqual(cfg.conservativeSlippagePct, 1);
    });

    test("has sensible red monitor defaults", () => {
      const cfg = DEFAULT_SCAVENGER_CONFIG.redMonitor;

      assert.strictEqual(cfg.smallProfitThresholdPct, 0.5);
      assert.strictEqual(cfg.minRecoveryProfitUsd, 0.25);
    });

    test("has sensible micro-buy defaults", () => {
      const cfg = DEFAULT_SCAVENGER_CONFIG.microBuy;

      assert.strictEqual(cfg.enabled, true);
      assert.strictEqual(cfg.minExpectedProfitUsd, 0.5);
      assert.strictEqual(cfg.maxCapitalFraction, 0.05);
      assert.strictEqual(cfg.maxPositionUsd, 10);
      assert.strictEqual(cfg.minDiscountPct, 3);
      assert.strictEqual(cfg.takeProfitPct, 5);
    });

    test("has sensible risk defaults", () => {
      const cfg = DEFAULT_SCAVENGER_CONFIG.risk;

      assert.strictEqual(cfg.maxDeployedCapitalUsd, 100);
      assert.strictEqual(cfg.maxScavengePositions, 10);
      assert.strictEqual(cfg.tokenCooldownMs, 5 * 60 * 1000);
    });

    test("has sensible reversion defaults", () => {
      const cfg = DEFAULT_SCAVENGER_CONFIG.reversion;

      assert.strictEqual(cfg.volumeRecoveryThresholdUsd, 5000);
      assert.strictEqual(cfg.depthRecoveryThresholdUsd, 2000);
      assert.strictEqual(cfg.minActiveTargetsForReversion, 2);
      assert.strictEqual(cfg.sustainedRecoveryMs, 2 * 60 * 1000);
    });

    test("is enabled by default", () => {
      assert.strictEqual(DEFAULT_SCAVENGER_CONFIG.enabled, true);
    });
  });

  describe("Environment Variable Overrides", () => {
    // Store original env values
    const originalEnv: Record<string, string | undefined> = {};

    function setEnv(key: string, value: string) {
      originalEnv[key] = process.env[key];
      process.env[key] = value;
    }

    function restoreEnv() {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }

    test("SCAVENGER_ENABLED overrides default", () => {
      setEnv("SCAVENGER_ENABLED", "false");

      try {
        const cfg = loadScavengerConfig();
        assert.strictEqual(cfg.enabled, false);
      } finally {
        restoreEnv();
      }
    });

    test("SCAVENGER_VOLUME_THRESHOLD_USD overrides default", () => {
      setEnv("SCAVENGER_VOLUME_THRESHOLD_USD", "5000");

      try {
        const cfg = loadScavengerConfig();
        assert.strictEqual(cfg.detection.volumeThresholdUsd, 5000);
      } finally {
        restoreEnv();
      }
    });

    test("SCAVENGER_MAX_POSITIONS overrides default", () => {
      setEnv("SCAVENGER_MAX_POSITIONS", "20");

      try {
        const cfg = loadScavengerConfig();
        assert.strictEqual(cfg.risk.maxScavengePositions, 20);
      } finally {
        restoreEnv();
      }
    });

    test("SCAVENGER_MICRO_BUY_ENABLED overrides default", () => {
      setEnv("SCAVENGER_MICRO_BUY_ENABLED", "false");

      try {
        const cfg = loadScavengerConfig();
        assert.strictEqual(cfg.microBuy.enabled, false);
      } finally {
        restoreEnv();
      }
    });

    test("invalid number falls back to default", () => {
      setEnv("SCAVENGER_VOLUME_THRESHOLD_USD", "not-a-number");

      try {
        const cfg = loadScavengerConfig();
        assert.strictEqual(
          cfg.detection.volumeThresholdUsd,
          DEFAULT_SCAVENGER_CONFIG.detection.volumeThresholdUsd,
        );
      } finally {
        restoreEnv();
      }
    });

    test("accepts boolean variants", () => {
      setEnv("SCAVENGER_ENABLED", "1");

      try {
        const cfg = loadScavengerConfig();
        assert.strictEqual(cfg.enabled, true);
      } finally {
        restoreEnv();
      }

      setEnv("SCAVENGER_ENABLED", "TRUE");

      try {
        const cfg = loadScavengerConfig();
        assert.strictEqual(cfg.enabled, true);
      } finally {
        restoreEnv();
      }
    });
  });

  describe("Configuration Validation", () => {
    test("detection thresholds are positive", () => {
      const cfg = DEFAULT_SCAVENGER_CONFIG;

      assert.ok(cfg.detection.volumeThresholdUsd > 0);
      assert.ok(cfg.detection.volumeWindowMs > 0);
      assert.ok(cfg.detection.minOrderBookDepthUsd > 0);
      assert.ok(cfg.detection.stagnantBookThresholdMs > 0);
      assert.ok(cfg.detection.minActiveTargets >= 0);
      assert.ok(cfg.detection.sustainedConditionMs > 0);
    });

    test("exit thresholds are positive", () => {
      const cfg = DEFAULT_SCAVENGER_CONFIG;

      assert.ok(cfg.exit.stalledPriceThresholdMs > 0);
      assert.ok(cfg.exit.minGreenProfitPct > 0);
      assert.ok(cfg.exit.minAcceptableProfitUsd >= 0);
      assert.ok(cfg.exit.conservativeSlippagePct >= 0);
    });

    test("risk limits are positive", () => {
      const cfg = DEFAULT_SCAVENGER_CONFIG;

      assert.ok(cfg.risk.maxDeployedCapitalUsd > 0);
      assert.ok(cfg.risk.maxScavengePositions > 0);
      assert.ok(cfg.risk.tokenCooldownMs > 0);
    });

    test("reversion thresholds are higher than detection thresholds", () => {
      const cfg = DEFAULT_SCAVENGER_CONFIG;

      // Recovery should require higher volume than detection
      assert.ok(
        cfg.reversion.volumeRecoveryThresholdUsd >
          cfg.detection.volumeThresholdUsd,
        "Volume recovery threshold should be higher than detection threshold",
      );

      // Recovery should require more depth than detection
      assert.ok(
        cfg.reversion.depthRecoveryThresholdUsd >
          cfg.detection.minOrderBookDepthUsd,
        "Depth recovery threshold should be higher than detection threshold",
      );

      // Recovery should require more active targets
      assert.ok(
        cfg.reversion.minActiveTargetsForReversion >=
          cfg.detection.minActiveTargets,
        "Active targets for reversion should be >= detection minimum",
      );
    });

    test("micro-buy capital fraction is reasonable", () => {
      const cfg = DEFAULT_SCAVENGER_CONFIG;

      assert.ok(cfg.microBuy.maxCapitalFraction > 0);
      assert.ok(cfg.microBuy.maxCapitalFraction <= 0.2); // Max 20% per trade
    });
  });
});
