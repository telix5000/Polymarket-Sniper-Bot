/**
 * APEX COMMAND - Portfolio Manager Module
 * 
 * Manages overall portfolio and auto-sells positions near $1
 */

import type { Position } from "../lib/types";

export interface CommandSignal {
  position: Position;
  action: "AUTO_SELL" | "REBALANCE" | "EXIT_OVERSIZED";
  reason: string;
}

/**
 * Detect auto-sell opportunities (positions near $1)
 */
export function detectAutoSell(
  position: Position,
  threshold: number = 0.99,
): CommandSignal | null {
  if (position.curPrice >= threshold) {
    return {
      position,
      action: "AUTO_SELL",
      reason: `APEX Command: Auto-sell at ${(position.curPrice * 100).toFixed(0)}¢`,
    };
  }

  return null;
}

/**
 * Detect oversized positions that need reduction
 */
export function detectOversized(
  position: Position,
  maxPositionSize: number,
): CommandSignal | null {
  if (position.value > maxPositionSize * 1.5) {
    return {
      position,
      action: "EXIT_OVERSIZED",
      reason: `APEX Command: Oversized position $${position.value.toFixed(2)} (max $${maxPositionSize.toFixed(2)})`,
    };
  }

  return null;
}

/**
 * Calculate portfolio health metrics
 */
export interface PortfolioHealth {
  totalPositions: number;
  totalValue: number;
  greenPositions: number;
  redPositions: number;
  avgPnL: number;
  largestPosition: number;
  riskScore: number; // 0-100, higher = more risk
}

export function assessPortfolioHealth(positions: Position[]): PortfolioHealth {
  const greenPositions = positions.filter((p) => p.pnlPct > 0).length;
  const redPositions = positions.length - greenPositions;

  const totalValue = positions.reduce((sum, p) => sum + p.value, 0);
  const avgPnL = positions.reduce((sum, p) => sum + p.pnlPct, 0) / (positions.length || 1);
  const largestPosition = Math.max(...positions.map((p) => p.value), 0);

  // Risk score calculation
  let riskScore = 0;
  riskScore += (redPositions / (positions.length || 1)) * 40; // 40% weight on losing positions
  riskScore += Math.min(30, positions.length / 20 * 30); // 30% weight on position count
  riskScore += (largestPosition / totalValue) * 30; // 30% weight on concentration

  return {
    totalPositions: positions.length,
    totalValue,
    greenPositions,
    redPositions,
    avgPnL,
    largestPosition,
    riskScore: Math.min(100, riskScore),
  };
}

/**
 * Determine if portfolio rebalancing is needed
 */
export function needsRebalancing(health: PortfolioHealth): boolean {
  // Rebalance if:
  // 1. Too many positions (>20)
  // 2. High risk score (>70)
  // 3. Too concentrated (largest >50% of total)
  if (health.totalPositions > 20) return true;
  if (health.riskScore > 70) return true;
  if (health.largestPosition > health.totalValue * 0.5) return true;

  return false;
}

/**
 * Get recommended actions for portfolio optimization
 */
export function getRebalancingActions(
  positions: Position[],
  health: PortfolioHealth,
): CommandSignal[] {
  const actions: CommandSignal[] = [];

  // Exit worst performers if too many positions
  if (health.totalPositions > 20) {
    const worst = [...positions]
      .filter((p) => p.pnlPct < 0)
      .sort((a, b) => a.pnlPct - b.pnlPct)
      .slice(0, 5);

    for (const pos of worst) {
      actions.push({
        position: pos,
        action: "REBALANCE",
        reason: `APEX Command: Exit underperformer (${pos.pnlPct.toFixed(1)}% P&L)`,
      });
    }
  }

  return actions;
}
