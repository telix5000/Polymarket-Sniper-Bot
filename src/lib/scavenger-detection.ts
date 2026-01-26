/**
 * V2 Scavenger Detection - Low liquidity condition detection
 *
 * Monitors market conditions and determines when to switch
 * between NORMAL_MODE and LOW_LIQUIDITY_SCAVENGE_MODE.
 */

import axios from "axios";
import { POLYMARKET_API } from "./constants";
import type {
  LiquidityDetectionConfig,
  ScavengerReversionConfig,
} from "./scavenger-config";
import type { Logger } from "./types";

/**
 * Minimum price change threshold (0.1%) to consider order book as "moving"
 * Below this threshold, the order book is considered stagnant
 */
const MIN_PRICE_CHANGE_THRESHOLD = 0.001;

/**
 * Minimum number of low liquidity conditions required to trigger scavenger mode
 * Prevents false positives from single metric anomalies
 */
const MIN_LOW_LIQUIDITY_CONDITIONS = 2;

/**
 * Market volume sample
 */
interface VolumeSample {
  timestamp: number;
  volumeUsd: number;
}

/**
 * Order book snapshot
 */
interface OrderBookSnapshot {
  timestamp: number;
  bidDepthUsd: number;
  askDepthUsd: number;
  bestBid: number;
  bestAsk: number;
}

/**
 * Target activity sample
 */
interface TargetActivitySample {
  timestamp: number;
  activeCount: number;
  totalCount: number;
}

/**
 * Detection state
 */
export interface DetectionState {
  volumeSamples: VolumeSample[];
  orderBookSnapshots: OrderBookSnapshot[];
  targetActivitySamples: TargetActivitySample[];
  lowLiquidityDetectedAt: number | null;
  highLiquidityDetectedAt: number | null;
}

/**
 * Detection result
 */
export interface DetectionResult {
  isLowLiquidity: boolean;
  shouldEnterScavengerMode: boolean;
  shouldExitScavengerMode: boolean;
  metrics: {
    recentVolumeUsd: number;
    avgOrderBookDepthUsd: number;
    activeTargetRatio: number;
    lowLiquidityDurationMs: number;
    highLiquidityDurationMs: number;
  };
  reasons: string[];
}

/**
 * Create initial detection state
 */
export function createDetectionState(): DetectionState {
  return {
    volumeSamples: [],
    orderBookSnapshots: [],
    targetActivitySamples: [],
    lowLiquidityDetectedAt: null,
    highLiquidityDetectedAt: null,
  };
}

/**
 * Record a volume sample
 */
export function recordVolumeSample(
  state: DetectionState,
  volumeUsd: number,
  maxAge: number,
): DetectionState {
  const now = Date.now();
  const cutoff = now - maxAge;

  return {
    ...state,
    volumeSamples: [
      ...state.volumeSamples.filter((s) => s.timestamp > cutoff),
      { timestamp: now, volumeUsd },
    ].slice(-100), // Keep max 100 samples
  };
}

/**
 * Record an order book snapshot
 */
export function recordOrderBookSnapshot(
  state: DetectionState,
  snapshot: Omit<OrderBookSnapshot, "timestamp">,
  maxAge: number,
): DetectionState {
  const now = Date.now();
  const cutoff = now - maxAge;

  return {
    ...state,
    orderBookSnapshots: [
      ...state.orderBookSnapshots.filter((s) => s.timestamp > cutoff),
      { ...snapshot, timestamp: now },
    ].slice(-100),
  };
}

/**
 * Record target activity
 */
export function recordTargetActivity(
  state: DetectionState,
  activeCount: number,
  totalCount: number,
  maxAge: number,
): DetectionState {
  const now = Date.now();
  const cutoff = now - maxAge;

  return {
    ...state,
    targetActivitySamples: [
      ...state.targetActivitySamples.filter((s) => s.timestamp > cutoff),
      { timestamp: now, activeCount, totalCount },
    ].slice(-100),
  };
}

/**
 * Calculate total volume in window
 */
function calculateRecentVolume(
  samples: VolumeSample[],
  windowMs: number,
): number {
  const cutoff = Date.now() - windowMs;
  return samples
    .filter((s) => s.timestamp > cutoff)
    .reduce((sum, s) => sum + s.volumeUsd, 0);
}

