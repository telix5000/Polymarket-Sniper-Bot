/**
 * V2 Scavenger - Scavenger mode execution logic
 *
 * Implements the capital preservation strategy during low liquidity periods:
 * - Exit green positions opportunistically
 * - Monitor red positions passively (sell when they turn green)
 * - Opportunistic micro-buys with strict risk constraints
 */

import type { ClobClient } from "@polymarket/clob-client";
import { Side, OrderType } from "@polymarket/clob-client";
import type { Position, Logger, OrderResult } from "./types";
import type { ScavengerConfig } from "./scavenger-config";
import { ORDER } from "./constants";

/**
 * Minimum price change threshold (0.1%) to consider price as "moving"
 * Below this threshold, price is considered stalled
 */
const MIN_PRICE_CHANGE_THRESHOLD = 0.001;

/**
 * Scavenger execution state
 */
export interface ScavengerState {
  /**
   * Token IDs on cooldown after exit (tokenId -> cooldown expiry timestamp)
   */
  tokenCooldowns: Map<string, number>;

  /**
   * Price history for stall detection (tokenId -> price samples with timestamps)
   */
  priceHistory: Map<string, Array<{ price: number; timestamp: number }>>;

  /**
   * Total capital currently deployed in scavenger positions (USD)
   */
  deployedCapitalUsd: number;

  /**
   * Count of positions opened in scavenger mode
   */
  scavengerPositionCount: number;

  /**
   * Positions that were red but we're monitoring for recovery
   */
  monitoredRedPositions: Set<string>;

  /**
   * Entry prices for scavenger mode positions (for take-profit tracking)
   */
  scavengerEntryPrices: Map<string, number>;
}

/**
 * Scavenger action result
 */
export interface ScavengerActionResult {
  action: "EXIT_GREEN" | "EXIT_RED_RECOVERY" | "MICRO_BUY" | "NONE";
  tokenId?: string;
  outcome?: string;
  sizeUsd?: number;
  reason: string;
  orderResult?: OrderResult;
}

/**
 * Create initial scavenger state
 */
export function createScavengerState(): ScavengerState {
  return {
    tokenCooldowns: new Map(),
    priceHistory: new Map(),
    deployedCapitalUsd: 0,
    scavengerPositionCount: 0,
    monitoredRedPositions: new Set(),
    scavengerEntryPrices: new Map(),
  };
}

/**
 * Reset scavenger state on mode exit
 */
export function resetScavengerState(state: ScavengerState): ScavengerState {
  return {
    ...state,
    // Keep cooldowns - they should persist across mode switches
    // Reset tracking
    priceHistory: new Map(),
    deployedCapitalUsd: 0,
    scavengerPositionCount: 0,
    monitoredRedPositions: new Set(),
    scavengerEntryPrices: new Map(),
  };
}

/**
 * Update price history for a position
 */
export function updatePriceHistory(
  state: ScavengerState,
  tokenId: string,
  currentPrice: number,
  maxAge: number = 60000, // 1 minute default
): ScavengerState {
  const now = Date.now();
  const cutoff = now - maxAge;

  const existing = state.priceHistory.get(tokenId) || [];
  const filtered = existing.filter((s) => s.timestamp > cutoff);
  filtered.push({ price: currentPrice, timestamp: now });

  const newHistory = new Map(state.priceHistory);
  newHistory.set(tokenId, filtered.slice(-50)); // Keep max 50 samples

  return {
    ...state,
    priceHistory: newHistory,
  };
}

/**
 * Check if price has stalled (no upward movement)
 */
export function isPriceStalled(
  state: ScavengerState,
  tokenId: string,
  thresholdMs: number,
): boolean {
  const history = state.priceHistory.get(tokenId);
  if (!history || history.length < 2) return false;

  const cutoff = Date.now() - thresholdMs;
  const recentSamples = history.filter((s) => s.timestamp > cutoff);

  if (recentSamples.length < 2) return false;

  // Check if price has increased at all in the window
  const firstPrice = recentSamples[0].price;
  const latestPrice = recentSamples[recentSamples.length - 1].price;

  // Consider stalled if price hasn't increased by more than threshold
  const priceChange = (latestPrice - firstPrice) / firstPrice;
  return priceChange < MIN_PRICE_CHANGE_THRESHOLD;
}

