/**
 * V2 Scavenger - Unified scavenger mode module
 *
 * Capital preservation strategy during low liquidity periods:
 * - Exit green positions opportunistically
 * - Monitor red positions (sell when they recover)
 * - Micro-buys with strict risk constraints
 * - Automatic mode detection and switching
 */

import type { ClobClient } from "@polymarket/clob-client";
import { Side, OrderType } from "@polymarket/clob-client";
import axios from "axios";
import type { Position, Logger, OrderResult } from "./types";
import { ORDER, POLYMARKET_API } from "./constants";

// ============================================================================
// CONSTANTS
// ============================================================================

const MIN_PRICE_CHANGE_THRESHOLD = 0.001; // 0.1% threshold for price movement
const MIN_LOW_LIQUIDITY_CONDITIONS = 2; // Conditions needed to trigger scavenger

// ============================================================================
// CONFIGURATION TYPES
// ============================================================================

/** Scavenger mode configuration */
export interface ScavengerConfig {
  enabled: boolean;
  detection: {
    volumeThresholdUsd: number;
    volumeWindowMs: number;
    minOrderBookDepthUsd: number;
    stagnantBookThresholdMs: number;
    minActiveTargets: number;
    targetActivityWindowMs: number;
    sustainedConditionMs: number;
  };
  exit: {
    stalledPriceThresholdMs: number;
    minGreenProfitPct: number;
    minAcceptableProfitUsd: number;
    conservativeSlippagePct: number;
  };
  redMonitor: {
    smallProfitThresholdPct: number;
    minRecoveryProfitUsd: number;
  };
  microBuy: {
    enabled: boolean;
    minExpectedProfitUsd: number;
    maxCapitalFraction: number;
    maxPositionUsd: number;
    minDiscountPct: number;
    takeProfitPct: number;
  };
  risk: {
    maxDeployedCapitalUsd: number;
    maxScavengePositions: number;
    tokenCooldownMs: number;
  };
  reversion: {
    volumeRecoveryThresholdUsd: number;
    depthRecoveryThresholdUsd: number;
    minActiveTargetsForReversion: number;
    sustainedRecoveryMs: number;
  };
}

/** Default scavenger configuration */
export const DEFAULT_SCAVENGER_CONFIG: ScavengerConfig = {
  enabled: true,
  detection: {
    volumeThresholdUsd: 1000,
    volumeWindowMs: 5 * 60 * 1000,
    minOrderBookDepthUsd: 500,
    stagnantBookThresholdMs: 2 * 60 * 1000,
    minActiveTargets: 1,
    targetActivityWindowMs: 5 * 60 * 1000,
    sustainedConditionMs: 3 * 60 * 1000,
  },
  exit: {
    stalledPriceThresholdMs: 30 * 1000,
    minGreenProfitPct: 1,
    minAcceptableProfitUsd: 0.5,
    conservativeSlippagePct: 1,
  },
  redMonitor: {
    smallProfitThresholdPct: 0.5,
    minRecoveryProfitUsd: 0.25,
  },
  microBuy: {
    enabled: true,
    minExpectedProfitUsd: 0.5,
    maxCapitalFraction: 0.05,
    maxPositionUsd: 10,
    minDiscountPct: 3,
    takeProfitPct: 5,
  },
  risk: {
    maxDeployedCapitalUsd: 100,
    maxScavengePositions: 10,
    tokenCooldownMs: 5 * 60 * 1000,
  },
  reversion: {
    volumeRecoveryThresholdUsd: 5000,
    depthRecoveryThresholdUsd: 2000,
    minActiveTargetsForReversion: 2,
    sustainedRecoveryMs: 2 * 60 * 1000,
  },
};

// ============================================================================
// STATE TYPES
// ============================================================================

/** Trading mode enum */
export enum TradingMode {
  // Keep member names concise but preserve legacy serialized values for compatibility
  NORMAL = "NORMAL_MODE",
  SCAVENGER = "LOW_LIQUIDITY_SCAVENGE_MODE",
}

