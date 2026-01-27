/**
 * APEX SENTINEL - Emergency Exit Module
 * 
 * Forces position exits when markets are closing soon
 */

import type { Position } from "../lib/types";

export interface SentinelSignal {
  position: Position;
  minutesToClose: number;
  reason: string;
  force: boolean; // If true, must exit regardless of P&L
}

/**
 * Detect emergency exit situations
 */
export function detectSentinel(
  position: Position,
  emergencyMinutes: number = 5,
): SentinelSignal | null {
  if (!position.marketEndTime) return null;

  const minutesToClose = (position.marketEndTime - Date.now()) / (1000 * 60);

  // Emergency exit if market closing very soon
  if (minutesToClose <= emergencyMinutes) {
    return {
      position,
      minutesToClose,
      reason: `APEX Sentinel: EMERGENCY - Market closes in ${minutesToClose.toFixed(1)} minutes!`,
      force: true,
    };
  }

  // Warning exit for positions not highly profitable
  if (minutesToClose <= 15 && position.pnlPct < 30) {
    return {
      position,
      minutesToClose,
      reason: `APEX Sentinel: Market closes in ${minutesToClose.toFixed(0)} minutes (${position.pnlPct.toFixed(1)}% P&L)`,
      force: false,
    };
  }

  return null;
}

/**
 * Calculate urgency level
 */
export function getSentinelUrgency(minutesToClose: number): "CRITICAL" | "HIGH" | "MEDIUM" {
  if (minutesToClose <= 5) return "CRITICAL";
  if (minutesToClose <= 15) return "HIGH";
  return "MEDIUM";
}

/**
 * Check if should force exit regardless of loss
 */
export function shouldForceExit(minutesToClose: number, pnlPct: number): boolean {
  // Force exit if:
  // 1. Less than 5 minutes
  // 2. OR less than 10 minutes and losing >20%
  if (minutesToClose <= 5) return true;
  if (minutesToClose <= 10 && pnlPct < -20) return true;

  return false;
}
