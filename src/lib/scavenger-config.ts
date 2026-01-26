/**
 * V2 Scavenger Configuration - Configuration types and defaults for scavenger mode
 *
 * All thresholds are configurable via environment variables or can be loaded
 * from the preset configuration.
 */

/**
 * Low liquidity detection configuration
 */
export interface LiquidityDetectionConfig {
  /**
   * Minimum market volume (USD) in the observation window
   * Below this threshold, market is considered low liquidity
   */
  volumeThresholdUsd: number;

  /**
   * Observation window for volume (milliseconds)
   * Volume is checked over this rolling window
   */
  volumeWindowMs: number;

  /**
   * Minimum order book depth (USD) to consider healthy
   */
  minOrderBookDepthUsd: number;

  /**
   * Maximum time (ms) without meaningful bid/ask changes
   * before considering the book "stagnant"
   */
  stagnantBookThresholdMs: number;

  /**
   * Minimum number of active target accounts required
   * If active targets fall below this, signals low activity
   */
  minActiveTargets: number;

  /**
   * Time window (ms) to check for target activity
   */
  targetActivityWindowMs: number;

  /**
   * How long conditions must persist before triggering mode switch (ms)
   */
  sustainedConditionMs: number;
}

/**
 * Scavenger exit strategy configuration (green positions)
 */
export interface ScavengerExitConfig {
  /**
   * Time (ms) without price movement before considering position "stalled"
   */
  stalledPriceThresholdMs: number;

  /**
   * Minimum profit percentage to consider a position "green"
   */
  minGreenProfitPct: number;

  /**
   * Minimum acceptable profit (USD) when exiting
   * Will not force sells that go below this threshold
   */
  minAcceptableProfitUsd: number;

  /**
   * Slippage tolerance for conservative sells (percentage)
   */
  conservativeSlippagePct: number;
}

/**
 * Red position monitoring configuration
 */
export interface ScavengerRedMonitorConfig {
  /**
   * Small profit threshold (percentage) at which red positions
   * are sold when they turn green
   */
  smallProfitThresholdPct: number;

  /**
   * Minimum profit (USD) required to trigger recovery sell
   */
  minRecoveryProfitUsd: number;
}

/**
 * Opportunistic micro-buy configuration
 */
export interface ScavengerMicroBuyConfig {
  /**
   * Enabled flag for micro-buys
   */
  enabled: boolean;

  /**
   * Minimum expected profit (USD) for a micro-buy
   */
  minExpectedProfitUsd: number;

  /**
   * Maximum position size as fraction of available capital (0-1)
   */
  maxCapitalFraction: number;

  /**
   * Maximum position size (USD) per micro-buy
   */
  maxPositionUsd: number;

  /**
   * Minimum discount (percentage) from recent price required
   */
  minDiscountPct: number;

  /**
   * Take-profit percentage for immediate exit placement
   */
  takeProfitPct: number;
}

/**
 * Risk constraints for scavenger mode
 */
export interface ScavengerRiskConfig {
  /**
   * Hard cap on total deployed capital in scavenger mode (USD)
   */
  maxDeployedCapitalUsd: number;

  /**
   * Maximum number of open positions in scavenger mode
   */
  maxScavengePositions: number;

  /**
   * Cooldown (ms) before re-entering the same token after exit
   */
  tokenCooldownMs: number;
}

/**
 * Reversion (exit scavenger mode) configuration
 */
export interface ScavengerReversionConfig {
  /**
   * Volume threshold (USD) to trigger reversion to normal
   */
  volumeRecoveryThresholdUsd: number;

  /**
   * Minimum order book depth (USD) for reversion
   */
  depthRecoveryThresholdUsd: number;

  /**
   * Minimum active targets to trigger reversion
   */
  minActiveTargetsForReversion: number;

  /**
   * How long recovery conditions must be sustained (ms)
   */
  sustainedRecoveryMs: number;
}

/**
 * Complete scavenger mode configuration
 */
export interface ScavengerConfig {
  /**
   * Enable/disable scavenger mode entirely
   */
  enabled: boolean;

  /**
   * Liquidity detection settings
   */
  detection: LiquidityDetectionConfig;

  /**
   * Green position exit settings
   */
  exit: ScavengerExitConfig;

  /**
   * Red position monitoring settings
   */
  redMonitor: ScavengerRedMonitorConfig;

  /**
   * Micro-buy settings
   */
  microBuy: ScavengerMicroBuyConfig;

  /**
   * Risk constraint settings
   */
  risk: ScavengerRiskConfig;