/** Scavenger state */
export interface ScavengerState {
  mode: TradingMode;
  modeEnteredAt: number;
  tokenCooldowns: Map<string, number>;
  priceHistory: Map<string, Array<{ price: number; timestamp: number }>>;
  deployedCapitalUsd: number;
  scavengerPositionCount: number;
  monitoredRedPositions: Set<string>;
  scavengerEntryPrices: Map<string, number>;
  // Detection tracking
  volumeSamples: Array<{ timestamp: number; volumeUsd: number }>;
  orderBookSnapshots: Array<{ timestamp: number; bidDepth: number; askDepth: number; bestBid: number; bestAsk: number }>;
  targetActivitySamples: Array<{ timestamp: number; activeCount: number; totalCount: number }>;
  lowLiquidityDetectedAt: number | null;
  highLiquidityDetectedAt: number | null;
}

/** Scavenger action result */
export interface ScavengerActionResult {
  action: "EXIT_GREEN" | "EXIT_RED_RECOVERY" | "MICRO_BUY" | "NONE";
  tokenId?: string;
  outcome?: string;
  sizeUsd?: number;
  reason: string;
  orderResult?: OrderResult;
}

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

/** Create initial scavenger state */
export function createScavengerState(): ScavengerState {
  return {
    mode: TradingMode.NORMAL,
    modeEnteredAt: Date.now(),
    tokenCooldowns: new Map(),
    priceHistory: new Map(),
    deployedCapitalUsd: 0,
    scavengerPositionCount: 0,
    monitoredRedPositions: new Set(),
    scavengerEntryPrices: new Map(),
    volumeSamples: [],
    orderBookSnapshots: [],
    targetActivitySamples: [],
    lowLiquidityDetectedAt: null,
    highLiquidityDetectedAt: null,
  };
}

/** Reset scavenger state on mode exit */
export function resetScavengerState(state: ScavengerState): ScavengerState {
  return {
    ...state,
    priceHistory: new Map(),
    deployedCapitalUsd: 0,
    scavengerPositionCount: 0,
    monitoredRedPositions: new Set(),
    scavengerEntryPrices: new Map(),
    // Reset detection history to avoid stale data affecting future mode transitions
    volumeSamples: [],
    orderBookSnapshots: [],
    targetActivitySamples: [],
    lowLiquidityDetectedAt: null,
    highLiquidityDetectedAt: null,
  };
}

// ============================================================================
// PRICE & COOLDOWN TRACKING
// ============================================================================

/** Update price history for a token */
export function updatePriceHistory(
  state: ScavengerState,
  tokenId: string,
  currentPrice: number,
  maxAge: number = 60000,
): ScavengerState {
  const now = Date.now();
  const cutoff = now - maxAge;
  const existing = state.priceHistory.get(tokenId) || [];
  const filtered = existing.filter((s) => s.timestamp > cutoff);
  filtered.push({ price: currentPrice, timestamp: now });

  const newHistory = new Map(state.priceHistory);
  newHistory.set(tokenId, filtered.slice(-50));
  return { ...state, priceHistory: newHistory };
}

/** Check if price has stalled */
export function isPriceStalled(state: ScavengerState, tokenId: string, thresholdMs: number): boolean {
  const history = state.priceHistory.get(tokenId);
  if (!history || history.length < 2) return false;

  const cutoff = Date.now() - thresholdMs;
  const recent = history.filter((s) => s.timestamp > cutoff);
  if (recent.length < 2) return false;

  const first = recent[0].price;
  const last = recent[recent.length - 1].price;
  return (last - first) / first < MIN_PRICE_CHANGE_THRESHOLD;
}

/** Check if token is on cooldown */
export function isOnCooldown(state: ScavengerState, tokenId: string): boolean {
  const expiry = state.tokenCooldowns.get(tokenId);
  return expiry ? Date.now() < expiry : false;
}

/** Set token cooldown */
export function setTokenCooldown(state: ScavengerState, tokenId: string, cooldownMs: number): ScavengerState {
  const newCooldowns = new Map(state.tokenCooldowns);
  newCooldowns.set(tokenId, Date.now() + cooldownMs);
  return { ...state, tokenCooldowns: newCooldowns };
}

/** Clean expired cooldowns */
export function cleanExpiredCooldowns(state: ScavengerState): ScavengerState {
  const now = Date.now();
  const newCooldowns = new Map<string, number>();
  state.tokenCooldowns.forEach((expiry, id) => {
    if (expiry > now) newCooldowns.set(id, expiry);
  });
  return { ...state, tokenCooldowns: newCooldowns };
}

// ============================================================================
// POSITION CHECKS
// ============================================================================