/**
 * Check if token is on cooldown
 */
export function isOnCooldown(state: ScavengerState, tokenId: string): boolean {
  const expiry = state.tokenCooldowns.get(tokenId);
  if (!expiry) return false;
  return Date.now() < expiry;
}

/**
 * Set token cooldown
 */
export function setTokenCooldown(
  state: ScavengerState,
  tokenId: string,
  cooldownMs: number,
): ScavengerState {
  const newCooldowns = new Map(state.tokenCooldowns);
  newCooldowns.set(tokenId, Date.now() + cooldownMs);

  return {
    ...state,
    tokenCooldowns: newCooldowns,
  };
}

/**
 * Clean expired cooldowns
 */
export function cleanExpiredCooldowns(state: ScavengerState): ScavengerState {
  const now = Date.now();
  const newCooldowns = new Map<string, number>();

  state.tokenCooldowns.forEach((expiry, tokenId) => {
    if (expiry > now) {
      newCooldowns.set(tokenId, expiry);
    }
  });

  return {
    ...state,
    tokenCooldowns: newCooldowns,
  };
}

/**
 * Check if position is green with sufficient profit
 */
export function isGreenPosition(
  position: Position,
  minProfitPct: number,
  minProfitUsd: number,
): boolean {
  return position.pnlPct >= minProfitPct && position.pnlUsd >= minProfitUsd;
}

/**
 * Check if a red position has recovered to profitable
 */
export function hasRedPositionRecovered(
  position: Position,
  smallProfitPct: number,
  minRecoveryUsd: number,
): boolean {
  return position.pnlPct >= smallProfitPct && position.pnlUsd >= minRecoveryUsd;
}

/**
 * Calculate expected profit for a micro-buy opportunity
 */
export function calculateExpectedProfit(
  currentPrice: number,
  recentHighPrice: number,
  sizeUsd: number,
): number {
  // Expected profit = (target price - current price) * shares
  // Target price is back to recent high
  const shares = sizeUsd / currentPrice;
  const targetValue = shares * recentHighPrice;
  return targetValue - sizeUsd;
}

/**
 * Post a sell order (used for scavenger exits)
 */
async function executeSell(
  client: ClobClient,
  position: Position,
  minPrice: number,
  logger?: Logger,
): Promise<OrderResult> {
  try {
    const orderBook = await client.getOrderBook(position.tokenId);
    if (!orderBook?.bids?.length) {
      return { success: false, reason: "NO_BIDS" };
    }

    const bestBid = parseFloat(orderBook.bids[0].price);

    if (bestBid < minPrice) {
      return { success: false, reason: "PRICE_TOO_LOW" };
    }

    // Use limit sell at best bid
    const signed = await client.createMarketOrder({
      side: Side.SELL,
      tokenID: position.tokenId,
      amount: position.size,
      price: bestBid,
    });

    const resp = await client.postOrder(signed, OrderType.FOK);

    if (resp.success) {
      return {
        success: true,
        filledUsd: position.size * bestBid,
        avgPrice: bestBid,
      };
    }

    return { success: false, reason: "ORDER_FAILED" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, reason: msg };
  }
}

/**
 * Process green position exit in scavenger mode
 */