  /**
   * Reversion to normal mode settings
   */
  reversion: ScavengerReversionConfig;
}

/**
 * Default scavenger configuration
 */
export const DEFAULT_SCAVENGER_CONFIG: ScavengerConfig = {
  enabled: true,

  detection: {
    volumeThresholdUsd: 1000, // $1000 minimum volume
    volumeWindowMs: 5 * 60 * 1000, // 5 minute window
    minOrderBookDepthUsd: 500, // $500 minimum depth
    stagnantBookThresholdMs: 2 * 60 * 1000, // 2 minutes without changes
    minActiveTargets: 1, // At least 1 active target
    targetActivityWindowMs: 5 * 60 * 1000, // 5 minute window
    sustainedConditionMs: 3 * 60 * 1000, // 3 minutes sustained
  },

  exit: {
    stalledPriceThresholdMs: 30 * 1000, // 30 seconds stalled
    minGreenProfitPct: 1, // 1% minimum profit
    minAcceptableProfitUsd: 0.5, // $0.50 minimum profit
    conservativeSlippagePct: 1, // 1% slippage
  },

  redMonitor: {
    smallProfitThresholdPct: 0.5, // 0.5% profit to trigger sell
    minRecoveryProfitUsd: 0.25, // $0.25 minimum recovery profit
  },

  microBuy: {
    enabled: true,
    minExpectedProfitUsd: 0.5, // $0.50 minimum expected profit
    maxCapitalFraction: 0.05, // 5% of available capital max
    maxPositionUsd: 10, // $10 max per micro-buy
    minDiscountPct: 3, // 3% discount required
    takeProfitPct: 5, // 5% take profit
  },

  risk: {
    maxDeployedCapitalUsd: 100, // $100 max deployed in scavenger mode
    maxScavengePositions: 10, // Max 10 positions
    tokenCooldownMs: 5 * 60 * 1000, // 5 minute cooldown
  },

  reversion: {
    volumeRecoveryThresholdUsd: 5000, // $5000 volume for recovery
    depthRecoveryThresholdUsd: 2000, // $2000 depth for recovery
    minActiveTargetsForReversion: 2, // At least 2 active targets
    sustainedRecoveryMs: 2 * 60 * 1000, // 2 minutes sustained recovery
  },
};

/**
 * Load scavenger configuration from environment variables
 * Falls back to defaults if not set
 */