/** Check if position is green with sufficient profit */
export function isGreenPosition(position: Position, minProfitPct: number, minProfitUsd: number): boolean {
  return position.pnlPct >= minProfitPct && position.pnlUsd >= minProfitUsd;
}

/** Check if red position has recovered */
export function hasRedPositionRecovered(position: Position, profitPct: number, minUsd: number): boolean {
  return position.pnlPct >= profitPct && position.pnlUsd >= minUsd;
}

/** Check if micro-buy is allowed */
export function canMicroBuy(
  state: ScavengerState,
  config: ScavengerConfig,
  availableCapitalUsd: number,
  tokenId: string,
): { allowed: boolean; reason?: string; maxSizeUsd?: number } {
  if (!config.microBuy.enabled) return { allowed: false, reason: "Micro-buys disabled" };
  if (isOnCooldown(state, tokenId)) return { allowed: false, reason: "Token on cooldown" };
  if (state.scavengerPositionCount >= config.risk.maxScavengePositions) {
    return { allowed: false, reason: `Max positions (${config.risk.maxScavengePositions}) reached` };
  }
  if (state.deployedCapitalUsd >= config.risk.maxDeployedCapitalUsd) {
    return { allowed: false, reason: `Max deployed capital ($${config.risk.maxDeployedCapitalUsd}) reached` };
  }

  const remaining = config.risk.maxDeployedCapitalUsd - state.deployedCapitalUsd;
  const maxSize = Math.min(config.microBuy.maxPositionUsd, availableCapitalUsd * config.microBuy.maxCapitalFraction, remaining);
  if (maxSize < ORDER.MIN_ORDER_USD) return { allowed: false, reason: "Max size too small" };
  return { allowed: true, maxSizeUsd: maxSize };
}

// ============================================================================
// MARKET DATA FETCHING
// ============================================================================

/** Fetch recent market volume */
export async function fetchRecentVolume(tokenIds: string[]): Promise<number> {
  if (tokenIds.length === 0) return 0;
  try {
    const sample = tokenIds.slice(0, 10);
    const cutoff = Date.now() - 5 * 60 * 1000;
    const results = await Promise.allSettled(
      sample.map(async (id) => {
        const { data } = await axios.get(`${POLYMARKET_API.DATA}/trades?asset=${id}&limit=50`, { timeout: 3000 });
        if (!Array.isArray(data)) return 0;
        return data
          .filter((t: any) => new Date(t.timestamp || t.createdAt).getTime() > cutoff)
          .reduce((sum: number, t: any) => sum + (Number(t.size) * Number(t.price) || 0), 0);
      }),
    );
    return results.reduce((sum, r) => sum + (r.status === "fulfilled" ? r.value : 0), 0);
  } catch {
    return 0;
  }
}

/** Check target activity */
export async function checkTargetActivity(targets: string[], windowMs: number): Promise<{ activeCount: number; totalCount: number }> {
  if (targets.length === 0) return { activeCount: 0, totalCount: 0 };
  const cutoff = Date.now() - windowMs;
  const sample = targets.slice(0, 10);
  const results = await Promise.allSettled(
    sample.map(async (addr) => {
      const { data } = await axios.get(`${POLYMARKET_API.DATA}/trades?user=${addr}&limit=5`, { timeout: 3000 });
      if (Array.isArray(data) && data.length > 0) {
        return new Date(data[0].timestamp || data[0].createdAt).getTime() > cutoff;
      }
      return false;
    }),
  );
  const active = results.filter((r) => r.status === "fulfilled" && r.value).length;
  return { activeCount: active, totalCount: sample.length };
}