export async function processGreenExit(
  client: ClobClient,
  position: Position,
  state: ScavengerState,
  config: ScavengerConfig,
  logger?: Logger,
): Promise<{ result: ScavengerActionResult; newState: ScavengerState }> {
  // Check if position is green
  if (
    !isGreenPosition(
      position,
      config.exit.minGreenProfitPct,
      config.exit.minAcceptableProfitUsd,
    )
  ) {
    return {
      result: { action: "NONE", reason: "Position not green enough" },
      newState: state,
    };
  }

  // Check if price is stalled
  if (
    !isPriceStalled(
      state,
      position.tokenId,
      config.exit.stalledPriceThresholdMs,
    )
  ) {
    return {
      result: { action: "NONE", reason: "Price still moving" },
      newState: state,
    };
  }

  // Calculate minimum acceptable price
  const costBasis = position.avgPrice * position.size;
  const minAcceptableValue = costBasis + config.exit.minAcceptableProfitUsd;
  const minPrice = minAcceptableValue / position.size;

  logger?.info?.(
    `🦅 [SCAV] Attempting green exit: ${position.outcome} | ` +
      `P&L: ${position.pnlPct.toFixed(1)}% ($${position.pnlUsd.toFixed(2)}) | ` +
      `Min price: ${(minPrice * 100).toFixed(1)}¢`,
  );

  const orderResult = await executeSell(client, position, minPrice, logger);

  if (orderResult.success) {
    logger?.info?.(
      `✅ [SCAV] Green exit success: ${position.outcome} | ` +
        `Filled $${orderResult.filledUsd?.toFixed(2)} @ ${((orderResult.avgPrice ?? 0) * 100).toFixed(1)}¢`,
    );

    const newState = setTokenCooldown(
      state,
      position.tokenId,
      config.risk.tokenCooldownMs,
    );

    return {
      result: {
        action: "EXIT_GREEN",
        tokenId: position.tokenId,
        outcome: position.outcome,
        sizeUsd: orderResult.filledUsd,
        reason: `Green exit (P&L: ${position.pnlPct.toFixed(1)}%, stalled)`,
        orderResult,
      },
      newState,
    };
  }

  return {
    result: {
      action: "NONE",
      reason: `Green exit failed: ${orderResult.reason}`,
      orderResult,
    },
    newState: state,
  };
}

/**
 * Process red position recovery exit
 */
export async function processRedRecovery(
  client: ClobClient,
  position: Position,
  state: ScavengerState,
  config: ScavengerConfig,
  logger?: Logger,
): Promise<{ result: ScavengerActionResult; newState: ScavengerState }> {
  // Check if this is a monitored red position
  if (!state.monitoredRedPositions.has(position.tokenId)) {
    // Add to monitoring if currently red
    if (position.pnlPct < 0) {
      const newMonitored = new Set(state.monitoredRedPositions);
      newMonitored.add(position.tokenId);
      return {
        result: { action: "NONE", reason: "Added red position to monitoring" },
        newState: { ...state, monitoredRedPositions: newMonitored },
      };
    }
    return {
      result: { action: "NONE", reason: "Position not red" },
      newState: state,
    };
  }

  // Check if position has recovered
  if (
    !hasRedPositionRecovered(
      position,
      config.redMonitor.smallProfitThresholdPct,
      config.redMonitor.minRecoveryProfitUsd,
    )
  ) {
    return {
      result: { action: "NONE", reason: "Red position not yet recovered" },
      newState: state,
    };
  }

  // Position recovered - sell immediately
  const minPrice =
    position.avgPrice * (1 - config.exit.conservativeSlippagePct / 100);

  logger?.info?.(
    `🦅 [SCAV] Red position recovered! ${position.outcome} | ` +
      `P&L: ${position.pnlPct.toFixed(1)}% ($${position.pnlUsd.toFixed(2)}) | ` +
      `Selling to flatten`,
  );

  const orderResult = await executeSell(client, position, minPrice, logger);

  if (orderResult.success) {
    logger?.info?.(
      `✅ [SCAV] Recovery exit success: ${position.outcome} | ` +
        `Filled $${orderResult.filledUsd?.toFixed(2)} @ ${((orderResult.avgPrice ?? 0) * 100).toFixed(1)}¢`,
    );

    const newMonitored = new Set(state.monitoredRedPositions);
    newMonitored.delete(position.tokenId);

    const newState = setTokenCooldown(
      { ...state, monitoredRedPositions: newMonitored },
      position.tokenId,
      config.risk.tokenCooldownMs,
    );

    return {
      result: {
        action: "EXIT_RED_RECOVERY",
        tokenId: position.tokenId,
        outcome: position.outcome,
        sizeUsd: orderResult.filledUsd,
        reason: `Red recovery exit (P&L: ${position.pnlPct.toFixed(1)}%)`,
        orderResult,
      },
      newState,
    };
  }

  return {
    result: {
      action: "NONE",
      reason: `Recovery exit failed: ${orderResult.reason}`,
      orderResult,
    },
    newState: state,
  };
}