/**
 * Calculate average order book depth
 */
function calculateAvgOrderBookDepth(
  snapshots: OrderBookSnapshot[],
  windowMs: number,
): number {
  const cutoff = Date.now() - windowMs;
  const recent = snapshots.filter((s) => s.timestamp > cutoff);

  if (recent.length === 0) return 0;

  const totalDepth = recent.reduce(
    (sum, s) => sum + s.bidDepthUsd + s.askDepthUsd,
    0,
  );
  return totalDepth / recent.length;
}

/**
 * Check if order book is stagnant (no meaningful changes)
 */
function isOrderBookStagnant(
  snapshots: OrderBookSnapshot[],
  thresholdMs: number,
): boolean {
  const cutoff = Date.now() - thresholdMs;
  const recent = snapshots.filter((s) => s.timestamp > cutoff);

  if (recent.length < 2) return false;

  // Check if best bid/ask have changed meaningfully
  const first = recent[0];
  const last = recent[recent.length - 1];

  const bidChange =
    Math.abs(last.bestBid - first.bestBid) / (first.bestBid || 1);
  const askChange =
    Math.abs(last.bestAsk - first.bestAsk) / (first.bestAsk || 1);

  return (
    bidChange < MIN_PRICE_CHANGE_THRESHOLD &&
    askChange < MIN_PRICE_CHANGE_THRESHOLD
  );
}

/**
 * Calculate active target ratio
 */
function calculateActiveTargetRatio(samples: TargetActivitySample[]): number {
  if (samples.length === 0) return 1; // Assume active if no data

  const latest = samples[samples.length - 1];
  return latest.totalCount > 0 ? latest.activeCount / latest.totalCount : 1;
}

/**
 * Get latest active target count
 */
function getLatestActiveTargets(samples: TargetActivitySample[]): number {
  if (samples.length === 0) return 0;
  return samples[samples.length - 1].activeCount;
}

/**
 * Analyze market conditions and determine if low liquidity
 */