/** Fetch order book depth */
export async function fetchOrderBookDepth(
  client: { getOrderBook: (id: string) => Promise<any> },
  tokenIds: string[],
): Promise<{ avgBidDepthUsd: number; avgAskDepthUsd: number; bestBid: number; bestAsk: number }> {
  if (tokenIds.length === 0) return { avgBidDepthUsd: 0, avgAskDepthUsd: 0, bestBid: 0, bestAsk: 0 };
  const sample = tokenIds.slice(0, 5);
  const results = await Promise.allSettled(
    sample.map(async (id) => {
      const book = await client.getOrderBook(id);
      let bidDepth = 0, askDepth = 0, bestBid = 0, bestAsk = 0;
      if (book?.bids?.length) {
        bestBid = parseFloat(book.bids[0].price);
        bidDepth = book.bids.slice(0, 5).reduce((s: number, l: any) => s + parseFloat(l.size) * parseFloat(l.price), 0);
      }
      if (book?.asks?.length) {
        bestAsk = parseFloat(book.asks[0].price);
        askDepth = book.asks.slice(0, 5).reduce((s: number, l: any) => s + parseFloat(l.size) * parseFloat(l.price), 0);
      }
      return { bidDepth, askDepth, bestBid, bestAsk };
    }),
  );
  const valid = results.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<any>).value);
  if (valid.length === 0) return { avgBidDepthUsd: 0, avgAskDepthUsd: 0, bestBid: 0, bestAsk: 0 };
  return {
    avgBidDepthUsd: valid.reduce((s, v) => s + v.bidDepth, 0) / valid.length,
    avgAskDepthUsd: valid.reduce((s, v) => s + v.askDepth, 0) / valid.length,
    bestBid: valid.find((v) => v.bestBid > 0)?.bestBid ?? 0,
    bestAsk: valid.find((v) => v.bestAsk > 0)?.bestAsk ?? 0,
  };
}

// ============================================================================
// DETECTION & MODE SWITCHING
// ============================================================================

/** Record volume sample */
export function recordVolumeSample(state: ScavengerState, volumeUsd: number, maxAge: number): ScavengerState {
  const now = Date.now();
  const cutoff = now - maxAge;
  return {
    ...state,
    volumeSamples: [...state.volumeSamples.filter((s) => s.timestamp > cutoff), { timestamp: now, volumeUsd }].slice(-100),
  };
}

/** Record order book snapshot */
export function recordOrderBookSnapshot(
  state: ScavengerState,
  snapshot: { bidDepthUsd: number; askDepthUsd: number; bestBid: number; bestAsk: number },
  maxAge: number,
): ScavengerState {
  const now = Date.now();
  const cutoff = now - maxAge;
  return {
    ...state,
    orderBookSnapshots: [
      ...state.orderBookSnapshots.filter((s) => s.timestamp > cutoff),
      { timestamp: now, bidDepth: snapshot.bidDepthUsd, askDepth: snapshot.askDepthUsd, bestBid: snapshot.bestBid, bestAsk: snapshot.bestAsk },
    ].slice(-100),
  };
}

/** Record target activity */
export function recordTargetActivity(state: ScavengerState, activeCount: number, totalCount: number, maxAge: number): ScavengerState {
  const now = Date.now();
  const cutoff = now - maxAge;
  return {
    ...state,
    targetActivitySamples: [...state.targetActivitySamples.filter((s) => s.timestamp > cutoff), { timestamp: now, activeCount, totalCount }].slice(-100),
  };
}

/** Check if order book is stagnant (no meaningful price changes) */
function isOrderBookStagnant(snapshots: Array<{ timestamp: number; bidDepth: number; askDepth: number; bestBid: number; bestAsk: number }>, thresholdMs: number): boolean {
  const cutoff = Date.now() - thresholdMs;
  const recent = snapshots.filter((s) => s.timestamp > cutoff);
  if (recent.length < 2) return false;

  const first = recent[0];
  const last = recent[recent.length - 1];
  const bidChange = Math.abs(last.bestBid - first.bestBid) / (first.bestBid || 1);
  const askChange = Math.abs(last.bestAsk - first.bestAsk) / (first.bestAsk || 1);

  return bidChange < MIN_PRICE_CHANGE_THRESHOLD && askChange < MIN_PRICE_CHANGE_THRESHOLD;
}

