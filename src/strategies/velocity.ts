/**
 * APEX VELOCITY - Momentum Trading Strategy
 * 
 * Detects and trades price momentum with 12%+ velocity
 */

import type { Position } from "../lib/types";

export interface VelocitySignal {
  tokenId: string;
  conditionId: string;
  marketId?: string;
  outcome: "YES" | "NO";
  momentum: number; // Percentage change
  confidence: number;
  reason: string;
}

/**
 * Calculate price velocity over time window
 */
export function calculateVelocity(
  priceHistory: number[],
  windowMinutes: number = 30,
): number {
  if (priceHistory.length < 2) return 0;

  const oldPrice = priceHistory[0];
  const currentPrice = priceHistory[priceHistory.length - 1];

  return ((currentPrice - oldPrice) / oldPrice) * 100;
}

/**
 * Detect momentum signals
 */
export function detectVelocity(
  position: Position | null,
  priceHistory: number[],
  minVelocity: number = 12,
): VelocitySignal | null {
  const velocity = calculateVelocity(priceHistory, 30);

  if (Math.abs(velocity) >= minVelocity) {
    if (!position) {
      // Entry signal
      const outcome = velocity > 0 ? "YES" : "NO";
      const confidence = Math.min(100, Math.abs(velocity) * 5);

      return {
        tokenId: "", // Will be filled by caller
        conditionId: "",
        outcome,
        momentum: velocity,
        confidence,
        reason: `APEX Velocity: ${velocity.toFixed(1)}% momentum`,
      };
    }
  }

  return null;
}

/**
 * Check if position should ride momentum
 */
export function shouldRideMomentum(position: Position, currentVelocity: number): boolean {
  // Ride momentum if still going strong
  return Math.abs(currentVelocity) >= 8 && position.pnlPct > 5;
}

/**
 * Check if momentum is reversing (exit signal)
 */
export function isMomentumReversing(
  position: Position,
  currentVelocity: number,
): boolean {
  // Exit if momentum reverses or stalls
  const isReversal = Math.sign(currentVelocity) !== Math.sign(position.avgPrice - 0.5);
  const isStalling = Math.abs(currentVelocity) < 3;

  return (isReversal || isStalling) && position.pnlPct > 3;
}
