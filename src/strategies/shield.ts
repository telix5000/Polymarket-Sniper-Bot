/**
 * APEX SHIELD - Hedging Protection Module
 * 
 * Protects losing positions with intelligent hedging
 * Critical fixes: hedge stop-loss and take-profit
 */

import type { Position } from "../lib/types";

export interface ShieldSignal {
  position: Position;
  hedgeOutcome: "YES" | "NO";
  hedgeSize: number;
  reason: string;
}

export interface HedgeState {
  tokenId: string;
  originalPosition: Position;
  hedgeCreated: number;
  hedgeOutcome: "YES" | "NO";
  hedgeSize: number;
  hedgeAvgPrice: number;
}

/**
 * Detect positions needing hedge protection
 */
export function detectShield(
  position: Position,
  isAlreadyHedged: boolean,
  triggerPct: number = 20,
  maxHedgeSize: number = 50,
): ShieldSignal | null {
  // Don't hedge hedges!
  if (isAlreadyHedged) return null;

  // Only hedge significant losses
  if (position.pnlPct >= 0 || Math.abs(position.pnlPct) < triggerPct) return null;

  // Don't hedge positions near floor/ceiling (too late)
  if (position.curPrice < 0.05 || position.curPrice > 0.95) return null;

  // Determine opposite outcome
  const opposite = position.outcome === "YES" ? "NO" : "YES";
  const hedgeSize = Math.min(maxHedgeSize, position.value * 0.5);

  return {
    position,
    hedgeOutcome: opposite,
    hedgeSize,
    reason: `APEX Shield: ${position.pnlPct.toFixed(1)}% loss, hedge ${opposite}`,
  };
}

/**
 * CRITICAL FIX: Check if hedge needs stop-loss
 * Exit hedge if losing 5%+
 */
export function shouldStopHedge(hedge: Position): boolean {
  return hedge.pnlPct < -5;
}

/**
 * CRITICAL FIX: Check if hedge needs take-profit
 * Exit hedge if winning 15%+
 */
export function shouldTakeProfitHedge(hedge: Position): boolean {
  return hedge.pnlPct >= 15;
}

/**
 * Check if original position recovered (can exit hedge)
 */
export function hasPositionRecovered(
  originalPosition: Position,
  hedgeState: HedgeState,
): boolean {
  // If original position is now green or slightly red, hedge worked
  return originalPosition.pnlPct > -5;
}

/**
 * Calculate net P&L including hedge
 */
export function calculateNetPnL(
  originalPosition: Position,
  hedgePosition: Position | null,
): number {
  if (!hedgePosition) return originalPosition.pnlUsd;

  return originalPosition.pnlUsd + hedgePosition.pnlUsd;
}
