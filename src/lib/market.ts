/**
 * Market Utilities - Fetch market data including both outcome token IDs
 *
 * Polymarket binary markets have two outcome tokens:
 * - Token at outcomeIndex 1: First outcome (could be YES, or a team name, etc.)
 * - Token at outcomeIndex 2: Second outcome (could be NO, or opponent team, etc.)
 *
 * IMPORTANT: This module supports ANY 2-outcome market, not just YES/NO markets.
 * The `clobTokenIds` and `outcomes` arrays are parallel - outcomes[i] describes tokenIds[i].
 *
 * The Gamma API returns:
 * - `clobTokenIds`: JSON string array of token IDs
 * - `outcomes`: JSON string array like '["Yes", "No"]', '["Lakers", "Celtics"]', etc.
 *
 * This module provides utilities to:
 * - Fetch market data by condition ID or token ID
 * - Get the opposite token ID for hedging (works with any 2-outcome market)
 * - Get outcomeIndex (1 or 2) and outcomeLabel for any token
 * - Cache market data to reduce API calls
 */

import axios from "axios";
import { POLYMARKET_API } from "./constants";

// ============================================================================
// Types
// ============================================================================

/**
 * Token info for a single outcome
 */
export interface OutcomeToken {
  tokenId: string;
  outcomeIndex: 1 | 2; // 1-based index (1 = first outcome, 2 = second outcome)
  outcomeLabel: string; // The label from the outcomes array (e.g., "Yes", "Lakers", "Over")
}

/**
 * Market data with both outcome tokens
 * Supports ANY 2-outcome market, not just YES/NO markets.
 */
export interface MarketTokenPair {
  /** @deprecated Use tokens.find(t => t.outcomeIndex === 1)?.tokenId - Token at outcomeIndex 1 (for backward compat, often YES) */
  yesTokenId: string;
  /** @deprecated Use tokens.find(t => t.outcomeIndex === 2)?.tokenId - Token at outcomeIndex 2 (for backward compat, often NO) */
  noTokenId: string;
  /** All tokens with their outcomeIndex and label */
  tokens: OutcomeToken[];
  /** Outcome labels in order (index 0 = outcomeIndex 1, index 1 = outcomeIndex 2) */
  outcomeLabels: string[];
  conditionId: string;
  marketId: string;
  question?: string;
  endDate?: string;
  active?: boolean;
}

interface GammaMarketResponse {
  id: string;
  question: string;
  conditionId: string;
  clobTokenIds: string; // JSON string: '["tokenId0", "tokenId1"]'
  outcomes?: string; // JSON string: '["Yes", "No"]', '["Lakers", "Celtics"]', etc.
  outcomePrices: string; // JSON string: '["0.65", "0.35"]'
  endDate?: string;
  active?: boolean;
  closed?: boolean;
  acceptingOrders?: boolean;
}

// ============================================================================
// Cache
// ============================================================================

// Cache market data by token ID for quick lookups
// Key: tokenId, Value: MarketTokenPair
const tokenToMarketCache = new Map<string, MarketTokenPair>();

// Cache by condition ID as well
const conditionToMarketCache = new Map<string, MarketTokenPair>();

// Cache TTL: 1 hour (market token IDs don't change)
const CACHE_TTL_MS = 60 * 60 * 1000;
const cacheTimestamps = new Map<string, number>();

/**
 * Check if cache entry is still valid
 * Verifies both timestamp exists, is within TTL, and the cache entry exists
 */
function isCacheValid(key: string): boolean {
  const timestamp = cacheTimestamps.get(key);
  if (!timestamp) return false;
  if (Date.now() - timestamp >= CACHE_TTL_MS) return false;
  // Also verify the cache entry actually exists
  return tokenToMarketCache.has(key) || conditionToMarketCache.has(key);
}

/**
 * Store in cache with timestamp
 */
