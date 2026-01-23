/**
 * Enterprise Configuration
 *
 * Central configuration for the enterprise trading system.
 * All settings have sensible defaults - only override what you need via ENV.
 *
 * ENV Variables (all optional):
 * - ENTERPRISE_MODE: "conservative" | "balanced" | "aggressive" (default: from STRATEGY_PRESET)
 * - MAX_EXPOSURE_USD: Total portfolio exposure limit
 * - MAX_DRAWDOWN_PCT: Max drawdown before kill switch
 * - KILL_SWITCH_FILE: Path to kill switch file
 */

import type { RiskManagerConfig } from "./risk-manager";
import type { MarketSelectorConfig } from "./market-selector";
import type { ExecutionEngineConfig } from "./execution-engine";

export type EnterpriseMode = "conservative" | "balanced" | "aggressive";

/**
 * Complete enterprise configuration
 */
export interface EnterpriseSystemConfig {
  mode: EnterpriseMode;
  risk: RiskManagerConfig;
  marketSelector: MarketSelectorConfig;
  execution: ExecutionEngineConfig;
  // Strategy enables
  enableMM: boolean; // Market Making
  enableFF: boolean; // Flow Following
  enableICC: boolean; // Inventory Control
}

/**
 * Default configurations by mode
 * These are carefully tuned defaults - most users won't need to change them
 */
export const ENTERPRISE_PRESETS: Record<
  EnterpriseMode,
  EnterpriseSystemConfig
> = {
  /**
   * CONSERVATIVE Mode
   * - Lower exposure limits
   * - Tighter spreads required
   * - More liquid markets only
   * - Post-only orders (maker)
   * - Suitable for starting out or low-risk tolerance
   */
  conservative: {
    mode: "conservative",
    risk: {
      maxExposureUsd: 200,
      maxExposurePerMarketUsd: 50,
      maxExposurePerCategoryUsd: 100,
      maxDrawdownPct: 10,
      maxConsecutiveRejects: 3,
      maxSlippageCents: 1,
      minOrderUsd: 5,
      dustThresholdUsd: 1,
    },
    marketSelector: {
      minDepthUsd: 2000,
      maxSpreadCents: 2,
      minRecentTrades: 5,
      minVolume24hUsd: 10000,
      maxMarkets: 20,
    },
    execution: {
      postOnlyDefault: true,
      maxRetries: 1,
      maxSlippageCents: 1,
    },
    enableMM: true,
    enableFF: false, // Too aggressive for conservative
    enableICC: true,
  },

  /**
   * BALANCED Mode
   * - Moderate exposure limits
   * - Reasonable spread tolerance
   * - Mix of maker and taker
   * - Good for regular trading
   */
  balanced: {
    mode: "balanced",
    risk: {
      maxExposureUsd: 500,
      maxExposurePerMarketUsd: 100,
      maxExposurePerCategoryUsd: 200,
      maxDrawdownPct: 15,
      maxConsecutiveRejects: 5,
      maxSlippageCents: 2,
      minOrderUsd: 1,
      dustThresholdUsd: 0.5,
    },
    marketSelector: {
      minDepthUsd: 1000,
      maxSpreadCents: 3,
      minRecentTrades: 2,
      minVolume24hUsd: 5000,
      maxMarkets: 30,
    },
    execution: {
      postOnlyDefault: true,
      maxRetries: 2,
      maxSlippageCents: 2,
    },
    enableMM: true,
    enableFF: true,
    enableICC: true,
  },

  /**
   * AGGRESSIVE Mode (Enterprise)
   * - Higher exposure for scale
   * - Wider spread tolerance for more opportunities
   * - Faster execution (may take liquidity)
   * - All strategies enabled
   * - For experienced traders seeking maximum returns
   */
  aggressive: {
    mode: "aggressive",
    risk: {
      maxExposureUsd: 2000,
      maxExposurePerMarketUsd: 200,
      maxExposurePerCategoryUsd: 500,
      maxDrawdownPct: 25,
      maxConsecutiveRejects: 10,
      maxSlippageCents: 3,
      minOrderUsd: 1,
      dustThresholdUsd: 0.5,
    },
    marketSelector: {
      minDepthUsd: 500,
      maxSpreadCents: 5,
      minRecentTrades: 1,
      minVolume24hUsd: 1000,
      maxMarkets: 50,
    },
    execution: {
      postOnlyDefault: false, // Allow taking for speed
      maxRetries: 3,
      maxSlippageCents: 3,
    },
    enableMM: true,
    enableFF: true,
    enableICC: true,
  },
};