export function analyzeMarketConditions(
  state: DetectionState,
  config: LiquidityDetectionConfig,
  isCurrentlyInScavengerMode: boolean,
  reversionConfig?: ScavengerReversionConfig,
  logger?: Logger,
): { result: DetectionResult; newState: DetectionState } {
  const now = Date.now();
  const reasons: string[] = [];

  // Calculate metrics
  const recentVolumeUsd = calculateRecentVolume(
    state.volumeSamples,
    config.volumeWindowMs,
  );
  const avgOrderBookDepthUsd = calculateAvgOrderBookDepth(
    state.orderBookSnapshots,
    config.stagnantBookThresholdMs,
  );
  const orderBookStagnant = isOrderBookStagnant(
    state.orderBookSnapshots,
    config.stagnantBookThresholdMs,
  );
  const activeTargetRatio = calculateActiveTargetRatio(
    state.targetActivitySamples,
  );
  const activeTargets = getLatestActiveTargets(state.targetActivitySamples);

  // Determine if current conditions indicate low liquidity
  let isLowLiquidity = false;
  let lowLiquidityCount = 0;

  if (recentVolumeUsd < config.volumeThresholdUsd) {
    reasons.push(
      `Low volume: $${recentVolumeUsd.toFixed(2)} < $${config.volumeThresholdUsd}`,
    );
    lowLiquidityCount++;
  }

  if (avgOrderBookDepthUsd < config.minOrderBookDepthUsd) {
    reasons.push(
      `Thin orderbook: $${avgOrderBookDepthUsd.toFixed(2)} < $${config.minOrderBookDepthUsd}`,
    );
    lowLiquidityCount++;
  }

  if (orderBookStagnant) {
    reasons.push("Orderbook stagnant - no meaningful bid/ask changes");
    lowLiquidityCount++;
  }

  if (activeTargets < config.minActiveTargets) {
    reasons.push(
      `Few active targets: ${activeTargets} < ${config.minActiveTargets}`,
    );
    lowLiquidityCount++;
  }

  // Consider low liquidity if multiple conditions are met
  isLowLiquidity = lowLiquidityCount >= MIN_LOW_LIQUIDITY_CONDITIONS;

  // Update detection timestamps
  let newState = { ...state };

  if (isLowLiquidity) {
    if (state.lowLiquidityDetectedAt === null) {
      newState.lowLiquidityDetectedAt = now;
      logger?.info?.(
        `🔍 Low liquidity conditions detected: ${reasons.join("; ")}`,
      );
    }
    newState.highLiquidityDetectedAt = null;
  } else {
    if (
      state.highLiquidityDetectedAt === null &&
      state.lowLiquidityDetectedAt !== null
    ) {
      newState.highLiquidityDetectedAt = now;
      logger?.info?.(
        "🔍 Market conditions improving - monitoring for recovery",
      );
    }
    newState.lowLiquidityDetectedAt = null;
  }

  // Calculate durations
  const lowLiquidityDurationMs = state.lowLiquidityDetectedAt
    ? now - state.lowLiquidityDetectedAt
    : 0;
  const highLiquidityDurationMs = state.highLiquidityDetectedAt
    ? now - state.highLiquidityDetectedAt
    : 0;

  // Determine mode transitions
  let shouldEnterScavengerMode = false;
  let shouldExitScavengerMode = false;

  if (!isCurrentlyInScavengerMode) {
    // Check if we should enter scavenger mode
    shouldEnterScavengerMode =
      isLowLiquidity && lowLiquidityDurationMs >= config.sustainedConditionMs;
  } else if (reversionConfig) {
    // Check if we should exit scavenger mode (revert to normal)
    const volumeRecovered =
      recentVolumeUsd >= reversionConfig.volumeRecoveryThresholdUsd;
    const depthRecovered =
      avgOrderBookDepthUsd >= reversionConfig.depthRecoveryThresholdUsd;
    const targetsRecovered =
      activeTargets >= reversionConfig.minActiveTargetsForReversion;

    // Any single recovery condition can trigger reversion
    const anyRecoveryCondition =
      volumeRecovered || depthRecovered || targetsRecovered;

    if (
      anyRecoveryCondition &&
      highLiquidityDurationMs >= reversionConfig.sustainedRecoveryMs
    ) {
      shouldExitScavengerMode = true;
      if (volumeRecovered) {
        reasons.push(
          `Volume recovered: $${recentVolumeUsd.toFixed(2)} >= $${reversionConfig.volumeRecoveryThresholdUsd}`,
        );
      }
      if (depthRecovered) {
        reasons.push(
          `Depth recovered: $${avgOrderBookDepthUsd.toFixed(2)} >= $${reversionConfig.depthRecoveryThresholdUsd}`,
        );
      }
      if (targetsRecovered) {
        reasons.push(
          `Targets active: ${activeTargets} >= ${reversionConfig.minActiveTargetsForReversion}`,
        );
      }
    }
  }

  return {
    result: {
      isLowLiquidity,
      shouldEnterScavengerMode,
      shouldExitScavengerMode,
      metrics: {
        recentVolumeUsd,
        avgOrderBookDepthUsd,
        activeTargetRatio,
        lowLiquidityDurationMs,
        highLiquidityDurationMs,
      },
      reasons,
    },
    newState,
  };
}

/**
 * Fetch recent market volume from Polymarket API
 * Uses parallel requests with a short timeout to avoid blocking the main loop
 */
export async function fetchRecentVolume(tokenIds: string[]): Promise<number> {
  if (tokenIds.length === 0) return 0;

  try {
    // Sample a subset of tokens if there are many
    const sampleTokens = tokenIds.slice(0, 10);
    const cutoff = Date.now() - 5 * 60 * 1000; // Last 5 minutes

    // Fetch all token volumes in parallel
    const volumePromises = sampleTokens.map(async (tokenId) => {
      try {
        const url = `${POLYMARKET_API.DATA}/trades?asset=${tokenId}&limit=50`;
        const { data } = await axios.get(url, { timeout: 3000 }); // Shorter timeout

        if (Array.isArray(data)) {
          const recentTrades = data.filter((t: any) => {
            const ts = new Date(t.timestamp || t.createdAt).getTime();
            return ts > cutoff;
          });

          return recentTrades.reduce((sum: number, t: any) => {
            return sum + (Number(t.size) * Number(t.price) || 0);
          }, 0);
        }
        return 0;
      } catch {
        return 0; // Return 0 for individual token errors
      }
    });

    const results = await Promise.allSettled(volumePromises);
    return results.reduce((total, result) => {
      return total + (result.status === "fulfilled" ? result.value : 0);
    }, 0);
  } catch {
    return 0;
  }
}

