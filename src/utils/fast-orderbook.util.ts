/**
 * Fast Orderbook Reader - Bypasses VPN for read-only CLOB API calls
 *
 * PROBLEM:
 * VPN adds latency to ALL API calls, including read-only operations like
 * fetching orderbooks. In hot markets, this latency can cost money:
 * - Stale prices lead to bad trading decisions
 * - Slow orderbook fetches miss opportunities
 *
 * SOLUTION:
 * This module provides a fast, unauthenticated HTTP client that fetches
 * orderbook data DIRECTLY (bypassing VPN) for maximum speed.
 *
 * SECURITY:
 * - Read-only operations don't require authentication
 * - No credentials are sent through the direct connection
 * - Writes (orders, auth) still go through VPN via the authenticated client
 *
 * USAGE:
 * Set CLOB_BYPASS_VPN_FOR_READS=true to enable (default: true)
 * The system will automatically use the fast reader for orderbook fetches
 * while keeping order submission through the authenticated VPN client.
 */

import type { OrderBookSummary } from "@polymarket/clob-client";
import { POLYMARKET_API } from "../constants/polymarket.constants";

// Read-only CLOB API endpoints (no auth required)
const CLOB_HOST = POLYMARKET_API.BASE_URL;

/**
 * Configuration for fast orderbook reads
 */
export interface FastOrderbookConfig {
  /** Enable bypassing VPN for reads (default: true) */
  enabled: boolean;
  /** Timeout for orderbook fetches in ms (default: 5000) */
  timeoutMs: number;
}

/**
 * Read environment variable with case-insensitive fallback.
 * Checks both UPPER_CASE and lower_case versions for flexibility.
 * This matches the pattern used elsewhere in the codebase (vpn-rpc-bypass.util.ts).
 */
const readEnv = (key: string): string | undefined =>
  process.env[key] ?? process.env[key.toLowerCase()];

const parseBool = (raw: string | undefined, defaultValue: boolean): boolean => {
  if (raw === undefined || raw === "") return defaultValue;
  return raw.toLowerCase() === "true";
};

/**
 * Get fast orderbook configuration from environment variables.
 *
 * Environment variables:
 * - CLOB_BYPASS_VPN_FOR_READS: Enable direct (non-VPN) orderbook fetches (default: true)
 * - CLOB_READ_TIMEOUT_MS: Timeout for direct orderbook fetches in milliseconds (default: 5000)
 */
export const getFastOrderbookConfig = (): FastOrderbookConfig => ({
  enabled: parseBool(readEnv("CLOB_BYPASS_VPN_FOR_READS"), true),
  timeoutMs: parseInt(readEnv("CLOB_READ_TIMEOUT_MS") ?? "5000", 10),
});

/**
 * Extracted orderbook prices with safety checks
 */
export interface OrderbookPrices {
  bestBid: number | null;
  bestAsk: number | null;
  bidCount: number;
  askCount: number;
  timestamp: number;
}

/**
 * Fast orderbook fetch result
 */
export interface FastOrderbookResult {
  success: boolean;
  orderbook?: OrderBookSummary;
  prices?: OrderbookPrices;
  latencyMs: number;
  source: "direct" | "vpn_fallback";
  error?: string;
}

/**
 * Fetch orderbook directly (bypassing VPN) for maximum speed
 *
 * This is a lightweight HTTP fetch that doesn't require authentication.
 * It's used for read-only operations where speed is critical.
 *
 * @param tokenId - The token ID to fetch orderbook for
 * @param config - Optional configuration override
 * @returns FastOrderbookResult with orderbook data and latency info
 */
