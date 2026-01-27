/**
 * APEX AMPLIFIER - Stacking Strategy
 * 
 * Adds to winning positions to amplify gains
 */

import type { Position } from "../lib/types";

export interface AmplifierSignal {
  position: Position;
  stackSize: number;
  confidence: number;
  reason: string;
}

/**
 * Detect stacking opportunities
 */
export function detectAmplifier(
  position: Position,
  maxStackSize: number,
  alreadyStacked: boolean = false,
): AmplifierSignal | null {
  // Don't stack if already stacked
  if (alreadyStacked) return null;

  // Must be winning with good momentum
  if (position.pnlPct < 15 || position.gainCents < 20) return null;

  // Don't stack positions near ceiling
  if (position.curPrice >= 0.95) return null;

  // Check for continued momentum
  const history = position.priceHistory;
  if (!history || history.length < 3) return null;

  const hasMomentum =
    history[history.length - 1] >
    history[history.length - 3];

  if (!hasMomentum) return null;

  // Stack size: 50% of original position value, capped at max
  const stackSize = Math.min(maxStackSize, position.value * 0.5);
  const confidence = Math.min(100, position.pnlPct * 3);

  return {
    position,
    stackSize,
    confidence,
    reason: `APEX Amplifier: ${position.pnlPct.toFixed(1)}% gain, momentum continuing`,
  };
}

/**
 * Check if position is safe to stack
 */
export function isSafeToStack(
  position: Position,
  totalExposure: number,
  maxExposure: number,
): boolean {
  // Don't stack if would exceed max exposure
  const wouldExceed = totalExposure + position.value * 0.5 > maxExposure;
  if (wouldExceed) return false;

  // Don't stack red positions
  if (position.pnlPct < 0) return false;

  // Don't stack volatile positions
  if (position.priceHistory && position.priceHistory.length >= 5) {
    const prices = position.priceHistory.slice(-5);
    const maxPrice = Math.max(...prices);
    const minPrice = Math.min(...prices);
    
    // Protect against division by zero
    if (minPrice === 0) return false;
    
    const volatility = (maxPrice - minPrice) / minPrice;

    // Too volatile
    if (volatility > 0.2) return false;
  }

  return true;
}
