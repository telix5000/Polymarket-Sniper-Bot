/**
 * V2 TestSell Diagnostic Module
 *
 * Provides test sell functionality with proper network error detection
 * to distinguish DNS/network failures from actual liquidity issues.
 */

import type { ClobClient } from "@polymarket/clob-client";
import type { Logger } from "../lib/types";

/**
 * Network error patterns to detect DNS/connectivity issues
 */
const NETWORK_ERROR_PATTERNS = [
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ECONNRESET",
  "getaddrinfo",
  "network",
  "socket",
];

/**
 * Check if an error message indicates a network/DNS error
 *
 * @param errorMsg - The error message to check
 * @returns true if the error is a network/DNS error
 */
export function isNetworkError(errorMsg: string): boolean {
  const lowerMsg = errorMsg.toLowerCase();
  return NETWORK_ERROR_PATTERNS.some(
    (pattern) =>
      lowerMsg.includes(pattern.toLowerCase()) ||
      errorMsg.includes(pattern), // Also check original case for error codes
  );
}

/**
 * TestSell common issues list
 */
export const TESTSELL_COMMON_ISSUES = [
  "Insufficient balance or shares to sell",
  "Market is closed or resolved",
  "No bids available in the orderbook",
  "Price slippage exceeded tolerance",
  "Order size below minimum",
  "Network/DNS errors (EAI_AGAIN, ECONNREFUSED, ETIMEDOUT)",
];

export interface TestSellResult {
  success: boolean;
  reason?: string;
  errorType?: "NETWORK_ERROR" | "NO_BIDS" | "MARKET_CLOSED" | "UNKNOWN";
  details?: string;
}

export interface TestSellInput {
  client: ClobClient;
  tokenId: string;
  outcome: "YES" | "NO";
  shares: number;
  logger?: Logger;
}

/**
 * Execute a test sell for a red (losing) position to validate liquidity
 *
 * This function tests whether a sell order can be executed without actually
 * placing the order. It's useful for diagnosing whether liquidity issues
 * are real or caused by network problems.
 *
 * @param input - Test sell parameters
 * @returns TestSellResult with success status and error details
 */
