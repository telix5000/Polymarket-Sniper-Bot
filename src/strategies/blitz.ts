/**
 * APEX BLITZ - Quick Scalp Exit Strategy
 * 
 * Takes fast profits at 10%+ gains
 */

import type { Position } from "../lib/types";

export interface BlitzSignal {
  position: Position;
  reason: string;
  urgency: "LOW" | "MEDIUM" | "HIGH";
}

/**
 * Detect quick scalp opportunities
 */
export function detectBlitz(
  position: Position,
  minProfitPct: number = 10,
  minGainCents: number = 5,
): BlitzSignal | null {
  // Must be profitable
  if (position.pnlPct < minProfitPct || position.gainCents < minGainCents) {
    return null;
  }

  // Quick profit opportunity
  const holdTime = position.entryTime ? Date.now() - position.entryTime : 0;
  const holdMinutes = holdTime / (1000 * 60);

  let urgency: "LOW" | "MEDIUM" | "HIGH" = "LOW";

  if (position.pnlPct >= 25) {
    urgency = "HIGH"; // Huge gain, take it now!
  } else if (position.pnlPct >= 15 || holdMinutes < 30) {
    urgency = "MEDIUM"; // Good gain or quick flip
  }

  return {
    position,
    reason: `APEX Blitz: ${position.pnlPct.toFixed(1)}% profit in ${holdMinutes.toFixed(0)}min`,
    urgency,
  };
}

/**
 * Check if profit is at risk of evaporating
 */
export function isProfitAtRisk(position: Position): boolean {
  // Profit at risk if price is near extremes
  if (position.curPrice >= 0.95 && position.outcome === "YES") {
    return true; // YES at 95¢+, take profit before ceiling
  }

  if (position.curPrice <= 0.05 && position.outcome === "NO") {
    return true; // NO at 5¢-, take profit before floor
  }

  // Price history shows reversal
  if (position.priceHistory && position.priceHistory.length >= 3) {
    const recent = position.priceHistory.slice(-3);
    const isReversal = recent[0] < recent[1] && recent[1] > recent[2];
    return isReversal && position.pnlPct > 5;
  }

  return false;
}

/**
 * Prioritize Blitz exits by urgency
 */
export function prioritizeBlitzExits(signals: BlitzSignal[]): BlitzSignal[] {
  const urgencyOrder = { HIGH: 3, MEDIUM: 2, LOW: 1 };
  return signals.sort((a, b) => urgencyOrder[b.urgency] - urgencyOrder[a.urgency]);
}
