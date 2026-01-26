/**
 * APEX GUARDIAN - Stop Loss Protection Module
 * 
 * Hard stop-loss protection for positions
 */

import type { Position } from "../lib/types";

export interface GuardianSignal {
  position: Position;
  stopLossPct: number;
  reason: string;
}

/**
 * Detect positions hitting stop-loss
 */
export function detectGuardian(
  position: Position,
  maxLossPct: number = 25,
  hedgingEnabled: boolean = false,
): GuardianSignal | null {
  // Skip if hedging is handling losses
  if (hedgingEnabled) return null;

  // Check if stop-loss triggered
  if (position.pnlPct < 0 && Math.abs(position.pnlPct) >= maxLossPct) {
    return {
      position,
      stopLossPct: Math.abs(position.pnlPct),
      reason: `APEX Guardian: Stop-loss ${Math.abs(position.pnlPct).toFixed(1)}% (max ${maxLossPct}%)`,
    };
  }

  return null;
}

/**
 * Calculate dynamic stop-loss based on position characteristics
 */
export function calculateDynamicStopLoss(
  position: Position,
  baseStopLoss: number = 25,
): number {
  // Tighter stop for positions near extremes (less likely to recover)
  if (position.curPrice < 0.1 || position.curPrice > 0.9) {
    return baseStopLoss * 0.6; // 15% for extreme positions
  }

  // Standard stop for mid-range positions
  return baseStopLoss;
}

/**
 * Check if position is in danger zone
 */
export function isInDangerZone(position: Position, warningPct: number = 15): boolean {
  return position.pnlPct < 0 && Math.abs(position.pnlPct) >= warningPct;
}