/** Analyze market conditions */
export function analyzeMarketConditions(
  state: ScavengerState,
  config: ScavengerConfig,
  logger?: Logger,
): { shouldSwitch: boolean; newMode: TradingMode; reasons: string[]; newState: ScavengerState } {
  const now = Date.now();
  const reasons: string[] = [];
  let lowLiquidityCount = 0;

  // Calculate metrics
  const volumeCutoff = now - config.detection.volumeWindowMs;
  const recentVolume = state.volumeSamples.filter((s) => s.timestamp > volumeCutoff).reduce((sum, s) => sum + s.volumeUsd, 0);

  const bookCutoff = now - config.detection.stagnantBookThresholdMs;
  const recentBooks = state.orderBookSnapshots.filter((s) => s.timestamp > bookCutoff);
  const avgDepth = recentBooks.length > 0 ? recentBooks.reduce((s, b) => s + b.bidDepth + b.askDepth, 0) / recentBooks.length : 0;
  const orderBookStagnant = isOrderBookStagnant(state.orderBookSnapshots, config.detection.stagnantBookThresholdMs);

  const latestActivity = state.targetActivitySamples[state.targetActivitySamples.length - 1];
  const activeTargets = latestActivity?.activeCount ?? 0;

  // Check conditions
  if (recentVolume < config.detection.volumeThresholdUsd) {
    reasons.push(`Low volume: $${recentVolume.toFixed(0)} < $${config.detection.volumeThresholdUsd}`);
    lowLiquidityCount++;
  }
  if (avgDepth < config.detection.minOrderBookDepthUsd) {
    reasons.push(`Thin book: $${avgDepth.toFixed(0)} < $${config.detection.minOrderBookDepthUsd}`);
    lowLiquidityCount++;
  }
  if (orderBookStagnant) {
    reasons.push("Orderbook stagnant - no meaningful bid/ask changes");
    lowLiquidityCount++;
  }
  if (activeTargets < config.detection.minActiveTargets) {
    reasons.push(`Few targets: ${activeTargets} < ${config.detection.minActiveTargets}`);
    lowLiquidityCount++;
  }

  const isLowLiquidity = lowLiquidityCount >= MIN_LOW_LIQUIDITY_CONDITIONS;

  // Create deep copy of state to avoid shared mutable references
  let newState: ScavengerState = {
    ...state,
    tokenCooldowns: new Map(state.tokenCooldowns),
    priceHistory: new Map(state.priceHistory),
    monitoredRedPositions: new Set(state.monitoredRedPositions),
    scavengerEntryPrices: new Map(state.scavengerEntryPrices),
  };

  // Update detection timestamps
  if (isLowLiquidity && state.lowLiquidityDetectedAt === null) {
    newState.lowLiquidityDetectedAt = now;
    newState.highLiquidityDetectedAt = null;
  } else if (!isLowLiquidity && state.lowLiquidityDetectedAt !== null) {
    newState.highLiquidityDetectedAt = state.highLiquidityDetectedAt ?? now;
    newState.lowLiquidityDetectedAt = null;
  }

  // Determine mode switch
  const inScavenger = state.mode === TradingMode.SCAVENGER;
  let shouldSwitch = false;
  let newMode = state.mode;

  if (!inScavenger && isLowLiquidity) {
    // Use newState timestamp for correct duration calculation after first detection
    const duration = newState.lowLiquidityDetectedAt ? now - newState.lowLiquidityDetectedAt : 0;
    if (duration >= config.detection.sustainedConditionMs) {
      shouldSwitch = true;
      newMode = TradingMode.SCAVENGER;
      logger?.info?.(`🦅 Entering scavenger mode: ${reasons.join("; ")}`);
    }
  } else if (inScavenger && !isLowLiquidity) {
    const recovered =
      recentVolume >= config.reversion.volumeRecoveryThresholdUsd ||
      avgDepth >= config.reversion.depthRecoveryThresholdUsd ||
      activeTargets >= config.reversion.minActiveTargetsForReversion;
    // Use newState timestamp for correct duration calculation after first detection
    const duration = newState.highLiquidityDetectedAt ? now - newState.highLiquidityDetectedAt : 0;
    if (recovered && duration >= config.reversion.sustainedRecoveryMs) {
      shouldSwitch = true;
      newMode = TradingMode.NORMAL;
      logger?.info?.(`🔄 Exiting scavenger mode: Market recovered`);
    }
  }

  if (shouldSwitch) {
    newState.mode = newMode;
    newState.modeEnteredAt = now;
  }

  return { shouldSwitch, newMode, reasons, newState };
}

// ============================================================================
// EXECUTION
// ============================================================================

/** Execute a sell order 
 * 
 * IMPORTANT: The minPrice validation is applied to the orderbook's best bid.
 * Callers should pass a minPrice based on curPrice (current market price), 
 * NOT avgPrice (entry price), to allow selling positions that have lost value.
 */