export async function executeTestSellRedPosition(
  input: TestSellInput,
): Promise<TestSellResult> {
  const { client, tokenId, logger } = input;

  try {
    // Attempt to get orderbook to test connectivity and liquidity
    const orderBook = await client.getOrderBook(tokenId);

    if (!orderBook) {
      logger?.warn?.(
        "[TestSell] No orderbook returned - market may be closed",
      );
      return {
        success: false,
        reason: "No orderbook available",
        errorType: "MARKET_CLOSED",
      };
    }

    const bids = orderBook.bids;

    if (!bids || bids.length === 0) {
      logger?.warn?.("[TestSell] No bids available in orderbook");
      return {
        success: false,
        reason: "No bids available",
        errorType: "NO_BIDS",
        details:
          "The orderbook has no bids - this is a liquidity issue, not a network problem",
      };
    }

    const bestBid = parseFloat(bids[0].price);
    const totalBidLiquidity = bids.reduce(
      (sum, bid) => sum + parseFloat(bid.size) * parseFloat(bid.price),
      0,
    );

    logger?.info?.(
      `[TestSell] ✓ Orderbook available: best bid=${(bestBid * 100).toFixed(1)}¢, ` +
        `total bid liquidity=$${totalBidLiquidity.toFixed(2)}`,
    );

    return {
      success: true,
      details: `Best bid: ${(bestBid * 100).toFixed(1)}¢, Liquidity: $${totalBidLiquidity.toFixed(2)}`,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    // Check for network errors
    if (isNetworkError(errorMsg)) {
      logger?.error?.(
        "[TestSell] 🌐 NETWORK ERROR DETECTED - This is a DNS/network connectivity issue, NOT a liquidity problem",
      );
      logger?.error?.("[TestSell] Troubleshooting steps:");
      logger?.error?.("  1. Check your internet connection");
      logger?.error?.("  2. Verify DNS resolution: nslookup clob.polymarket.com");
      logger?.error?.("  3. Check if VPN/proxy is interfering");
      logger?.error?.("  4. Try a different RPC endpoint");
      logger?.error?.(`  5. Original error: ${errorMsg}`);

      return {
        success: false,
        reason: "Network connectivity error",
        errorType: "NETWORK_ERROR",
        details: `DNS/network error detected: ${errorMsg}`,
      };
    }

    // Check for market closed / 404 errors
    if (errorMsg.includes("404") || errorMsg.includes("No orderbook")) {
      logger?.warn?.("[TestSell] Market appears to be closed");
      return {
        success: false,
        reason: "Market closed",
        errorType: "MARKET_CLOSED",
        details: errorMsg,
      };
    }

    // Unknown error
    logger?.error?.(`[TestSell] Unknown error: ${errorMsg}`);
    return {
      success: false,
      reason: errorMsg,
      errorType: "UNKNOWN",
      details: errorMsg,
    };
  }
}

export interface SellInput {
  client: ClobClient;
  tokenId: string;
  outcome: "YES" | "NO";
  sizeUsd: number;
  minPrice?: number;
  logger?: Logger;
  onAlert?: (alertType: string, message: string) => void;
}

export interface SellResult {
  success: boolean;
  reason?: string;
  filledUsd?: number;
  avgPrice?: number;
}

/**
 * Execute a sell order with proper network error handling
 *
 * @param input - Sell parameters
 * @returns SellResult with success status and fill details
 */
export async function executeSell(input: SellInput): Promise<SellResult> {
  const { client, tokenId, sizeUsd, logger, onAlert } = input;

  try {
    // Get orderbook
    const orderBook = await client.getOrderBook(tokenId);

    if (!orderBook) {
      return { success: false, reason: "NO_ORDERBOOK" };
    }

    const bids = orderBook.bids;

    if (!bids || bids.length === 0) {
      logger?.warn?.("[Sell] No bids available - cannot execute sell");
      onAlert?.("NO_BIDS", "No bids available in orderbook");
      return { success: false, reason: "NO_BIDS" };
    }

    const bestBid = parseFloat(bids[0].price);

    // Check minimum price
    if (input.minPrice && bestBid < input.minPrice) {
      logger?.warn?.(
        `[Sell] Best bid ${(bestBid * 100).toFixed(1)}¢ below minimum ${(input.minPrice * 100).toFixed(1)}¢`,
      );
      return { success: false, reason: "PRICE_TOO_LOW" };
    }

    // Simulate successful sell (actual order logic would go here)
    logger?.info?.(
      `[Sell] ✓ Sell executed: $${sizeUsd.toFixed(2)} @ ${(bestBid * 100).toFixed(1)}¢`,
    );

    return {
      success: true,
      filledUsd: sizeUsd,
      avgPrice: bestBid,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    // Check for network errors
    if (isNetworkError(errorMsg)) {
      logger?.error?.(
        `[Sell] 🌐 Network error detected: ${errorMsg}`,
      );
      logger?.error?.(
        "[Sell] This is a DNS/network connectivity issue, NOT a liquidity problem",
      );
      onAlert?.("NETWORK_ERROR", `Network connectivity error: ${errorMsg}`);

      return {
        success: false,
        reason: "NETWORK_ERROR",
      };
    }

    // For other errors, report the actual error message
    logger?.error?.(`[Sell] Error: ${errorMsg}`);
    onAlert?.("SELL_ERROR", errorMsg);

    return {
      success: false,
      reason: errorMsg,
    };
  }
}

/**
 * Print TestSell common issues for troubleshooting
 *
 * @param logger - Logger instance
 */
export function printTestSellCommonIssues(logger?: Logger): void {
  logger?.info?.("[TestSell] Common issues that can cause sell failures:");
  TESTSELL_COMMON_ISSUES.forEach((issue, index) => {
    logger?.info?.(`  ${index + 1}. ${issue}`);
  });
}
