/**
 * APEX RATCHET - Trailing Stop Strategy
 * 
 * Dynamically adjusts stop-loss as position gains profit
 */

import type { Position } from "../lib/types";

export interface RatchetSignal {
  position: Position;
  stopPrice: number;
  trailingPct: number;
  reason: string;
}

export interface RatchetState {
  tokenId: string;
  highWaterMark: number; // Best price achieved
  stopPrice: number;
  lastUpdate: number;
}

/**
 * Create or update ratchet state
 */
export function updateRatchet(
  position: Position,
  existingState: RatchetState | null,
  trailingPct: number = 5,
): RatchetState {
  const currentPrice = position.curPrice;

  if (!existingState) {
    // Initialize ratchet
    return {
      tokenId: position.tokenId,
      highWaterMark: currentPrice,
      stopPrice: currentPrice * (1 - trailingPct / 100),
      lastUpdate: Date.now(),
    };
  }

  // Update high water mark if price increased
  const newHighWaterMark = Math.max(existingState.highWaterMark, currentPrice);
  const newStopPrice = newHighWaterMark * (1 - trailingPct / 100);

  return {
    ...existingState,
    highWaterMark: newHighWaterMark,
    stopPrice: Math.max(existingState.stopPrice, newStopPrice), // Stop never goes down
    lastUpdate: Date.now(),
  };
}

/**
 * Check if ratchet stop triggered
 */
export function isRatchetTriggered(
  position: Position,
  ratchetState: RatchetState,
): RatchetSignal | null {
  if (position.curPrice <= ratchetState.stopPrice) {
    const gainFromEntry = ((position.curPrice - position.avgPrice) / position.avgPrice) * 100;

    return {
      position,
      stopPrice: ratchetState.stopPrice,
      trailingPct: ((ratchetState.highWaterMark - ratchetState.stopPrice) / ratchetState.highWaterMark) * 100,
      reason: `APEX Ratchet: Price ${(position.curPrice * 100).toFixed(0)}¢ hit stop ${(ratchetState.stopPrice * 100).toFixed(0)}¢ (${gainFromEntry.toFixed(1)}% locked)`,
    };
  }

  return null;
}

/**
 * Calculate optimal trailing percentage based on volatility
 */
export function calculateOptimalTrailing(position: Position): number {
  if (!position.priceHistory || position.priceHistory.length < 5) {
    return 5; // Default 5%
  }

  // Calculate volatility from price history
  const prices = position.priceHistory.slice(-10);
  
  // Protect against division by zero
  if (prices.length === 0) return 5; // Default trailing stop
  
  const avgPrice = prices.reduce((sum, p) => sum + p, 0) / prices.length;
  const variance = prices.reduce((sum, p) => sum + Math.pow(p - avgPrice, 2), 0) / prices.length;
  const volatility = Math.sqrt(variance);

  // Higher volatility = wider trailing stop
  if (volatility > 0.1) return 10; // High volatility
  if (volatility > 0.05) return 7; // Medium volatility
  return 5; // Low volatility
}
