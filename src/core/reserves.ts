/**
 * APEX v3.0 - Intelligent Reserve Calculator
 * 
 * Calculates actual reserve needs instead of arbitrary percentages
 */

import type { Position } from "../lib/types";

export interface ReserveBreakdown {
  // Hedge reserve for at-risk positions
  hedgeReserve: number;
  hedgeReason: string;

  // POL for gas fees
  polReserve: number;
  polReason: string;

  // Emergency reserve for risky positions
  emergencyReserve: number;
  emergencyReason: string;

  // Total reserved
  totalReserved: number;

  // Available for trading
  availableForTrading: number;
}

/**
 * Calculate hedge reserve based on positions at risk
 */
function calculateHedgeReserve(positions: Position[]): {
  reserve: number;
  reason: string;
} {
  // Find positions that might need hedging (losing >15%)
  const atRiskPositions = positions.filter((p) => p.pnlPct < -15);

  if (atRiskPositions.length === 0) {
    return { reserve: 0, reason: "No positions at risk" };
  }

  // Calculate potential hedge needs (80% of position value)
  const potentialHedgeNeeds = atRiskPositions.reduce((sum, p) => sum + p.value * 0.8, 0);

  // Add 20% buffer
  const reserve = potentialHedgeNeeds * 1.2;

  return {
    reserve,
    reason: `${atRiskPositions.length} position(s) at risk, potential hedge: $${potentialHedgeNeeds.toFixed(2)}`,
  };
}

/**
 * Calculate POL reserve for gas fees
 * Default gas estimate: $0.02 per transaction (configurable)
 */
function calculatePolReserve(
  recentTxCount: number,
  hoursAhead: number = 4,
  gasPerTx: number = 0.02,
): {
  reserve: number;
  reason: string;
} {
  const estimatedTxNeeds = recentTxCount * hoursAhead;
  const calculatedReserve = estimatedTxNeeds * gasPerTx;

  // Minimum $2, maximum $10
  const reserve = Math.max(2, Math.min(10, calculatedReserve));

  return {
    reserve,
    reason: `${recentTxCount} tx/hr × ${hoursAhead}hr × $${gasPerTx} = $${calculatedReserve.toFixed(2)}`,
  };
}

/**
 * Calculate emergency reserve for risky exposure
 */
function calculateEmergencyReserve(positions: Position[]): {
  reserve: number;
  reason: string;
} {
  // Positions in risky price range (30-70¢) are most volatile
  const riskyPositions = positions.filter((p) => p.curPrice >= 0.3 && p.curPrice <= 0.7);

  if (riskyPositions.length === 0) {
    return { reserve: 0, reason: "No risky positions" };
  }

  const riskyExposure = riskyPositions.reduce((sum, p) => sum + p.value, 0);

  // Reserve 5% of risky exposure, minimum $25
  const reserve = Math.max(25, riskyExposure * 0.05);

  return {
    reserve,
    reason: `${riskyPositions.length} risky position(s), exposure: $${riskyExposure.toFixed(2)}`,
  };
}

/**
 * Calculate intelligent reserves
 */
export function calculateIntelligentReserves(
  balance: number,
  positions: Position[],
  recentTxCount: number = 5,
): ReserveBreakdown {
  const hedge = calculateHedgeReserve(positions);
  const pol = calculatePolReserve(recentTxCount);
  const emergency = calculateEmergencyReserve(positions);

  const totalReserved = hedge.reserve + pol.reserve + emergency.reserve;
  const availableForTrading = Math.max(0, balance - totalReserved);

  return {
    hedgeReserve: hedge.reserve,
    hedgeReason: hedge.reason,
    polReserve: pol.reserve,
    polReason: pol.reason,
    emergencyReserve: emergency.reserve,
    emergencyReason: emergency.reason,
    totalReserved,
    availableForTrading,
  };
}

/**
 * Format reserve breakdown for display
 */
export function formatReserveBreakdown(breakdown: ReserveBreakdown): string {
  const lines = [
    "💰 INTELLIGENT RESERVES",
    "",
    `🛡️ Hedge Reserve: $${breakdown.hedgeReserve.toFixed(2)}`,
    `   ${breakdown.hedgeReason}`,
    "",
    `⛽ POL Reserve: $${breakdown.polReserve.toFixed(2)}`,
    `   ${breakdown.polReason}`,
    "",
    `🚨 Emergency Reserve: $${breakdown.emergencyReserve.toFixed(2)}`,
    `   ${breakdown.emergencyReason}`,
    "",
    `📊 Total Reserved: $${breakdown.totalReserved.toFixed(2)}`,
    `✅ Available for Trading: $${breakdown.availableForTrading.toFixed(2)}`,
  ];

  return lines.join("\n");
}
