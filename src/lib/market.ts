/**
 * Market Utilities - Fetch market data including both YES/NO token IDs
 *
 * Polymarket binary markets have two outcome tokens:
 * - YES token: Pays $1 if event happens
 * - NO token: Pays $1 if event doesn't happen
 *
 * IMPORTANT: The Gamma API `outcomes` field determines which token is YES and which is NO.
 * The `clobTokenIds` and `outcomes` arrays are parallel - outcomes[i] describes tokenIds[i].
 *
 * The Gamma API returns:
 * - `clobTokenIds`: JSON string array of token IDs (order determined by outcomes array)
 * - `outcomes`: JSON string array like '["Yes", "No"]' or '["No", "Yes"]'
 *
 * This module provides utilities to:
 * - Fetch market data by condition ID or token ID
 * - Get the opposite token ID for hedging
 * - Cache market data to reduce API calls
 */

import axios from "axios";
import { POLYMARKET_API } from "./constants";

// ============================================================================
// Types
// ============================================================================

export interface MarketTokenPair {
  yesTokenId: string;
  noTokenId: string;
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
  clobTokenIds: string; // JSON string: '["tokenId0", "tokenId1"]' - order determined by outcomes
  outcomes?: string; // JSON string: '["Yes", "No"]' or '["No", "Yes"]' - determines YES/NO mapping
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

  // Cache by YES token
  tokenToMarketCache.set(market.yesTokenId, market);
  cacheTimestamps.set(market.yesTokenId, now);

  // Cache by NO token
  tokenToMarketCache.set(market.noTokenId, market);
  cacheTimestamps.set(market.noTokenId, now);

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
 * CRITICAL: The Gamma API `outcomes` field determines which token is YES and which is NO.
 * The `clobTokenIds` and `outcomes` arrays are parallel - outcomes[i] describes tokenIds[i].
 *
 * For example:
 *   clobTokenIds: '["token-A", "token-B"]'
 *   outcomes: '["No", "Yes"]'
 * Means: token-A is NO, token-B is YES
 *
 * This function:
 * 1. Parses both arrays
 * 2. Finds which index contains "Yes" (case-insensitive)
 * 3. Maps token IDs accordingly
 * 4. Handles edge cases (missing outcomes, non-YES/NO markets)
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

    // Parse outcomes to determine which token is YES and which is NO
    // The outcomes array is parallel to clobTokenIds: outcomes[i] describes tokenIds[i]
    let yesTokenId: string;
    let noTokenId: string;

    if (market.outcomes) {
      const outcomes = parseOutcomes(market.outcomes, market.id);

      if (!outcomes) {
        // Failed to parse outcomes - cannot determine YES/NO mapping
        return null;
      }

      // Validate that tokenIds and outcomes arrays have the same length
      // Since they're parallel arrays, a length mismatch would cause incorrect mappings
      if (tokenIds.length !== outcomes.length) {
        console.warn(
          `[Market] Array length mismatch for market ${market.id}: tokenIds.length=${tokenIds.length}, outcomes.length=${outcomes.length}`,
        );
        return null;
      }

      // For binary YES/NO markets, require exactly 2 outcomes
      if (outcomes.length !== 2) {
        console.warn(
          `[Market] Non-binary market ${market.id} has ${outcomes.length} outcomes - only binary YES/NO markets are supported for hedging`,
        );
        return null;
      }

      // Find YES and NO indices explicitly (case-insensitive)
      const yesIndex = outcomes.findIndex((o) => o.toLowerCase() === "yes");
      const noIndex = outcomes.findIndex((o) => o.toLowerCase() === "no");

      if (yesIndex === -1 || noIndex === -1) {
        // Not a YES/NO market - this might be "Trump"/"Biden" or similar
        console.warn(
          `[Market] Non-YES/NO market ${market.id}: outcomes=[${outcomes.join(", ")}]. Cannot map to YES/NO tokens.`,
        );
        return null;
      }

      // Map tokens based on explicitly found outcome positions
      yesTokenId = tokenIds[yesIndex];
      noTokenId = tokenIds[noIndex];
    } else {
      // No outcomes field - fallback to legacy assumption (index 0 = YES, index 1 = NO)
      // This maintains backward compatibility but logs a warning
      // IMPORTANT: Only allow legacy fallback for binary markets (exactly 2 tokens)
      if (tokenIds.length !== 2) {
        console.warn(
          `[Market] Missing outcomes field for non-binary market ${market.id} with ${tokenIds.length} tokens - cannot determine YES/NO mapping`,
        );
        return null;
      }
      console.warn(
        `[Market] Missing outcomes field for market ${market.id} - using legacy index assumption`,
      );
      yesTokenId = token0;
      noTokenId = token1;
    }

    const pair: MarketTokenPair = {
      yesTokenId,
      noTokenId,
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
 * If you hold the YES token and want to hedge, you need the NO token (and vice versa)
 *
 * @param tokenId - The token ID you currently hold
 * @returns The opposite token ID, or null if not found
 */
export async function getOppositeTokenId(
  tokenId: string,
): Promise<string | null> {
  const market = await fetchMarketByTokenId(tokenId);
  if (!market) return null;

  // Determine if the input token is YES or NO, return the opposite
  if (market.yesTokenId === tokenId) {
    return market.noTokenId;
  } else if (market.noTokenId === tokenId) {
    return market.yesTokenId;
  }

  // Shouldn't happen, but defensive
  console.warn(
    `[Market] Token ${tokenId.slice(0, 16)}... not found in market ${market.marketId}`,
  );
  return null;
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
 * Determine if a token is the YES or NO outcome
 *
 * @param tokenId - The token ID to check
 * @returns "YES" | "NO" | null
 */
export async function getTokenOutcome(
  tokenId: string,
): Promise<"YES" | "NO" | null> {
  const market = await fetchMarketByTokenId(tokenId);
  if (!market) return null;

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
