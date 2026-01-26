/**
 * APEX REAPER - Scavenger Exit Strategy
 * 
 * Opportunistically exits positions during low liquidity
 * Capital preservation through intelligent position management
 */

import type { Position } from "../lib/types";

export interface ReaperSignal {
  position: Position;
  reason: string;
  priority: "HIGH" | "MEDIUM" | "LOW";
}

export interface ReaperConditions {
  isLowLiquidity: boolean;
  volumeDry: boolean;
  spreadWide: boolean;
  targetInactive: boolean;
}

/**
 * Detect scavenger exit opportunities
 */
export function detectReaper(
  position: Position,
  conditions: ReaperConditions,
): ReaperSignal | null {
  // Not in scavenger mode
  if (!conditions.isLowLiquidity) return null;

  // Green positions - exit opportunistically
  if (position.pnlPct > 1 && position.pnlUsd > 0.5) {
    const priority = position.pnlPct > 5 ? "HIGH" : "MEDIUM";
    return {
      position,
      reason: `APEX Reaper: ${position.pnlPct.toFixed(1)}% profit, low liquidity exit`,
      priority,
    };
  }

  // Red positions - exit on any recovery
  if (position.pnlPct < 0 && position.pnlPct > -15) {
    // Check if showing signs of recovery
    const isRecovering =
      position.priceHistory &&
      position.priceHistory.length >= 2 &&
      position.priceHistory[position.priceHistory.length - 1] >
        position.priceHistory[position.priceHistory.length - 2];

    if (isRecovering) {
      return {
        position,
        reason: `APEX Reaper: Recovery detected (${position.pnlPct.toFixed(1)}%), exit loss`,
        priority: "HIGH",
      };
    }
  }

  return null;
}

/**
 * Check if market conditions warrant scavenger mode
 */
export function shouldEnterScavengerMode(
  volume24h: number,
  orderBookDepth: number,
  activeTargets: number,
  volumeThreshold: number = 1000,
  depthThreshold: number = 500,
  minTargets: number = 1,
): boolean {
  let conditionsMet = 0;

  if (volume24h < volumeThreshold) conditionsMet++;
  if (orderBookDepth < depthThreshold) conditionsMet++;
  if (activeTargets < minTargets) conditionsMet++;

  // Need at least 2 of 3 conditions
  return conditionsMet >= 2;
}

/**
 * Prioritize reaper exits
 */
export function prioritizeReaperExits(signals: ReaperSignal[]): ReaperSignal[] {
  const priorityOrder = { HIGH: 3, MEDIUM: 2, LOW: 1 };
  return signals.sort((a, b) => {
    // First by priority
    const priorityDiff = priorityOrder[b.priority] - priorityOrder[a.priority];
    if (priorityDiff !== 0) return priorityDiff;

    // Then by P&L (best first)
    return b.position.pnlPct - a.position.pnlPct;
  });
}

/**
 * Check if should exit scavenger mode
 */
export function shouldExitScavengerMode(
  volume24h: number,
  orderBookDepth: number,
  activeTargets: number,
  recoveryVolumeThreshold: number = 5000,
  recoveryDepthThreshold: number = 2000,
  recoveryTargets: number = 2,
): boolean {
  // Need all 3 conditions to recover
  return (
    volume24h >= recoveryVolumeThreshold &&
    orderBookDepth >= recoveryDepthThreshold &&
    activeTargets >= recoveryTargets
  );
}