async function executeSell(client: ClobClient, position: Position, minPrice: number): Promise<OrderResult> {
  try {
    const book = await client.getOrderBook(position.tokenId);
    if (!book?.bids?.length) return { success: false, reason: "NO_BIDS" };

    const bestBid = parseFloat(book.bids[0].price);
    if (bestBid < minPrice) return { success: false, reason: "PRICE_TOO_LOW" };

    const signed = await client.createMarketOrder({
      side: Side.SELL,
      tokenID: position.tokenId,
      amount: position.size,
      price: bestBid,
    });
    const resp = await client.postOrder(signed, OrderType.FOK);

    return resp.success
      ? { success: true, filledUsd: position.size * bestBid, avgPrice: bestBid }
      : { success: false, reason: "ORDER_FAILED" };
  } catch (err) {
    return { success: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Process green position exit */
export async function processGreenExit(
  client: ClobClient,
  position: Position,
  state: ScavengerState,
  config: ScavengerConfig,
  logger?: Logger,
): Promise<{ result: ScavengerActionResult; newState: ScavengerState }> {
  if (!isGreenPosition(position, config.exit.minGreenProfitPct, config.exit.minAcceptableProfitUsd)) {
    return { result: { action: "NONE", reason: "Position not green enough" }, newState: state };
  }
  if (!isPriceStalled(state, position.tokenId, config.exit.stalledPriceThresholdMs)) {
    return { result: { action: "NONE", reason: "Price still moving" }, newState: state };
  }

  // Use curPrice with slippage for validation, not avgPrice
  // This allows green exits even if the orderbook bid is slightly below the API-reported curPrice
  const minPrice = position.curPrice * (1 - config.exit.conservativeSlippagePct / 100);

  logger?.info?.(`🦅 [SCAV] Green exit: ${position.outcome} | P&L: ${position.pnlPct.toFixed(1)}%`);

  const orderResult = await executeSell(client, position, minPrice);
  if (orderResult.success) {
    logger?.info?.(`✅ [SCAV] Green exit success: $${orderResult.filledUsd?.toFixed(2)}`);
    return {
      result: { action: "EXIT_GREEN", tokenId: position.tokenId, outcome: position.outcome, sizeUsd: orderResult.filledUsd, reason: `Green exit (${position.pnlPct.toFixed(1)}%)`, orderResult },
      newState: setTokenCooldown(state, position.tokenId, config.risk.tokenCooldownMs),
    };
  }
  return { result: { action: "NONE", reason: `Green exit failed: ${orderResult.reason}`, orderResult }, newState: state };
}

/** Process red position recovery */
export async function processRedRecovery(
  client: ClobClient,
  position: Position,
  state: ScavengerState,
  config: ScavengerConfig,
  logger?: Logger,
): Promise<{ result: ScavengerActionResult; newState: ScavengerState }> {
  if (!state.monitoredRedPositions.has(position.tokenId)) {
    if (position.pnlPct < 0) {
      const newMonitored = new Set(state.monitoredRedPositions);
      newMonitored.add(position.tokenId);
      return { result: { action: "NONE", reason: "Added to monitoring" }, newState: { ...state, monitoredRedPositions: newMonitored } };
    }
    return { result: { action: "NONE", reason: "Position not red" }, newState: state };
  }

  if (!hasRedPositionRecovered(position, config.redMonitor.smallProfitThresholdPct, config.redMonitor.minRecoveryProfitUsd)) {
    return { result: { action: "NONE", reason: "Not yet recovered" }, newState: state };
  }

  // Use curPrice with slippage for validation, not avgPrice
  // This allows recovery exits to happen based on current market conditions
  const minPrice = position.curPrice * (1 - config.exit.conservativeSlippagePct / 100);
  logger?.info?.(`🦅 [SCAV] Red recovered: ${position.outcome} | P&L: ${position.pnlPct.toFixed(1)}%`);

  const orderResult = await executeSell(client, position, minPrice);
  if (orderResult.success) {
    logger?.info?.(`✅ [SCAV] Recovery exit success: $${orderResult.filledUsd?.toFixed(2)}`);
    const newMonitored = new Set(state.monitoredRedPositions);
    newMonitored.delete(position.tokenId);
    return {
      result: { action: "EXIT_RED_RECOVERY", tokenId: position.tokenId, outcome: position.outcome, sizeUsd: orderResult.filledUsd, reason: `Recovery exit (${position.pnlPct.toFixed(1)}%)`, orderResult },
      newState: setTokenCooldown({ ...state, monitoredRedPositions: newMonitored }, position.tokenId, config.risk.tokenCooldownMs),
    };
  }
  return { result: { action: "NONE", reason: `Recovery failed: ${orderResult.reason}`, orderResult }, newState: state };
}

/** Run scavenger cycle */
export async function runScavengerCycle(
  client: ClobClient,
  positions: Position[],
  state: ScavengerState,
  config: ScavengerConfig,
  availableCapitalUsd: number,
  logger?: Logger,
): Promise<{ results: ScavengerActionResult[]; newState: ScavengerState }> {
  const results: ScavengerActionResult[] = [];
  let currentState = cleanExpiredCooldowns(state);

  // Update price history
  for (const p of positions) {
    currentState = updatePriceHistory(currentState, p.tokenId, p.curPrice, config.exit.stalledPriceThresholdMs * 2);
  }

  // Process green positions
  for (const p of positions) {
    if (p.pnlPct > 0) {
      const { result, newState } = await processGreenExit(client, p, currentState, config, logger);
      currentState = newState;
      if (result.action !== "NONE") results.push(result);
    }
  }

  // Process red positions
  for (const p of positions) {
    const { result, newState } = await processRedRecovery(client, p, currentState, config, logger);
    currentState = newState;
    if (result.action !== "NONE") results.push(result);
  }

  // Update tracking
  const scavPositions = positions.filter((p) => currentState.scavengerEntryPrices.has(p.tokenId));
  currentState.deployedCapitalUsd = scavPositions.reduce((s, p) => s + p.value, 0);
  currentState.scavengerPositionCount = scavPositions.length;

  return { results, newState: currentState };
}

// ============================================================================
// HELPERS
// ============================================================================

/** Check if in scavenger mode */
export function isScavengerMode(state: ScavengerState): boolean {
  return state.mode === TradingMode.SCAVENGER;
}

/** Format mode state */
export function formatModeState(state: ScavengerState): string {
  const duration = Math.floor((Date.now() - state.modeEnteredAt) / 60000);
  return `Mode: ${state.mode} (${duration}m)`;
}

/** Get scavenger summary */
export function getScavengerSummary(state: ScavengerState, config: ScavengerConfig): string {
  const cooldowns = Array.from(state.tokenCooldowns.values()).filter((e) => e > Date.now()).length;
  return [
    `🦅 Scavenger Mode Active`,
    `   Deployed: $${state.deployedCapitalUsd.toFixed(2)} / $${config.risk.maxDeployedCapitalUsd}`,
    `   Positions: ${state.scavengerPositionCount} / ${config.risk.maxScavengePositions}`,
    `   Red Monitored: ${state.monitoredRedPositions.size}`,
    `   Cooldowns: ${cooldowns}`,
  ].join("\n");
}

/** Load config from environment */
export function loadScavengerConfig(): ScavengerConfig {
  const envBool = (key: string, def: boolean) => {
    const v = process.env[key];
    return v === undefined ? def : v.toLowerCase() === "true" || v === "1";
  };
  const envNum = (key: string, def: number) => {
    const v = process.env[key];
    if (v === undefined) return def;
    const n = parseFloat(v);
    return isNaN(n) ? def : n;
  };

  return {
    enabled: envBool("SCAVENGER_ENABLED", DEFAULT_SCAVENGER_CONFIG.enabled),
    detection: {
      volumeThresholdUsd: envNum("SCAVENGER_VOLUME_THRESHOLD_USD", DEFAULT_SCAVENGER_CONFIG.detection.volumeThresholdUsd),
      volumeWindowMs: envNum("SCAVENGER_VOLUME_WINDOW_MS", DEFAULT_SCAVENGER_CONFIG.detection.volumeWindowMs),
      minOrderBookDepthUsd: envNum("SCAVENGER_MIN_ORDERBOOK_DEPTH_USD", DEFAULT_SCAVENGER_CONFIG.detection.minOrderBookDepthUsd),
      stagnantBookThresholdMs: envNum("SCAVENGER_STAGNANT_BOOK_THRESHOLD_MS", DEFAULT_SCAVENGER_CONFIG.detection.stagnantBookThresholdMs),
      minActiveTargets: envNum("SCAVENGER_MIN_ACTIVE_TARGETS", DEFAULT_SCAVENGER_CONFIG.detection.minActiveTargets),
      targetActivityWindowMs: envNum("SCAVENGER_TARGET_ACTIVITY_WINDOW_MS", DEFAULT_SCAVENGER_CONFIG.detection.targetActivityWindowMs),
      sustainedConditionMs: envNum("SCAVENGER_SUSTAINED_CONDITION_MS", DEFAULT_SCAVENGER_CONFIG.detection.sustainedConditionMs),
    },
    exit: {
      stalledPriceThresholdMs: envNum("SCAVENGER_STALLED_PRICE_THRESHOLD_MS", DEFAULT_SCAVENGER_CONFIG.exit.stalledPriceThresholdMs),
      minGreenProfitPct: envNum("SCAVENGER_MIN_GREEN_PROFIT_PCT", DEFAULT_SCAVENGER_CONFIG.exit.minGreenProfitPct),
      minAcceptableProfitUsd: envNum("SCAVENGER_MIN_ACCEPTABLE_PROFIT_USD", DEFAULT_SCAVENGER_CONFIG.exit.minAcceptableProfitUsd),
      conservativeSlippagePct: envNum("SCAVENGER_CONSERVATIVE_SLIPPAGE_PCT", DEFAULT_SCAVENGER_CONFIG.exit.conservativeSlippagePct),
    },
    redMonitor: {
      smallProfitThresholdPct: envNum("SCAVENGER_SMALL_PROFIT_THRESHOLD_PCT", DEFAULT_SCAVENGER_CONFIG.redMonitor.smallProfitThresholdPct),
      minRecoveryProfitUsd: envNum("SCAVENGER_MIN_RECOVERY_PROFIT_USD", DEFAULT_SCAVENGER_CONFIG.redMonitor.minRecoveryProfitUsd),
    },
    microBuy: {
      enabled: envBool("SCAVENGER_MICRO_BUY_ENABLED", DEFAULT_SCAVENGER_CONFIG.microBuy.enabled),
      minExpectedProfitUsd: envNum("SCAVENGER_MICRO_BUY_MIN_EXPECTED_PROFIT_USD", DEFAULT_SCAVENGER_CONFIG.microBuy.minExpectedProfitUsd),
      maxCapitalFraction: envNum("SCAVENGER_MICRO_BUY_MAX_CAPITAL_FRACTION", DEFAULT_SCAVENGER_CONFIG.microBuy.maxCapitalFraction),
      maxPositionUsd: envNum("SCAVENGER_MICRO_BUY_MAX_POSITION_USD", DEFAULT_SCAVENGER_CONFIG.microBuy.maxPositionUsd),
      minDiscountPct: envNum("SCAVENGER_MICRO_BUY_MIN_DISCOUNT_PCT", DEFAULT_SCAVENGER_CONFIG.microBuy.minDiscountPct),
      takeProfitPct: envNum("SCAVENGER_MICRO_BUY_TAKE_PROFIT_PCT", DEFAULT_SCAVENGER_CONFIG.microBuy.takeProfitPct),
    },
    risk: {
      maxDeployedCapitalUsd: envNum("SCAVENGER_MAX_DEPLOYED_CAPITAL_USD", DEFAULT_SCAVENGER_CONFIG.risk.maxDeployedCapitalUsd),
      maxScavengePositions: envNum("SCAVENGER_MAX_POSITIONS", DEFAULT_SCAVENGER_CONFIG.risk.maxScavengePositions),
      tokenCooldownMs: envNum("SCAVENGER_TOKEN_COOLDOWN_MS", DEFAULT_SCAVENGER_CONFIG.risk.tokenCooldownMs),
    },
    reversion: {
      volumeRecoveryThresholdUsd: envNum("SCAVENGER_VOLUME_RECOVERY_THRESHOLD_USD", DEFAULT_SCAVENGER_CONFIG.reversion.volumeRecoveryThresholdUsd),
      depthRecoveryThresholdUsd: envNum("SCAVENGER_DEPTH_RECOVERY_THRESHOLD_USD", DEFAULT_SCAVENGER_CONFIG.reversion.depthRecoveryThresholdUsd),
      minActiveTargetsForReversion: envNum("SCAVENGER_MIN_ACTIVE_TARGETS_REVERSION", DEFAULT_SCAVENGER_CONFIG.reversion.minActiveTargetsForReversion),
      sustainedRecoveryMs: envNum("SCAVENGER_SUSTAINED_RECOVERY_MS", DEFAULT_SCAVENGER_CONFIG.reversion.sustainedRecoveryMs),
    },
  };
}
