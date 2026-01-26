/**
 * APEX FIREWALL - Circuit Breaker Module
 * 
 * Prevents excessive spending and enforces limits
 */

import type { ModeConfig } from "../core/modes";

export interface FirewallStatus {
  allowed: boolean;
  reason: string;
  currentExposure: number;
  maxExposure: number;
  drawdown: number;
  drawdownLimit: number;
}

/**
 * Check if trade is allowed by firewall
 */
export function checkFirewall(
  currentExposure: number,
  proposedTradeSize: number,
  balance: number,
  startBalance: number,
  mode: ModeConfig,
): FirewallStatus {
  const maxExposure = balance * (mode.maxExposurePct / 100);
  const newExposure = currentExposure + proposedTradeSize;

  // Check exposure limit
  if (newExposure > maxExposure) {
    return {
      allowed: false,
      reason: `Firewall: Exposure limit (${newExposure.toFixed(2)} > ${maxExposure.toFixed(2)})`,
      currentExposure,
      maxExposure,
      drawdown: 0,
      drawdownLimit: mode.drawdownHaltPct,
    };
  }

  // Check drawdown limit
  const drawdown = ((startBalance - balance) / startBalance) * 100;
  if (drawdown > mode.drawdownHaltPct) {
    return {
      allowed: false,
      reason: `Firewall: Drawdown halt (${drawdown.toFixed(1)}% > ${mode.drawdownHaltPct}%)`,
      currentExposure,
      maxExposure,
      drawdown,
      drawdownLimit: mode.drawdownHaltPct,
    };
  }

  // All checks passed
  return {
    allowed: true,
    reason: "Trade approved",
    currentExposure,
    maxExposure,
    drawdown,
    drawdownLimit: mode.drawdownHaltPct,
  };
}

/**
 * Calculate current exposure from positions
 */
export function calculateExposure(positions: Array<{ value: number }>): number {
  return positions.reduce((sum, p) => sum + p.value, 0);
}

/**
 * Check if system should halt trading entirely
 */
export function shouldHaltTrading(
  balance: number,
  startBalance: number,
  mode: ModeConfig,
): { halt: boolean; reason: string } {
  // Halt if drawdown exceeds limit
  const drawdown = ((startBalance - balance) / startBalance) * 100;
  if (drawdown > mode.drawdownHaltPct) {
    return {
      halt: true,
      reason: `CIRCUIT BREAKER: ${drawdown.toFixed(1)}% drawdown exceeds ${mode.drawdownHaltPct}% limit`,
    };
  }

  // Halt if balance too low
  if (balance < 50) {
    return {
      halt: true,
      reason: `CIRCUIT BREAKER: Balance too low ($${balance.toFixed(2)})`,
    };
  }

  return { halt: false, reason: "" };
}

/**
 * Get firewall status summary
 */
export function getFirewallSummary(
  currentExposure: number,
  maxExposure: number,
  balance: number,
  startBalance: number,
): string {
  const exposurePct = (currentExposure / maxExposure) * 100;
  const drawdown = ((startBalance - balance) / startBalance) * 100;

  return [
    `🔥 FIREWALL STATUS`,
    `Exposure: $${currentExposure.toFixed(2)} / $${maxExposure.toFixed(2)} (${exposurePct.toFixed(1)}%)`,
    `Drawdown: ${drawdown.toFixed(1)}%`,
  ].join("\n");
}
