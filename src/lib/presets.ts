/**
 * V2 Presets - Strategy configuration presets
 */

import type { Preset } from "./types";

export interface PresetConfig {
  autoSell: {
    enabled: boolean;
    threshold: number;
    minHoldSec: number;
  };
  stopLoss: {
    enabled: boolean;
    maxLossPct: number;
    minHoldSec: number;
  };
  hedge: {
    enabled: boolean;
    triggerPct: number;
    maxUsd: number;
    reservePct: number;
    allowExceedMax: boolean;
    absoluteMaxUsd: number;
  };
  scalp: {
    enabled: boolean;
    minProfitPct: number;
    minGainCents: number;
    minProfitUsd: number;
    lowPriceThreshold: number;
  };
  stack: {
    enabled: boolean;
    minGainCents: number;
    maxUsd: number;
    maxPrice: number;
  };
  endgame: {
    enabled: boolean;
    minPrice: number;
    maxPrice: number;
    maxUsd: number;
  };
  redeem: {
    enabled: boolean;
    intervalMin: number;
    minPositionUsd: number;
  };
  copy: {
    multiplier: number;
    minUsd: number;
    maxUsd: number;
    minBuyPrice: number;
  };
  arb: {
    enabled: boolean;
    maxUsd: number;
    minEdgeBps: number;
  };
  risk: {
    maxDrawdownPct: number;
    maxDailyLossUsd: number;
    maxOpenPositions: number;
    hedgeBuffer: number;
    orderCooldownMs: number;
    maxOrdersPerHour: number;
  };
  polReserve: {
    enabled: boolean;
    targetPol: number;
    minPol: number;
    maxSwapUsd: number;
    checkIntervalMin: number;
    slippagePct: number;
  };
  scavenger: {
    enabled: boolean;
  };
  maxPositionUsd: number;
}

export const PRESETS: Record<Preset, PresetConfig> = {
  conservative: {
    autoSell: { enabled: true, threshold: 0.98, minHoldSec: 60 },
    stopLoss: { enabled: true, maxLossPct: 20, minHoldSec: 120 },
    hedge: {
      enabled: true,
      triggerPct: 15,
      maxUsd: 15,
      reservePct: 25,
      allowExceedMax: false,
      absoluteMaxUsd: 25,
    },
    scalp: {
      enabled: true,
      minProfitPct: 15,
      minGainCents: 8,
      minProfitUsd: 2.0,
      lowPriceThreshold: 0,
    },
    stack: { enabled: true, minGainCents: 25, maxUsd: 15, maxPrice: 0.9 },
    endgame: { enabled: true, minPrice: 0.9, maxPrice: 0.98, maxUsd: 15 },
    redeem: { enabled: true, intervalMin: 15, minPositionUsd: 0.1 },
    copy: { multiplier: 1.0, minUsd: 5, maxUsd: 50, minBuyPrice: 0.5 },
    arb: { enabled: true, maxUsd: 15, minEdgeBps: 50 },
    risk: {
      maxDrawdownPct: 15,
      maxDailyLossUsd: 50,
      maxOpenPositions: 50,
      hedgeBuffer: 5,
      orderCooldownMs: 2000,
      maxOrdersPerHour: 100,
    },
    polReserve: {
      enabled: true,
      targetPol: 50,
      minPol: 10,
      maxSwapUsd: 100,
      checkIntervalMin: 5,
      slippagePct: 1,
    },
    scavenger: { enabled: true },
    maxPositionUsd: 15,
  },
  balanced: {
    autoSell: { enabled: true, threshold: 0.99, minHoldSec: 60 },
    stopLoss: { enabled: true, maxLossPct: 25, minHoldSec: 60 },
    hedge: {
      enabled: true,
      triggerPct: 20,
      maxUsd: 25,
      reservePct: 20,
      allowExceedMax: false,
      absoluteMaxUsd: 50,
    },
    scalp: {
      enabled: true,
      minProfitPct: 10,
      minGainCents: 5,
      minProfitUsd: 1.0,
      lowPriceThreshold: 0,
    },
    stack: { enabled: true, minGainCents: 20, maxUsd: 25, maxPrice: 0.95 },
    endgame: { enabled: true, minPrice: 0.85, maxPrice: 0.99, maxUsd: 25 },
    redeem: { enabled: true, intervalMin: 15, minPositionUsd: 0.1 },
    copy: { multiplier: 1.0, minUsd: 5, maxUsd: 100, minBuyPrice: 0.5 },
    arb: { enabled: true, maxUsd: 25, minEdgeBps: 30 },
    risk: {
      maxDrawdownPct: 20,
      maxDailyLossUsd: 100,
      maxOpenPositions: 100,
      hedgeBuffer: 10,
      orderCooldownMs: 1000,
      maxOrdersPerHour: 200,
    },
    polReserve: {
      enabled: true,
      targetPol: 50,
      minPol: 10,
      maxSwapUsd: 100,
      checkIntervalMin: 5,
      slippagePct: 1,
    },
    scavenger: { enabled: true },
    maxPositionUsd: 25,
  },
  aggressive: {
    autoSell: { enabled: true, threshold: 0.995, minHoldSec: 30 },
    stopLoss: { enabled: true, maxLossPct: 35, minHoldSec: 30 },
    hedge: {
      enabled: true,
      triggerPct: 25,
      maxUsd: 50,
      reservePct: 15,
      allowExceedMax: true,
      absoluteMaxUsd: 100,
    },
    scalp: {
      enabled: true,
      minProfitPct: 5,
      minGainCents: 3,
      minProfitUsd: 0.5,
      lowPriceThreshold: 0,
    },
    stack: { enabled: true, minGainCents: 15, maxUsd: 50, maxPrice: 0.97 },
    endgame: { enabled: true, minPrice: 0.8, maxPrice: 0.995, maxUsd: 50 },
    redeem: { enabled: true, intervalMin: 10, minPositionUsd: 0.01 },
    copy: { multiplier: 1.0, minUsd: 5, maxUsd: 200, minBuyPrice: 0.5 },
    arb: { enabled: true, maxUsd: 50, minEdgeBps: 20 },
    risk: {
      maxDrawdownPct: 30,
      maxDailyLossUsd: 200,
      maxOpenPositions: 200,
      hedgeBuffer: 20,
      orderCooldownMs: 500,
      maxOrdersPerHour: 500,
    },
    polReserve: {
      enabled: true,
      targetPol: 50,
      minPol: 10,
      maxSwapUsd: 100,
      checkIntervalMin: 5,
      slippagePct: 1,
    },
    scavenger: { enabled: true },
    maxPositionUsd: 50,
  },
};

export function loadPreset(): { name: Preset; config: PresetConfig } {
  const name = (process.env.STRATEGY_PRESET ??
    process.env.PRESET ??
    "balanced") as Preset;
  if (!PRESETS[name]) {
    console.warn(`Unknown preset "${name}", using "balanced"`);
    return { name: "balanced", config: PRESETS.balanced };
  }
  return { name, config: PRESETS[name] };
}

export function getMaxPositionUsd(preset: PresetConfig): number {
  const env = process.env.MAX_POSITION_USD ?? process.env.ARB_MAX_POSITION_USD;
  if (env) {
    const val = parseFloat(env);
    if (!isNaN(val) && val > 0) return val;
  }
  return preset.maxPositionUsd;
}