function cacheMarket(market: MarketTokenPair): void {
  const now = Date.now();

  // Cache by all token IDs from tokens array
  for (const token of market.tokens) {
    tokenToMarketCache.set(token.tokenId, market);
    cacheTimestamps.set(token.tokenId, now);
  }

  // Cache by condition ID
  conditionToMarketCache.set(market.conditionId, market);
  cacheTimestamps.set(market.conditionId, now);
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Fetch market data from Gamma API by condition ID
 */
export async function fetchMarketByConditionId(
  conditionId: string,
): Promise<MarketTokenPair | null> {
  // Check cache first
  if (isCacheValid(conditionId)) {
    const cached = conditionToMarketCache.get(conditionId);
    if (cached) return cached;
  }

  try {
    const url = `${POLYMARKET_API.GAMMA}/markets?condition_id=${conditionId}`;
    const { data } = await axios.get<GammaMarketResponse[]>(url, {
      timeout: 10000,
    });

    if (!data || data.length === 0) {
      console.warn(
        `[Market] No market found for condition ${conditionId.slice(0, 16)}...`,
      );
      return null;
    }

    const market = data[0];
    return parseMarketResponse(market);
  } catch (err) {
    console.error(
      `[Market] Failed to fetch by condition: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

/**
 * Fetch market data from Gamma API by token ID
 * This is useful when you only know one of the token IDs
 */
export async function fetchMarketByTokenId(
  tokenId: string,
): Promise<MarketTokenPair | null> {
  // Check cache first
  if (isCacheValid(tokenId)) {
    const cached = tokenToMarketCache.get(tokenId);
    if (cached) return cached;
  }

  try {
    // Gamma API allows searching by clob_token_ids
    const url = `${POLYMARKET_API.GAMMA}/markets?clob_token_ids=${tokenId}`;
    const { data } = await axios.get<GammaMarketResponse[]>(url, {
      timeout: 10000,
    });

    if (!data || data.length === 0) {
      console.warn(
        `[Market] No market found for token ${tokenId.slice(0, 16)}...`,
      );
      return null;
    }

    const market = data[0];
    return parseMarketResponse(market);
  } catch (err) {
    console.error(
      `[Market] Failed to fetch by token: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

/**
 * Parse Gamma API response into MarketTokenPair
 *
 * This function supports ANY 2-outcome market, not just YES/NO markets.
 * The `clobTokenIds` and `outcomes` arrays are parallel - outcomes[i] describes tokenIds[i].
 *
 * For example:
 *   clobTokenIds: '["token-A", "token-B"]'
 *   outcomes: '["Lakers", "Celtics"]'
 * Means: token-A = Lakers (outcomeIndex 1), token-B = Celtics (outcomeIndex 2)
 *
 * This function:
 * 1. Parses both arrays
 * 2. Creates OutcomeToken entries with correct outcomeIndex and label
 * 3. Maintains backward-compatible yesTokenId/noTokenId fields
 * 4. Handles edge cases (missing outcomes, >2 outcomes)
 */
function parseMarketResponse(
  market: GammaMarketResponse,
): MarketTokenPair | null {
  try {
    // Parse clobTokenIds JSON string
    const tokenIds = JSON.parse(market.clobTokenIds);

    if (!Array.isArray(tokenIds) || tokenIds.length < 2) {
      console.warn(
        `[Market] Invalid clobTokenIds format for market ${market.id}`,
      );
      return null;
    }

    // Validate that both token IDs are valid non-empty strings
    const token0 = tokenIds[0];
    const token1 = tokenIds[1];

    if (!token0 || typeof token0 !== "string" || token0.trim() === "") {
      console.warn(
        `[Market] Invalid token ID at index 0 for market ${market.id}`,
      );
      return null;
    }

    if (!token1 || typeof token1 !== "string" || token1.trim() === "") {
      console.warn(
        `[Market] Invalid token ID at index 1 for market ${market.id}`,
      );
      return null;
    }

    // Parse outcomes - ANY 2-outcome market is valid, not just YES/NO
    let outcomeLabels: string[];

    if (market.outcomes) {
      const outcomes = parseOutcomes(market.outcomes, market.id);

      if (!outcomes) {
        // Failed to parse outcomes - cannot determine token mapping
        return null;
      }

      // Validate that tokenIds and outcomes arrays have the same length
      if (tokenIds.length !== outcomes.length) {
        console.warn(
          `[Market] Array length mismatch for market ${market.id}: tokenIds.length=${tokenIds.length}, outcomes.length=${outcomes.length}`,
        );
        return null;
      }

      // Require exactly 2 outcomes for binary markets
      if (outcomes.length !== 2) {
        console.warn(
          `[Market] Non-binary market ${market.id} has ${outcomes.length} outcomes - only 2-outcome markets are supported`,
        );
        return null;
      }

      outcomeLabels = outcomes;
    } else {
      // No outcomes field - fallback to generic labels
      if (tokenIds.length !== 2) {
        console.warn(
          `[Market] Missing outcomes field for non-binary market ${market.id} with ${tokenIds.length} tokens`,
        );
        return null;
      }
      console.warn(
        `[Market] Missing outcomes field for market ${market.id} - using generic labels`,
      );
      outcomeLabels = ["Outcome1", "Outcome2"];
    }

    // Build tokens array with outcomeIndex (1-based)
    const tokens: OutcomeToken[] = [
      { tokenId: token0, outcomeIndex: 1, outcomeLabel: outcomeLabels[0] },
      { tokenId: token1, outcomeIndex: 2, outcomeLabel: outcomeLabels[1] },
    ];

    // For backward compatibility: try to map to yesTokenId/noTokenId if this is a YES/NO market
    // Otherwise, use index 0 as "yes" and index 1 as "no" for legacy code
    const yesIndex = outcomeLabels.findIndex((o) => o.toLowerCase() === "yes");
    const noIndex = outcomeLabels.findIndex((o) => o.toLowerCase() === "no");

    let yesTokenId: string;
    let noTokenId: string;

    if (yesIndex !== -1 && noIndex !== -1) {
      // Traditional YES/NO market
      yesTokenId = tokenIds[yesIndex];
      noTokenId = tokenIds[noIndex];
    } else {
      // Non-YES/NO market (e.g., team names, player names)
      // Use index 0 as "yes" equivalent, index 1 as "no" equivalent for backward compat
      yesTokenId = token0;
      noTokenId = token1;
    }

    const pair: MarketTokenPair = {
      yesTokenId,
      noTokenId,
      tokens,
      outcomeLabels,
      conditionId: market.conditionId,
      marketId: market.id,
      question: market.question,
      endDate: market.endDate,
      active:
        market.active && !market.closed && market.acceptingOrders !== false,
    };

    // Cache for future lookups
    cacheMarket(pair);

    return pair;
  } catch (err) {
    console.error(
      `[Market] Failed to parse market response: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

/**
 * Parse the outcomes JSON string from Gamma API
 * @returns Array of outcome strings, or null if parsing fails
 */
function parseOutcomes(
  outcomesJson: string,
  marketId: string,
): string[] | null {
  try {
    const outcomes = JSON.parse(outcomesJson);

    if (!Array.isArray(outcomes)) {
      console.warn(`[Market] outcomes is not an array for market ${marketId}`);
      return null;
    }

    if (outcomes.length < 2) {
      console.warn(
        `[Market] outcomes has fewer than 2 elements for market ${marketId}`,
      );
      return null;
    }

    // Validate all outcomes are strings
    for (let i = 0; i < outcomes.length; i++) {
      if (typeof outcomes[i] !== "string") {
        console.warn(
          `[Market] outcome[${i}] is not a string for market ${marketId}`,
        );
        return null;
      }
    }

    return outcomes;
  } catch (err) {
    console.warn(
      `[Market] Failed to parse outcomes for market ${marketId}: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get the opposite token ID for hedging
 *
 * Works with ANY 2-outcome market - finds the other token in the pair.
 *
 * @param tokenId - The token ID you currently hold
 * @returns The opposite token ID, or null if not found
 */
export async function getOppositeTokenId(
  tokenId: string,
): Promise<string | null> {
  const market = await fetchMarketByTokenId(tokenId);
  if (!market) return null;

  // Find the token in the tokens array and return the other one
  // Use optional chaining in case market.tokens is undefined (cached data from before this PR)
  const tokenInfo = market.tokens?.find((t) => t.tokenId === tokenId);
  if (!tokenInfo) {
    // Fallback to legacy yesTokenId/noTokenId for backward compat
    if (market.yesTokenId === tokenId) {
      return market.noTokenId;
    } else if (market.noTokenId === tokenId) {
      return market.yesTokenId;
    }
    console.warn(
      `[Market] Token ${tokenId.slice(0, 16)}... not found in market ${market.marketId}`,
    );
    return null;
  }

  // Return the other token (opposite outcomeIndex)
  const oppositeToken = market.tokens?.find((t) => t.tokenId !== tokenId);
  return oppositeToken?.tokenId ?? null;
}

/**
 * Get market token pair from cache or fetch
 * Returns both token IDs for a market given any one of them
 */
export async function getMarketTokenPair(
  tokenId: string,
): Promise<MarketTokenPair | null> {
  return fetchMarketByTokenId(tokenId);
}

/**
 * Get token info including outcomeIndex and outcomeLabel
 *
 * @param tokenId - The token ID to check
 * @returns OutcomeToken info or null if not found
 */
export async function getTokenInfo(
  tokenId: string,
): Promise<OutcomeToken | null> {
  const market = await fetchMarketByTokenId(tokenId);
  if (!market) return null;

  // Use optional chaining in case market.tokens is undefined (cached data from before this PR)
  const tokenInfo = market.tokens?.find((t) => t.tokenId === tokenId);
  return tokenInfo ?? null;
}

/**
 * @deprecated Use getTokenInfo() instead for full outcomeIndex/label support
 * Determine if a token is the YES or NO outcome
 *
 * @param tokenId - The token ID to check
 * @returns "YES" | "NO" | null (returns outcomeLabel for non-YES/NO markets)
 */
export async function getTokenOutcome(tokenId: string): Promise<string | null> {
  const market = await fetchMarketByTokenId(tokenId);
  if (!market) return null;

  // Find token info with outcomeLabel
  const tokenInfo = market.tokens.find((t) => t.tokenId === tokenId);
  if (tokenInfo) {
    return tokenInfo.outcomeLabel;
  }

  // Fallback to legacy
  if (market.yesTokenId === tokenId) {
    return "YES";
  } else if (market.noTokenId === tokenId) {
    return "NO";
  }

  return null;
}

/**
 * Prefetch and cache market data for multiple token IDs
 * Useful when processing a batch of positions
 */
export async function prefetchMarkets(tokenIds: string[]): Promise<void> {
  // Filter out tokens that are already cached
  const uncached = tokenIds.filter((id) => !isCacheValid(id));

  if (uncached.length === 0) return;

  // Fetch in batches to avoid rate limiting
  const BATCH_SIZE = 5;
  for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
    const batch = uncached.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map((id) => fetchMarketByTokenId(id)));

    // Small delay between batches
    if (i + BATCH_SIZE < uncached.length) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/**
 * Clear market cache (for testing)
 */
export function clearMarketCache(): void {
  tokenToMarketCache.clear();
  conditionToMarketCache.clear();
  cacheTimestamps.clear();
}

/**
 * Get cache stats (for debugging)
 */
export function getMarketCacheStats(): { size: number; validEntries: number } {
  let validEntries = 0;
  for (const key of tokenToMarketCache.keys()) {
    if (isCacheValid(key)) validEntries++;
  }
  return {
    size: tokenToMarketCache.size,
    validEntries,
  };
}
