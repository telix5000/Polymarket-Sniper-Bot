/**
 * Market Token Utilities
 *
 * Utilities for working with Polymarket market tokens.
 * Used by hedging strategies to find opposite tokens for binary markets.
 */

import { httpGet } from "./fetch-data.util";
import { POLYMARKET_API } from "../constants/polymarket.constants";
import type { ConsoleLogger } from "./logger.util";

/**
 * Token information from Gamma API
 */
export interface MarketToken {
  tokenId: string;
  outcome: string;
  price?: number;
}

/**
 * Market tokens response from the lookup function
 */
export interface MarketTokensResult {
  success: boolean;
  marketId?: string;
  question?: string;
  tokens?: MarketToken[];
  isBinaryMarket?: boolean;
  error?: string;
}

/**
 * Gamma API market response structure
 */
interface GammaMarketResponse {
  condition_id?: string;
  id?: string;
  question?: string;
  outcomes?: string; // JSON string like '["Yes", "No"]'
  outcomePrices?: string; // JSON string like '["0.4", "0.6"]'
  tokens?: Array<{
    token_id?: string;
    outcome?: string;
    price?: string | number;
  }>;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
}

// Cache for market token lookups (persists across calls)
// Key: tokenId, Value: MarketTokensResult
const marketTokensCache = new Map<string, MarketTokensResult>();
const MAX_CACHE_SIZE = 500;

/**
 * Fetch all tokens for a market given any token ID from that market.
 *
 * This is useful for hedging strategies that need to find the opposite token
 * in a binary market (YES <-> NO).
 *
 * @param tokenId - Any token ID from the market
 * @param logger - Optional logger for debug output
 * @param timeout - API timeout in milliseconds (default: 10000)
 * @returns MarketTokensResult with all tokens or error details
 */
export async function getMarketTokens(
  tokenId: string,
  logger?: ConsoleLogger,
  timeout: number = 10000,
): Promise<MarketTokensResult> {
  if (!tokenId || typeof tokenId !== "string" || tokenId.trim() === "") {
    return { success: false, error: "Invalid tokenId provided" };
  }

  const trimmedTokenId = tokenId.trim();

  // Check cache first
  const cached = marketTokensCache.get(trimmedTokenId);
  if (cached) {
    logger?.debug(`[MarketTokens] Cache hit for token ${trimmedTokenId}`);
    return cached;
  }

  try {
    const encodedTokenId = encodeURIComponent(trimmedTokenId);
    const url = `${POLYMARKET_API.GAMMA_API_BASE_URL}/markets?clob_token_ids=${encodedTokenId}`;

    logger?.debug(`[MarketTokens] Fetching market data from ${url}`);

    const markets = await httpGet<GammaMarketResponse[]>(url, { timeout });

    if (!markets || !Array.isArray(markets) || markets.length === 0) {
      const result: MarketTokensResult = {
        success: false,
        error: `No market found for tokenId ${trimmedTokenId}`,
      };
      return result;
    }

    const market = markets[0];
    const marketId = market.condition_id ?? market.id;

    if (!marketId) {
      const result: MarketTokensResult = {
        success: false,
        error: "Market found but missing ID",
      };
      return result;
    }

    // Parse tokens from the market response
    const tokens: MarketToken[] = [];

    if (market.tokens && Array.isArray(market.tokens)) {
      // Use the tokens array directly
      for (const token of market.tokens) {
        if (token.token_id && token.outcome) {
          const price =
            typeof token.price === "string"
              ? parseFloat(token.price)
              : typeof token.price === "number"
                ? token.price
                : undefined;

          tokens.push({
            tokenId: token.token_id,
            outcome: token.outcome.trim(),
            price: Number.isFinite(price) ? price : undefined,
          });
        }
      }
    }

    // If tokens array was empty, try parsing from outcomes/outcomePrices
    if (tokens.length === 0 && market.outcomes) {
      try {
        const outcomes: string[] = JSON.parse(market.outcomes);
        const prices: string[] = market.outcomePrices
          ? JSON.parse(market.outcomePrices)
          : [];

        // Note: Without token IDs we can't populate the tokens array fully
        // This is a fallback for markets that don't have the tokens array
        logger?.debug(
          `[MarketTokens] Market ${marketId} has outcomes but no token array. Outcomes: ${outcomes.join(", ")}`,
        );
      } catch {
        // Ignore parse errors
      }
    }

    // Determine if this is a binary market (YES/NO)
    const isBinaryMarket =
      tokens.length === 2 &&
      tokens.some(
        (t) => t.outcome.toUpperCase() === "YES" || t.outcome === "Yes",
      ) &&
      tokens.some(
        (t) => t.outcome.toUpperCase() === "NO" || t.outcome === "No",
      );

    const result: MarketTokensResult = {
      success: true,
      marketId,
      question: market.question,
      tokens,
      isBinaryMarket,
    };

    // Cache the result for all tokens in the market
    enforceCacheLimit();
    marketTokensCache.set(trimmedTokenId, result);
    for (const token of tokens) {
      marketTokensCache.set(token.tokenId, result);
    }

    logger?.debug(
      `[MarketTokens] Found ${tokens.length} tokens for market ${marketId}. Binary: ${isBinaryMarket}`,
    );

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger?.debug(`[MarketTokens] Error fetching market data: ${message}`);
    return { success: false, error: message };
  }
}

/**
 * Get the opposite token for hedging in a binary market.
 *
 * For a YES position, returns the NO token.
 * For a NO position, returns the YES token.
 *
 * @param currentTokenId - The token ID of the current position
 * @param currentOutcome - The outcome of the current position (e.g., "YES", "NO")
 * @param logger - Optional logger for debug output
 * @returns The opposite token, or null if not found or not a binary market
 */
export async function getOppositeToken(
  currentTokenId: string,
  currentOutcome: string,
  logger?: ConsoleLogger,
): Promise<MarketToken | null> {
  const result = await getMarketTokens(currentTokenId, logger);

  if (!result.success || !result.tokens || !result.isBinaryMarket) {
    logger?.debug(
      `[MarketTokens] Cannot find opposite token: ${result.error ?? "not a binary market"}`,
    );
    return null;
  }

  // Normalize outcome for comparison
  const normalizedCurrent = currentOutcome.toUpperCase().trim();

  // Find the opposite token
  for (const token of result.tokens) {
    const normalizedTokenOutcome = token.outcome.toUpperCase().trim();

    // Skip the current token
    if (
      token.tokenId === currentTokenId ||
      normalizedTokenOutcome === normalizedCurrent
    ) {
      continue;
    }

    // This is the opposite token
    logger?.debug(
      `[MarketTokens] Found opposite token: ${token.outcome} (${token.tokenId}) for current ${currentOutcome}`,
    );
    return token;
  }

  logger?.debug(
    `[MarketTokens] No opposite token found for ${currentOutcome} in market`,
  );
  return null;
}

/**
 * Enforce maximum cache size by removing oldest entries
 */
function enforceCacheLimit(): void {
  while (marketTokensCache.size >= MAX_CACHE_SIZE) {
    const firstKey = marketTokensCache.keys().next().value;
    if (firstKey) {
      marketTokensCache.delete(firstKey);
    } else {
      break;
    }
  }
}

/**
 * Clear the market tokens cache (for testing)
 */
export function clearMarketTokensCache(): void {
  marketTokensCache.clear();
}