export async function fetchOrderbookDirect(
  tokenId: string,
  config?: Partial<FastOrderbookConfig>,
): Promise<FastOrderbookResult> {
  const cfg = { ...getFastOrderbookConfig(), ...config };
  const startMs = Date.now();

  if (!cfg.enabled) {
    return {
      success: false,
      latencyMs: 0,
      source: "vpn_fallback",
      error: "Direct reads disabled (CLOB_BYPASS_VPN_FOR_READS=false)",
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), cfg.timeoutMs);

  try {
    const url = `${CLOB_HOST}/book?token_id=${tokenId}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        success: false,
        latencyMs: Date.now() - startMs,
        source: "direct",
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const orderbook = (await response.json()) as OrderBookSummary;
    const latencyMs = Date.now() - startMs;

    // Extract prices for convenience
    const prices = extractPrices(orderbook);

    return {
      success: true,
      orderbook,
      prices,
      latencyMs,
      source: "direct",
    };
  } catch (err) {
    const latencyMs = Date.now() - startMs;
    const errorMsg = err instanceof Error ? err.message : String(err);

    // Check for abort (timeout)
    if (errorMsg.includes("aborted") || errorMsg.includes("abort")) {
      return {
        success: false,
        latencyMs,
        source: "direct",
        error: `Timeout after ${cfg.timeoutMs}ms`,
      };
    }

    return {
      success: false,
      latencyMs,
      source: "direct",
      error: errorMsg,
    };
  } finally {
    // Always clear timeout to prevent memory leak
    clearTimeout(timeoutId);
  }
}

/**
 * Extract best bid/ask prices from orderbook with safety checks
 */
function extractPrices(orderbook: OrderBookSummary): OrderbookPrices {
  const bids = orderbook.bids ?? [];
  const asks = orderbook.asks ?? [];

  let bestBid: number | null = null;
  let bestAsk: number | null = null;

  // Find best bid (highest)
  if (bids.length > 0) {
    const bidPrices = bids.map((b) => parseFloat(b.price)).filter((p) => !isNaN(p) && p > 0);
    if (bidPrices.length > 0) {
      bestBid = Math.max(...bidPrices);
    }
  }

  // Find best ask (lowest)
  if (asks.length > 0) {
    const askPrices = asks.map((a) => parseFloat(a.price)).filter((p) => !isNaN(p) && p > 0);
    if (askPrices.length > 0) {
      bestAsk = Math.min(...askPrices);
    }
  }

  return {
    bestBid,
    bestAsk,
    bidCount: bids.length,
    askCount: asks.length,
    timestamp: Date.now(),
  };
}

/**
 * Fetch orderbook with automatic fallback
 *
 * Tries direct (fast) fetch first, falls back to VPN client if needed.
 *
 * @param tokenId - The token ID to fetch
 * @param vpnFallback - Async function to call VPN client's getOrderBook
 * @param logger - Optional logger for diagnostics
 */
export async function fetchOrderbookWithFallback(
  tokenId: string,
  vpnFallback: () => Promise<OrderBookSummary>,
  logger?: { debug: (msg: string) => void; warn: (msg: string) => void },
): Promise<{ orderbook: OrderBookSummary; source: "direct" | "vpn_fallback"; latencyMs: number }> {
  const config = getFastOrderbookConfig();

  if (config.enabled) {
    const directResult = await fetchOrderbookDirect(tokenId);

    if (directResult.success && directResult.orderbook) {
      logger?.debug(
        `[FastOrderbook] Direct fetch: tokenId=${tokenId.slice(0, 12)}... ` +
          `bestBid=${directResult.prices?.bestBid !== null ? (directResult.prices!.bestBid * 100).toFixed(1) + "¢" : "null"} ` +
          `bestAsk=${directResult.prices?.bestAsk !== null ? (directResult.prices!.bestAsk * 100).toFixed(1) + "¢" : "null"} ` +
          `latency=${directResult.latencyMs}ms`,
      );
      return {
        orderbook: directResult.orderbook,
        source: "direct",
        latencyMs: directResult.latencyMs,
      };
    }

    // Direct fetch failed, log and fallback
    logger?.warn(
      `[FastOrderbook] Direct fetch failed for ${tokenId.slice(0, 12)}...: ${directResult.error}. ` +
        `Falling back to VPN client.`,
    );
  }

  // Fallback to VPN client
  const startMs = Date.now();
  const orderbook = await vpnFallback();
  const latencyMs = Date.now() - startMs;

  logger?.debug(
    `[FastOrderbook] VPN fallback: tokenId=${tokenId.slice(0, 12)}... latency=${latencyMs}ms`,
  );

  return {
    orderbook,
    source: "vpn_fallback",
    latencyMs,
  };
}

/**
 * Batch fetch multiple orderbooks directly for efficiency
 *
 * Useful when you need to check multiple markets quickly.
 * Each fetch is independent - failures don't affect others.
 */
export async function fetchOrderbooksBatch(
  tokenIds: string[],
  config?: Partial<FastOrderbookConfig>,
): Promise<Map<string, FastOrderbookResult>> {
  const results = new Map<string, FastOrderbookResult>();

  // Fetch all in parallel for maximum speed
  const promises = tokenIds.map(async (tokenId) => {
    const result = await fetchOrderbookDirect(tokenId, config);
    results.set(tokenId, result);
  });

  await Promise.all(promises);
  return results;
}
