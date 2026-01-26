/**
 * APEX CLOSER - Endgame Strategy
 * 
 * Trades markets approaching resolution with lower risk
 */

import type { Position } from "../lib/types";

export interface CloserSignal {
  tokenId: string;
  conditionId: string;
  marketId?: string;
  outcome: "YES" | "NO";
  hoursToClose: number;
  confidence: number;
  reason: string;
}

/**
 * Detect endgame opportunities
 */
export function detectCloser(
  marketEndTime: number | undefined,
  currentPrice: number,
  outcome: "YES" | "NO",
  tokenId: string,
  conditionId: string,
  marketId?: string,
): CloserSignal | null {
  if (!marketEndTime) return null;

  const hoursToClose = (marketEndTime - Date.now()) / (1000 * 60 * 60);

  // Only trade markets closing in 1-24 hours
  if (hoursToClose < 1 || hoursToClose > 24) return null;

  // Look for high-confidence endgame opportunities
  // If YES is >80¢, it's likely resolving YES
  // If NO is >80¢, it's likely resolving NO
  if (currentPrice > 0.8) {
    const confidence = Math.min(100, (currentPrice - 0.8) * 500);

    return {
      tokenId,
      conditionId,
      marketId,
      outcome,
      hoursToClose,
      confidence,
      reason: `APEX Closer: ${(currentPrice * 100).toFixed(0)}¢, closes in ${hoursToClose.toFixed(1)}h`,
    };
  }

  return null;
}

/**
 * Check if position should be exited before market close
 */
export function shouldExitBeforeClose(
  position: Position,
  hoursBeforeClose: number = 1,
): boolean {
  if (!position.marketEndTime) return false;

  const hoursToClose = (position.marketEndTime - Date.now()) / (1000 * 60 * 60);

  // Force exit if market closing soon and position isn't highly profitable
  if (hoursToClose <= hoursBeforeClose && position.pnlPct < 50) {
    return true;
  }

  return false;
}

/**
 * Calculate risk-adjusted position size for closer
 */
export function calculateCloserSize(
  baseSize: number,
  hoursToClose: number,
  price: number,
): number {
  // Closer uses 80% of normal size (lower risk)
  let size = baseSize * 0.8;

  // Reduce size for closer events (less time to profit)
  if (hoursToClose < 6) {
    size *= 0.7;
  }

  // Reduce size for expensive positions (less upside)
  if (price > 0.85) {
    size *= 0.6;
  }

  return size;
}
