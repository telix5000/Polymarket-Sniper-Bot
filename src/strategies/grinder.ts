/**
 * APEX GRINDER - Volume Trading Strategy
 * 
 * Trades on high volume markets with tight spreads
 */

import type { Position } from "../lib/types";

export interface GrinderSignal {
  tokenId: string;
  conditionId: string;
  marketId?: string;
  outcome: "YES" | "NO";
  volume: number;
  spread: number;
  confidence: number;
  reason: string;
}

export interface MarketMetrics {
  tokenId: string;
  volume24h: number;
  volume1h: number;
  spread: number;
  liquidity: number;
  priceStability: number; // 0-1, higher = more stable
}

/**
 * Detect high-volume grinding opportunities
 */
export function detectGrinder(
  metrics: MarketMetrics,
  minVolume: number = 5000,
  maxSpread: number = 0.02,
): GrinderSignal | null {
  // High volume + tight spread = good for grinding
  if (metrics.volume24h >= minVolume && metrics.spread <= maxSpread && metrics.liquidity > 1000) {
    // Trade in direction of recent flow
    const volumeRatio = metrics.volume1h / (metrics.volume24h / 24);
    const isAccelerating = volumeRatio > 1.2;

    const outcome = isAccelerating ? "YES" : "NO";
    const confidence = Math.min(100, (metrics.volume24h / minVolume) * 20);

    return {
      tokenId: metrics.tokenId,
      conditionId: "",
      outcome,
      volume: metrics.volume24h,
      spread: metrics.spread,
      confidence,
      reason: `APEX Grinder: $${metrics.volume24h.toFixed(0)} volume, ${(metrics.spread * 100).toFixed(2)}% spread`,
    };
  }

  return null;
}

/**
 * Check if position is good for grinding (multiple small trades)
 */
export function isGrindable(position: Position, metrics: MarketMetrics): boolean {
  // Good grind: stable price, high volume, tight spread
  return (
    metrics.priceStability > 0.7 &&
    metrics.volume24h > 3000 &&
    metrics.spread < 0.02 &&
    position.pnlPct > -5 &&
    position.pnlPct < 15
  );
}

/**
 * Calculate optimal grind size (smaller than normal positions)
 */
export function calculateGrindSize(basePositionSize: number): number {
  // Grinder uses 60% of normal position size for more frequent trades
  return basePositionSize * 0.6;
}

/**
 * Determine when to exit grind position
 */
export function shouldExitGrind(position: Position, metrics: MarketMetrics): boolean {
  // Exit if:
  // 1. Hit modest profit target (8%+)
  // 2. Volume drops significantly
  // 3. Spread widens
  const hitTarget = position.pnlPct >= 8;
  const volumeDrying = metrics.volume1h < metrics.volume24h / 24 * 0.5;
  const spreadWidening = metrics.spread > 0.03;

  return hitTarget || volumeDrying || spreadWidening;
}
