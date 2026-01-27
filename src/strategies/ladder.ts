/**
 * APEX LADDER - Partial Exit Strategy
 * 
 * Scales out of positions at profit milestones
 */

import type { Position } from "../lib/types";

export interface LadderSignal {
  position: Position;
  exitPct: number; // Percentage of position to exit
  milestone: number; // Profit milestone reached
  reason: string;
}

export interface LadderConfig {
  milestones: { profitPct: number; exitPct: number }[];
}

/**
 * Default ladder configuration
 * Exit in stages as profit increases
 */
export const DEFAULT_LADDER: LadderConfig = {
  milestones: [
    { profitPct: 15, exitPct: 25 }, // At 15% profit, sell 25%
    { profitPct: 25, exitPct: 25 }, // At 25% profit, sell another 25%
    { profitPct: 40, exitPct: 25 }, // At 40% profit, sell another 25%
    { profitPct: 60, exitPct: 25 }, // At 60% profit, sell final 25%
  ],
};

export interface LadderState {
  tokenId: string;
  exitedPct: number; // Total percentage already exited
  lastMilestone: number;
  exitHistory: { timestamp: number; profitPct: number; exitPct: number }[];
}

/**
 * Check for ladder exit opportunities
 */
export function detectLadder(
  position: Position,
  state: LadderState | null,
  config: LadderConfig = DEFAULT_LADDER,
): LadderSignal | null {
  const currentState = state || {
    tokenId: position.tokenId,
    exitedPct: 0,
    lastMilestone: 0,
    exitHistory: [],
  };

  // Find next milestone
  const nextMilestone = config.milestones.find(
    (m) => m.profitPct > currentState.lastMilestone && position.pnlPct >= m.profitPct,
  );

  if (nextMilestone) {
    // Check if we have enough position left
    const remainingPct = 100 - currentState.exitedPct;
    if (remainingPct >= nextMilestone.exitPct) {
      return {
        position,
        exitPct: nextMilestone.exitPct,
        milestone: nextMilestone.profitPct,
        reason: `APEX Ladder: ${nextMilestone.profitPct}% profit milestone, selling ${nextMilestone.exitPct}% (${remainingPct}% remains)`,
      };
    }
  }

  return null;
}

/**
 * Update ladder state after exit
 */
export function updateLadderState(
  state: LadderState,
  exitPct: number,
  profitPct: number,
): LadderState {
  return {
    ...state,
    exitedPct: state.exitedPct + exitPct,
    lastMilestone: profitPct,
    exitHistory: [
      ...state.exitHistory,
      {
        timestamp: Date.now(),
        profitPct,
        exitPct,
      },
    ],
  };
}

/**
 * Calculate partial position size to sell
 */
export function calculatePartialSize(position: Position, exitPct: number): number {
  return position.size * (exitPct / 100);
}

/**
 * Get ladder progress summary
 */
export function getLadderProgress(state: LadderState | null): string {
  if (!state || state.exitedPct === 0) {
    return "No exits yet";
  }

  const exits = state.exitHistory.length;
  return `${exits} ladder exit(s), ${state.exitedPct.toFixed(0)}% total exited`;
}