/**
 * Check target addresses for recent activity
 * Uses parallel requests with a short timeout to avoid blocking the main loop
 */
export async function checkTargetActivity(
  targetAddresses: string[],
  windowMs: number,
): Promise<{ activeCount: number; totalCount: number }> {
  if (targetAddresses.length === 0) {
    return { activeCount: 0, totalCount: 0 };
  }

  const cutoff = Date.now() - windowMs;

  // Check a sample of targets
  const sampleTargets = targetAddresses.slice(0, 10);

  // Fetch all target activity in parallel
  const activityPromises = sampleTargets.map(async (addr) => {
    try {
      const url = `${POLYMARKET_API.DATA}/trades?user=${addr}&limit=5`;
      const { data } = await axios.get(url, { timeout: 3000 }); // Shorter timeout

      if (Array.isArray(data) && data.length > 0) {
        const latest = data[0];
        const ts = new Date(latest.timestamp || latest.createdAt).getTime();
        return ts > cutoff;
      }
      return false;
    } catch {
      return false; // Treat errors as inactive
    }
  });

  const results = await Promise.allSettled(activityPromises);
  const activeCount = results.filter(
    (result) => result.status === "fulfilled" && result.value === true,
  ).length;

  return { activeCount, totalCount: sampleTargets.length };
}

/**
 * Fetch order book depth for a set of tokens
 * Uses parallel requests with a short timeout
 * Returns aggregated bid/ask depth and best bid/ask prices
 */
export async function fetchOrderBookDepth(
  client: { getOrderBook: (tokenId: string) => Promise<any> },
  tokenIds: string[],
): Promise<{
  avgBidDepthUsd: number;
  avgAskDepthUsd: number;
  bestBid: number;
  bestAsk: number;
}> {
  if (tokenIds.length === 0) {
    return { avgBidDepthUsd: 0, avgAskDepthUsd: 0, bestBid: 0, bestAsk: 0 };
  }

  // Sample a subset of tokens
  const sampleTokens = tokenIds.slice(0, 5); // Fewer tokens since orderbook calls can be heavier

  const depthPromises = sampleTokens.map(async (tokenId) => {
    try {
      const orderBook = await client.getOrderBook(tokenId);

      let bidDepthUsd = 0;
      let askDepthUsd = 0;
      let bestBid = 0;
      let bestAsk = 0;

      if (orderBook?.bids?.length) {
        bestBid = parseFloat(orderBook.bids[0].price);
        bidDepthUsd = orderBook.bids.slice(0, 5).reduce((sum: number, level: any) => {
          return sum + parseFloat(level.size) * parseFloat(level.price);
        }, 0);
      }

      if (orderBook?.asks?.length) {
        bestAsk = parseFloat(orderBook.asks[0].price);
        askDepthUsd = orderBook.asks.slice(0, 5).reduce((sum: number, level: any) => {
          return sum + parseFloat(level.size) * parseFloat(level.price);
        }, 0);
      }

      return { bidDepthUsd, askDepthUsd, bestBid, bestAsk };
    } catch {
      return { bidDepthUsd: 0, askDepthUsd: 0, bestBid: 0, bestAsk: 0 };
    }
  });

  const results = await Promise.allSettled(depthPromises);
  const validResults = results
    .filter((r) => r.status === "fulfilled")
    .map((r) => (r as PromiseFulfilledResult<any>).value);

  if (validResults.length === 0) {
    return { avgBidDepthUsd: 0, avgAskDepthUsd: 0, bestBid: 0, bestAsk: 0 };
  }

  const totalBidDepth = validResults.reduce((sum, r) => sum + r.bidDepthUsd, 0);
  const totalAskDepth = validResults.reduce((sum, r) => sum + r.askDepthUsd, 0);

  // Use the first valid best bid/ask as representative
  const firstWithBid = validResults.find((r) => r.bestBid > 0);
  const firstWithAsk = validResults.find((r) => r.bestAsk > 0);

  return {
    avgBidDepthUsd: totalBidDepth / validResults.length,
    avgAskDepthUsd: totalAskDepth / validResults.length,
    bestBid: firstWithBid?.bestBid ?? 0,
    bestAsk: firstWithAsk?.bestAsk ?? 0,
  };
}
