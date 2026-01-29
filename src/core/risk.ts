/**
 * Risk Management
 *
 * Position sizing and risk control utilities.
 * Implements the Kelly-inspired EV-based position sizing.
 */

import type { Position } from "../models";

/**
 * Risk parameters for position sizing
 */
export interface RiskParams {
  /** Maximum trade size in USD */
  maxTradeUsd: number;

  /** Minimum trade size in USD */
  minTradeUsd: number;

  /** Fraction of bankroll per trade (0-1) */
  tradeFraction: number;

  /** Maximum fraction deployed across all positions (0-1) */
  maxDeployedFraction: number;

  /** Maximum number of open positions */
  maxOpenPositions: number;

  /** Maximum positions per market */
  maxPositionsPerMarket: number;

  /** Reserve fraction (0-1) */
  reserveFraction: number;

  /** Minimum reserve in USD */
  minReserveUsd: number;
}

/**
 * Calculate the effective bankroll after reserves
 */
export function calculateEffectiveBankroll(
  walletBalance: number,
  params: RiskParams,
): { effectiveBankroll: number; reserveUsd: number } {
  const reserveUsd = Math.max(
    walletBalance * params.reserveFraction,
    params.minReserveUsd,
  );
  const effectiveBankroll = Math.max(0, walletBalance - reserveUsd);
  return { effectiveBankroll, reserveUsd };
}

/**
 * Calculate the optimal trade size based on bankroll and risk params
 */
export function calculateTradeSize(
  effectiveBankroll: number,
  params: RiskParams,
): number {
  const fractionalSize = effectiveBankroll * params.tradeFraction;
  // Apply both min and max bounds:
  // - First ensure we don't go below minTradeUsd (for small bankrolls)
  // - Then cap at maxTradeUsd (for large bankrolls)
  // If effectiveBankroll is too small to meet minTradeUsd, use fractionalSize
  // to avoid over-leveraging (can't trade more than we can afford)
  const withMinimum = Math.max(fractionalSize, Math.min(params.minTradeUsd, effectiveBankroll));
  return Math.min(withMinimum, params.maxTradeUsd);
}

/**
 * Check if a new position would exceed risk limits
 */
export function checkPositionLimits(
  currentPositions: Position[],
  tokenId: string,
  params: RiskParams,
): { allowed: boolean; reason?: string } {
  // Check total position count
  if (currentPositions.length >= params.maxOpenPositions) {
    return {
      allowed: false,
      reason: `Max positions reached (${params.maxOpenPositions})`,
    };
  }

  // Check positions per market (by token)
  const positionsForToken = currentPositions.filter(
    (p) => p.tokenId === tokenId,
  );
  if (positionsForToken.length >= params.maxPositionsPerMarket) {
    return {
      allowed: false,
      reason: `Max positions per market reached (${params.maxPositionsPerMarket})`,
    };
  }

  return { allowed: true };
}

/**
 * Calculate total deployed capital across positions
 */
export function calculateDeployedCapital(positions: Position[]): number {
  return positions.reduce((sum, p) => sum + p.value, 0);
}

/**
 * Check if deployed capital would exceed limits
 */
export function checkDeploymentLimits(
  currentPositions: Position[],
  newTradeUsd: number,
  effectiveBankroll: number,
  maxDeployedFraction: number,
): { allowed: boolean; reason?: string } {
  const currentDeployed = calculateDeployedCapital(currentPositions);
  const maxDeployed = effectiveBankroll * maxDeployedFraction;

  if (currentDeployed + newTradeUsd > maxDeployed) {
    return {
      allowed: false,
      reason: `Would exceed max deployed (${currentDeployed + newTradeUsd} > ${maxDeployed})`,
    };
  }

  return { allowed: true };
}
