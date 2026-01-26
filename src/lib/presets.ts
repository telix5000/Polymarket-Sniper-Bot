/**
 * V2 Presets Configuration
 * Strategy presets for conservative, balanced, and aggressive trading
 */

export type PresetName = "conservative" | "balanced" | "aggressive";

export interface PresetConfig {
  // Auto-sell near $1
  autoSell: {
    enabled: boolean;
    threshold: number;
    minHoldSec: number;
  };
  // Stop loss protection
  stopLoss: {
    enabled: boolean;
    maxLossPct: number;
    minHoldSec: number;
  };
  // Hedging losing positions
  hedge: {
    enabled: boolean;
    triggerPct: number;
    maxUsd: number;
    reservePct: number;
  };
  // Take profit scalping
  scalp: {
    enabled: boolean;
    minProfitPct: number;
    minGainCents: number;
    minProfitUsd: number;
  };
  // Stack winning positions
  stack: {
    enabled: boolean;
    minGainCents: number;
    maxUsd: number;
    maxPrice: number;
  };
  // Endgame high-probability buys
  endgame: {
    enabled: boolean;
    minPrice: number;
    maxPrice: number;
    maxUsd: number;
  };
  // Auto-redeem resolved positions
  redeem: {
    enabled: boolean;
    intervalMin: number;
    minPositionUsd: number;
  };
  // Copy trading
  copy: {
    multiplier: number;
    minUsd: number;
    maxUsd: number;
    minBuyPrice: number;
  };
  // Arbitrage
  arb: {
    enabled: boolean;
    maxUsd: number;
    minEdgeBps: number;
  };
  // Risk management
  risk: {
    maxDrawdownPct: number;
    maxDailyLossUsd: number;
    maxOpenPositions: number;
    hedgeBuffer: number;
  };
  // Max position size (global cap)
  maxPositionUsd: number;
}

export const PRESETS: Record<PresetName, PresetConfig> = {
  conservative: {
    autoSell: { enabled: true, threshold: 0.98, minHoldSec: 60 },
    stopLoss: { enabled: true, maxLossPct: 20, minHoldSec: 120 },
    hedge: { enabled: true, triggerPct: 15, maxUsd: 15, reservePct: 25 },
    scalp: { enabled: true, minProfitPct: 15, minGainCents: 8, minProfitUsd: 2.0 },
    stack: { enabled: true, minGainCents: 25, maxUsd: 15, maxPrice: 0.90 },
    endgame: { enabled: true, minPrice: 0.90, maxPrice: 0.98, maxUsd: 15 },
    redeem: { enabled: true, intervalMin: 15, minPositionUsd: 0.10 },
    copy: { multiplier: 1.0, minUsd: 5, maxUsd: 50, minBuyPrice: 0.50 },
    arb: { enabled: true, maxUsd: 15, minEdgeBps: 50 },
    risk: { maxDrawdownPct: 15, maxDailyLossUsd: 50, maxOpenPositions: 50, hedgeBuffer: 5 },
    maxPositionUsd: 15,
  },
  balanced: {
    autoSell: { enabled: true, threshold: 0.99, minHoldSec: 60 },
    stopLoss: { enabled: true, maxLossPct: 25, minHoldSec: 60 },
    hedge: { enabled: true, triggerPct: 20, maxUsd: 25, reservePct: 20 },
    scalp: { enabled: true, minProfitPct: 10, minGainCents: 5, minProfitUsd: 1.0 },
    stack: { enabled: true, minGainCents: 20, maxUsd: 25, maxPrice: 0.95 },
    endgame: { enabled: true, minPrice: 0.85, maxPrice: 0.99, maxUsd: 25 },
    redeem: { enabled: true, intervalMin: 15, minPositionUsd: 0.10 },
    copy: { multiplier: 1.0, minUsd: 5, maxUsd: 100, minBuyPrice: 0.50 },
    arb: { enabled: true, maxUsd: 25, minEdgeBps: 30 },
    risk: { maxDrawdownPct: 20, maxDailyLossUsd: 100, maxOpenPositions: 100, hedgeBuffer: 10 },
    maxPositionUsd: 25,
  },
  aggressive: {
    autoSell: { enabled: true, threshold: 0.995, minHoldSec: 30 },
    stopLoss: { enabled: true, maxLossPct: 35, minHoldSec: 30 },
    hedge: { enabled: true, triggerPct: 25, maxUsd: 50, reservePct: 15 },
    scalp: { enabled: true, minProfitPct: 5, minGainCents: 3, minProfitUsd: 0.5 },
    stack: { enabled: true, minGainCents: 15, maxUsd: 50, maxPrice: 0.97 },
    endgame: { enabled: true, minPrice: 0.80, maxPrice: 0.995, maxUsd: 50 },
    redeem: { enabled: true, intervalMin: 10, minPositionUsd: 0.01 },
    copy: { multiplier: 1.0, minUsd: 5, maxUsd: 200, minBuyPrice: 0.50 },
    arb: { enabled: true, maxUsd: 50, minEdgeBps: 20 },
    risk: { maxDrawdownPct: 30, maxDailyLossUsd: 200, maxOpenPositions: 200, hedgeBuffer: 20 },
    maxPositionUsd: 50,
  },
};

/**
 * Load preset from environment or use default
 */
export function loadPreset(): { name: PresetName; config: PresetConfig } {
  const name = (process.env.STRATEGY_PRESET ?? process.env.PRESET ?? "balanced") as PresetName;
  
  if (!PRESETS[name]) {
    console.warn(`Unknown preset "${name}", falling back to "balanced"`);
    return { name: "balanced", config: PRESETS.balanced };
  }
  
  return { name, config: PRESETS[name] };
}

/**
 * Get max position size from env or preset
 */
export function getMaxPositionUsd(preset: PresetConfig): number {
  const envMax = process.env.MAX_POSITION_USD ?? process.env.ARB_MAX_POSITION_USD;
  if (envMax) {
    const parsed = parseFloat(envMax);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return preset.maxPositionUsd;
}
