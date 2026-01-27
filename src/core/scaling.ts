/**
 * APEX v3.0 - Dynamic Position Scaling
 * 
 * Position Size = Balance × (ModePct / 100) × TierMultiplier × StrategyWeight
 */

import type { ModeConfig } from "./modes";

/**
 * Account Tiers based on balance
 */
export enum AccountTier {
  TIER_1 = "TIER_1", // $100-$500
  TIER_2 = "TIER_2", // $500-$1500
  TIER_3 = "TIER_3", // $1500-$3000
  TIER_4 = "TIER_4", // $3000+
}

export interface TierInfo {
  tier: AccountTier;
  multiplier: number;
  minBalance: number;
  maxBalance: number;
  description: string;
}

export const TIER_CONFIG: Record<AccountTier, TierInfo> = {
  [AccountTier.TIER_1]: {
    tier: AccountTier.TIER_1,
    multiplier: 1.0,
    minBalance: 100,
    maxBalance: 500,
    description: "Entry Level",
  },
  [AccountTier.TIER_2]: {
    tier: AccountTier.TIER_2,
    multiplier: 1.2,
    minBalance: 500,
    maxBalance: 1500,
    description: "Growing",
  },
  [AccountTier.TIER_3]: {
    tier: AccountTier.TIER_3,
    multiplier: 1.4,
    minBalance: 1500,
    maxBalance: 3000,
    description: "Advanced",
  },
  [AccountTier.TIER_4]: {
    tier: AccountTier.TIER_4,
    multiplier: 1.5,
    minBalance: 3000,
    maxBalance: Infinity,
    description: "Elite",
  },
};

/**
 * Strategy Risk Weights
 */
export enum StrategyType {
  VELOCITY = "VELOCITY",     // Momentum
  SHADOW = "SHADOW",         // Copy Trading
  CLOSER = "CLOSER",         // Endgame
  BLITZ = "BLITZ",           // Quick Scalp
  GRINDER = "GRINDER",       // Volume
  AMPLIFIER = "AMPLIFIER",   // Stack
  HUNTER = "HUNTER",         // Active Scanner
}

export interface StrategyWeight {
  type: StrategyType;
  weight: number;
  description: string;
}

export const STRATEGY_WEIGHTS: Record<StrategyType, StrategyWeight> = {
  [StrategyType.VELOCITY]: {
    type: StrategyType.VELOCITY,
    weight: 1.3,
    description: "Momentum - High Risk/Reward",
  },
  [StrategyType.SHADOW]: {
    type: StrategyType.SHADOW,
    weight: 1.0,
    description: "Copy Trading - Moderate Risk",
  },
  [StrategyType.CLOSER]: {
    type: StrategyType.CLOSER,
    weight: 0.8,
    description: "Endgame - Lower Risk",
  },
  [StrategyType.BLITZ]: {
    type: StrategyType.BLITZ,
    weight: 0.5,
    description: "Quick Scalp - Very Low Risk",
  },
  [StrategyType.GRINDER]: {
    type: StrategyType.GRINDER,
    weight: 0.6,
    description: "Volume Trading - Low Risk",
  },
  [StrategyType.AMPLIFIER]: {
    type: StrategyType.AMPLIFIER,
    weight: 1.2,
    description: "Stacking - High Risk",
  },
  [StrategyType.HUNTER]: {
    type: StrategyType.HUNTER,
    weight: 1.1,
    description: "Active Scanner - Moderate-High Risk",
  },
};

/**
 * Determine account tier from balance
 */
export function getAccountTier(balance: number): TierInfo {
  if (balance >= TIER_CONFIG[AccountTier.TIER_4].minBalance) {
    return TIER_CONFIG[AccountTier.TIER_4];
  }
  if (balance >= TIER_CONFIG[AccountTier.TIER_3].minBalance) {
    return TIER_CONFIG[AccountTier.TIER_3];
  }
  if (balance >= TIER_CONFIG[AccountTier.TIER_2].minBalance) {
    return TIER_CONFIG[AccountTier.TIER_2];
  }
  return TIER_CONFIG[AccountTier.TIER_1];
}

/**
 * Calculate position size based on balance, mode, tier, and strategy
 */
export function calculatePositionSize(
  balance: number,
  mode: ModeConfig,
  strategy: StrategyType,
): number {
  const tier = getAccountTier(balance);
  const strategyWeight = STRATEGY_WEIGHTS[strategy];

  const positionSize =
    balance * (mode.basePositionPct / 100) * tier.multiplier * strategyWeight.weight;

  return Math.max(5, positionSize); // Minimum $5 position
}

/**
 * Calculate max total exposure
 */
export function calculateMaxExposure(balance: number, mode: ModeConfig): number {
  return balance * (mode.maxExposurePct / 100);
}

/**
 * Get scaling info for display
 */
export interface ScalingInfo {
  balance: number;
  tier: TierInfo;
  mode: ModeConfig;
  basePositionSize: number;
  maxExposure: number;
  strategyPositions: Record<StrategyType, number>;
}

export function getScalingInfo(balance: number, mode: ModeConfig): ScalingInfo {
  const tier = getAccountTier(balance);
  const basePositionSize = balance * (mode.basePositionPct / 100) * tier.multiplier;
  const maxExposure = calculateMaxExposure(balance, mode);

  const strategyPositions = {} as Record<StrategyType, number>;
  for (const strategyType of Object.values(StrategyType)) {
    strategyPositions[strategyType] = calculatePositionSize(balance, mode, strategyType);
  }

  return {
    balance,
    tier,
    mode,
    basePositionSize,
    maxExposure,
    strategyPositions,
  };
}