/**
 * Check if micro-buy is allowed under risk constraints
 */
export function canMicroBuy(
  state: ScavengerState,
  config: ScavengerConfig,
  availableCapitalUsd: number,
  tokenId: string,
): { allowed: boolean; reason?: string; maxSizeUsd?: number } {
  // Check if enabled
  if (!config.microBuy.enabled) {
    return { allowed: false, reason: "Micro-buys disabled" };
  }

  // Check cooldown
  if (isOnCooldown(state, tokenId)) {
    return { allowed: false, reason: "Token on cooldown" };
  }

  // Check position count
  if (state.scavengerPositionCount >= config.risk.maxScavengePositions) {
    return {
      allowed: false,
      reason: `Max positions (${config.risk.maxScavengePositions}) reached`,
    };
  }

  // Check deployed capital
  if (state.deployedCapitalUsd >= config.risk.maxDeployedCapitalUsd) {
    return {
      allowed: false,
      reason: `Max deployed capital ($${config.risk.maxDeployedCapitalUsd}) reached`,
    };
  }

  // Calculate max size
  const remainingCapital =
    config.risk.maxDeployedCapitalUsd - state.deployedCapitalUsd;
  const capitalFractionMax =
    availableCapitalUsd * config.microBuy.maxCapitalFraction;
  const maxSizeUsd = Math.min(
    config.microBuy.maxPositionUsd,
    capitalFractionMax,
    remainingCapital,
  );

  if (maxSizeUsd < ORDER.MIN_ORDER_USD) {
    return { allowed: false, reason: "Max size too small" };
  }

  return { allowed: true, maxSizeUsd };
}

/**
 * Run scavenger mode cycle on positions
 */
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

  // Update price history for all positions
  for (const position of positions) {
    currentState = updatePriceHistory(
      currentState,
      position.tokenId,
      position.curPrice,
      config.exit.stalledPriceThresholdMs * 2,
    );
  }

  // A) Process green positions for opportunistic exit
  for (const position of positions) {
    if (position.pnlPct > 0) {
      const { result, newState } = await processGreenExit(
        client,
        position,
        currentState,
        config,
        logger,
      );
      currentState = newState;
      if (result.action !== "NONE") {
        results.push(result);
      }
    }
  }

  // B) Process red positions for recovery
  for (const position of positions) {
    const { result, newState } = await processRedRecovery(
      client,
      position,
      currentState,
      config,
      logger,
    );
    currentState = newState;
    if (result.action !== "NONE") {
      results.push(result);
    }
  }

  // C) Micro-buys are handled separately by the caller (copy trading integration)
  // This keeps scavenger logic modular

  // Update deployed capital tracking
  const scavengerPositions = positions.filter((p) =>
    currentState.scavengerEntryPrices.has(p.tokenId),
  );
  currentState.deployedCapitalUsd = scavengerPositions.reduce(
    (sum, p) => sum + p.value,
    0,
  );
  currentState.scavengerPositionCount = scavengerPositions.length;

  return { results, newState: currentState };
}

/**
 * Get scavenger mode summary for logging
 */
export function getScavengerSummary(
  state: ScavengerState,
  config: ScavengerConfig,
): string {
  const cooldownCount = Array.from(state.tokenCooldowns.values()).filter(
    (exp) => exp > Date.now(),
  ).length;

  return [
    `🦅 Scavenger Mode Active`,
    `   Deployed: $${state.deployedCapitalUsd.toFixed(2)} / $${config.risk.maxDeployedCapitalUsd}`,
    `   Positions: ${state.scavengerPositionCount} / ${config.risk.maxScavengePositions}`,
    `   Red Monitored: ${state.monitoredRedPositions.size}`,
    `   Cooldowns: ${cooldownCount}`,
  ].join("\n");
}