export function loadScavengerConfig(): ScavengerConfig {
  const envBool = (key: string, defaultVal: boolean): boolean => {
    const val = process.env[key];
    if (val === undefined) return defaultVal;
    return val.toLowerCase() === "true" || val === "1";
  };

  const envNum = (key: string, defaultVal: number): number => {
    const val = process.env[key];
    if (val === undefined) return defaultVal;
    const parsed = parseFloat(val);
    return isNaN(parsed) ? defaultVal : parsed;
  };

  return {
    enabled: envBool("SCAVENGER_ENABLED", DEFAULT_SCAVENGER_CONFIG.enabled),

    detection: {
      volumeThresholdUsd: envNum(
        "SCAVENGER_VOLUME_THRESHOLD_USD",
        DEFAULT_SCAVENGER_CONFIG.detection.volumeThresholdUsd,
      ),
      volumeWindowMs: envNum(
        "SCAVENGER_VOLUME_WINDOW_MS",
        DEFAULT_SCAVENGER_CONFIG.detection.volumeWindowMs,
      ),
      minOrderBookDepthUsd: envNum(
        "SCAVENGER_MIN_ORDERBOOK_DEPTH_USD",
        DEFAULT_SCAVENGER_CONFIG.detection.minOrderBookDepthUsd,
      ),
      stagnantBookThresholdMs: envNum(
        "SCAVENGER_STAGNANT_BOOK_THRESHOLD_MS",
        DEFAULT_SCAVENGER_CONFIG.detection.stagnantBookThresholdMs,
      ),
      minActiveTargets: envNum(
        "SCAVENGER_MIN_ACTIVE_TARGETS",
        DEFAULT_SCAVENGER_CONFIG.detection.minActiveTargets,
      ),
      targetActivityWindowMs: envNum(
        "SCAVENGER_TARGET_ACTIVITY_WINDOW_MS",
        DEFAULT_SCAVENGER_CONFIG.detection.targetActivityWindowMs,
      ),
      sustainedConditionMs: envNum(
        "SCAVENGER_SUSTAINED_CONDITION_MS",
        DEFAULT_SCAVENGER_CONFIG.detection.sustainedConditionMs,
      ),
    },

    exit: {
      stalledPriceThresholdMs: envNum(
        "SCAVENGER_STALLED_PRICE_THRESHOLD_MS",
        DEFAULT_SCAVENGER_CONFIG.exit.stalledPriceThresholdMs,
      ),
      minGreenProfitPct: envNum(
        "SCAVENGER_MIN_GREEN_PROFIT_PCT",
        DEFAULT_SCAVENGER_CONFIG.exit.minGreenProfitPct,
      ),
      minAcceptableProfitUsd: envNum(
        "SCAVENGER_MIN_ACCEPTABLE_PROFIT_USD",
        DEFAULT_SCAVENGER_CONFIG.exit.minAcceptableProfitUsd,
      ),
      conservativeSlippagePct: envNum(
        "SCAVENGER_CONSERVATIVE_SLIPPAGE_PCT",
        DEFAULT_SCAVENGER_CONFIG.exit.conservativeSlippagePct,
      ),
    },

    redMonitor: {
      smallProfitThresholdPct: envNum(
        "SCAVENGER_SMALL_PROFIT_THRESHOLD_PCT",
        DEFAULT_SCAVENGER_CONFIG.redMonitor.smallProfitThresholdPct,
      ),
      minRecoveryProfitUsd: envNum(
        "SCAVENGER_MIN_RECOVERY_PROFIT_USD",
        DEFAULT_SCAVENGER_CONFIG.redMonitor.minRecoveryProfitUsd,
      ),
    },

    microBuy: {
      enabled: envBool(
        "SCAVENGER_MICRO_BUY_ENABLED",
        DEFAULT_SCAVENGER_CONFIG.microBuy.enabled,
      ),
      minExpectedProfitUsd: envNum(
        "SCAVENGER_MICRO_BUY_MIN_EXPECTED_PROFIT_USD",
        DEFAULT_SCAVENGER_CONFIG.microBuy.minExpectedProfitUsd,
      ),
      maxCapitalFraction: envNum(
        "SCAVENGER_MICRO_BUY_MAX_CAPITAL_FRACTION",
        DEFAULT_SCAVENGER_CONFIG.microBuy.maxCapitalFraction,
      ),
      maxPositionUsd: envNum(
        "SCAVENGER_MICRO_BUY_MAX_POSITION_USD",
        DEFAULT_SCAVENGER_CONFIG.microBuy.maxPositionUsd,
      ),
      minDiscountPct: envNum(
        "SCAVENGER_MICRO_BUY_MIN_DISCOUNT_PCT",
        DEFAULT_SCAVENGER_CONFIG.microBuy.minDiscountPct,
      ),
      takeProfitPct: envNum(
        "SCAVENGER_MICRO_BUY_TAKE_PROFIT_PCT",
        DEFAULT_SCAVENGER_CONFIG.microBuy.takeProfitPct,
      ),
    },

    risk: {
      maxDeployedCapitalUsd: envNum(
        "SCAVENGER_MAX_DEPLOYED_CAPITAL_USD",
        DEFAULT_SCAVENGER_CONFIG.risk.maxDeployedCapitalUsd,
      ),
      maxScavengePositions: envNum(
        "SCAVENGER_MAX_POSITIONS",
        DEFAULT_SCAVENGER_CONFIG.risk.maxScavengePositions,
      ),
      tokenCooldownMs: envNum(
        "SCAVENGER_TOKEN_COOLDOWN_MS",
        DEFAULT_SCAVENGER_CONFIG.risk.tokenCooldownMs,
      ),
    },

    reversion: {
      volumeRecoveryThresholdUsd: envNum(
        "SCAVENGER_VOLUME_RECOVERY_THRESHOLD_USD",
        DEFAULT_SCAVENGER_CONFIG.reversion.volumeRecoveryThresholdUsd,
      ),
      depthRecoveryThresholdUsd: envNum(
        "SCAVENGER_DEPTH_RECOVERY_THRESHOLD_USD",
        DEFAULT_SCAVENGER_CONFIG.reversion.depthRecoveryThresholdUsd,
      ),
      minActiveTargetsForReversion: envNum(
        "SCAVENGER_MIN_ACTIVE_TARGETS_REVERSION",
        DEFAULT_SCAVENGER_CONFIG.reversion.minActiveTargetsForReversion,
      ),
      sustainedRecoveryMs: envNum(
        "SCAVENGER_SUSTAINED_RECOVERY_MS",
        DEFAULT_SCAVENGER_CONFIG.reversion.sustainedRecoveryMs,
      ),
    },
  };
}
