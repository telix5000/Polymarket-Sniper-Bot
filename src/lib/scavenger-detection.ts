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

  // Check if best bid/ask have changed meaningfully (more than 0.1%)
  const first = recent[0];
  const last = recent[recent.length - 1];

  const bidChange =
    Math.abs(last.bestBid - first.bestBid) / (first.bestBid || 1);
  const askChange =
    Math.abs(last.bestAsk - first.bestAsk) / (first.bestAsk || 1);

  return bidChange < 0.001 && askChange < 0.001;
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

  // Consider low liquidity if at least 2 conditions are met
  isLowLiquidity = lowLiquidityCount >= 2;

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
 */
export async function fetchRecentVolume(tokenIds: string[]): Promise<number> {
  if (tokenIds.length === 0) return 0;

  try {
    let totalVolume = 0;

    // Sample a subset of tokens if there are many
    const sampleTokens = tokenIds.slice(0, 10);

    for (const tokenId of sampleTokens) {
      try {
        const url = `${POLYMARKET_API.DATA}/trades?asset=${tokenId}&limit=50`;
        const { data } = await axios.get(url, { timeout: 5000 });

        if (Array.isArray(data)) {
          const cutoff = Date.now() - 5 * 60 * 1000; // Last 5 minutes
          const recentTrades = data.filter((t: any) => {
            const ts = new Date(t.timestamp || t.createdAt).getTime();
            return ts > cutoff;
          });

          totalVolume += recentTrades.reduce((sum: number, t: any) => {
            return sum + (Number(t.size) * Number(t.price) || 0);
          }, 0);
        }
      } catch {
        // Continue on individual token errors
      }
    }

    return totalVolume;
  } catch {
    return 0;
  }
}

/**
 * Check target addresses for recent activity
 */
export async function checkTargetActivity(
  targetAddresses: string[],
  windowMs: number,
): Promise<{ activeCount: number; totalCount: number }> {
  if (targetAddresses.length === 0) {
    return { activeCount: 0, totalCount: 0 };
  }

  let activeCount = 0;
  const cutoff = Date.now() - windowMs;

  // Check a sample of targets
  const sampleTargets = targetAddresses.slice(0, 10);

  for (const addr of sampleTargets) {
    try {
      const url = `${POLYMARKET_API.DATA}/trades?user=${addr}&limit=5`;
      const { data } = await axios.get(url, { timeout: 5000 });

      if (Array.isArray(data) && data.length > 0) {
        const latest = data[0];
        const ts = new Date(latest.timestamp || latest.createdAt).getTime();
        if (ts > cutoff) {
          activeCount++;
        }
      }
    } catch {
      // Continue on errors
    }
  }

  return { activeCount, totalCount: sampleTargets.length };
}