/**
 * Load enterprise configuration from environment
 * Respects existing ENV variables and adds enterprise-specific ones
 */
export function loadEnterpriseConfig(
  strategyPreset?: string,
): EnterpriseSystemConfig {
  // Determine mode from ENTERPRISE_MODE or STRATEGY_PRESET
  const envMode = process.env.ENTERPRISE_MODE?.toLowerCase();
  const modeFromPreset = strategyPreset?.toLowerCase();

  let mode: EnterpriseMode = "balanced"; // Default

  if (
    envMode === "conservative" ||
    envMode === "balanced" ||
    envMode === "aggressive"
  ) {
    mode = envMode;
  } else if (
    modeFromPreset === "conservative" ||
    modeFromPreset === "balanced" ||
    modeFromPreset === "aggressive"
  ) {
    mode = modeFromPreset;
  }

  // Start with preset
  const config = { ...ENTERPRISE_PRESETS[mode] };

  // Apply ENV overrides (only the key ones users might want to tune)
  const envOverrides = {
    // Risk
    maxExposureUsd: parseEnvNumber("MAX_EXPOSURE_USD"),
    maxExposurePerMarketUsd: parseEnvNumber("MAX_EXPOSURE_PER_MARKET_USD"),
    maxDrawdownPct: parseEnvNumber("MAX_DRAWDOWN_PCT"),
    // Execution
    maxSlippageCents: parseEnvNumber("MAX_SLIPPAGE_CENTS"),
    // Kill switch
    killSwitchFile:
      process.env.KILL_SWITCH_FILE || process.env.ARB_KILL_SWITCH_FILE,
  };

  // Apply non-undefined overrides to risk config
  if (envOverrides.maxExposureUsd !== undefined) {
    config.risk.maxExposureUsd = envOverrides.maxExposureUsd;
  }
  if (envOverrides.maxExposurePerMarketUsd !== undefined) {
    config.risk.maxExposurePerMarketUsd = envOverrides.maxExposurePerMarketUsd;
  }
  if (envOverrides.maxDrawdownPct !== undefined) {
    config.risk.maxDrawdownPct = envOverrides.maxDrawdownPct;
  }
  if (envOverrides.maxSlippageCents !== undefined) {
    config.risk.maxSlippageCents = envOverrides.maxSlippageCents;
    config.execution.maxSlippageCents = envOverrides.maxSlippageCents;
  }
  if (envOverrides.killSwitchFile) {
    config.risk.killSwitchFile = envOverrides.killSwitchFile;
  }

  // Strategy enables from ENV
  if (process.env.ENTERPRISE_ENABLE_MM !== undefined) {
    config.enableMM = process.env.ENTERPRISE_ENABLE_MM.toLowerCase() === "true";
  }
  if (process.env.ENTERPRISE_ENABLE_FF !== undefined) {
    config.enableFF = process.env.ENTERPRISE_ENABLE_FF.toLowerCase() === "true";
  }
  if (process.env.ENTERPRISE_ENABLE_ICC !== undefined) {
    config.enableICC =
      process.env.ENTERPRISE_ENABLE_ICC.toLowerCase() === "true";
  }

  return config;
}

/**
 * Parse number from ENV
 */
function parseEnvNumber(key: string): number | undefined {
  const value = process.env[key];
  if (!value) return undefined;
  const parsed = parseFloat(value);
  return isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Format config for logging (hide sensitive values)
 */
export function formatEnterpriseConfig(config: EnterpriseSystemConfig): string {
  return JSON.stringify(
    {
      mode: config.mode,
      risk: {
        maxExposureUsd: config.risk.maxExposureUsd,
        maxDrawdownPct: config.risk.maxDrawdownPct,
        maxSlippageCents: config.risk.maxSlippageCents,
      },
      marketSelector: {
        minDepthUsd: config.marketSelector.minDepthUsd,
        maxSpreadCents: config.marketSelector.maxSpreadCents,
      },
      strategies: {
        MM: config.enableMM,
        FF: config.enableFF,
        ICC: config.enableICC,
      },
    },
    null,
    2,
  );
}
