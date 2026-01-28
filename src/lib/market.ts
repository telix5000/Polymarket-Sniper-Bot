/**
 * Market Utilities - Fetch market data including both YES/NO token IDs
 * 
 * Polymarket markets have two outcome tokens:
 * - YES token (outcome index 0): Pays $1 if event happens
 * - NO token (outcome index 1): Pays $1 if event doesn't happen
 * 
 * The Gamma API returns `clobTokenIds` as a JSON string array: '["yesTokenId", "noTokenId"]'
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
  clobTokenIds: string; // JSON string: '["yesTokenId", "noTokenId"]'
  outcomes: string; // JSON string: '["Yes", "No"]' or similar
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
      console.warn(`[Market] No market found for condition ${conditionId.slice(0, 16)}...`);
      return null;
    }

    const market = data[0];
    return parseMarketResponse(market);
  } catch (err) {
    console.error(`[Market] Failed to fetch by condition: ${err instanceof Error ? err.message : err}`);
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
      console.warn(`[Market] No market found for token ${tokenId.slice(0, 16)}...`);
      return null;
    }

    const market = data[0];
    return parseMarketResponse(market);
  } catch (err) {
    console.error(`[Market] Failed to fetch by token: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Parse Gamma API response into MarketTokenPair
 */
function parseMarketResponse(market: GammaMarketResponse): MarketTokenPair | null {
  try {
    // Parse clobTokenIds JSON string
    const tokenIds = JSON.parse(market.clobTokenIds);
    
    if (!Array.isArray(tokenIds) || tokenIds.length < 2) {
      console.warn(`[Market] Invalid clobTokenIds format for market ${market.id}`);
      return null;
    }

    // Validate that both token IDs are valid non-empty strings
    const yesTokenId = tokenIds[0];
    const noTokenId = tokenIds[1];
    
    if (!yesTokenId || typeof yesTokenId !== "string" || yesTokenId.trim() === "") {
      console.warn(`[Market] Invalid YES token ID for market ${market.id}`);
      return null;
    }
    
    if (!noTokenId || typeof noTokenId !== "string" || noTokenId.trim() === "") {
      console.warn(`[Market] Invalid NO token ID for market ${market.id}`);
      return null;
    }

    const pair: MarketTokenPair = {
      yesTokenId,
      noTokenId,
      conditionId: market.conditionId,
      marketId: market.id,
      question: market.question,
      endDate: market.endDate,
      active: market.active && !market.closed && market.acceptingOrders !== false,
    };

    // Cache for future lookups
    cacheMarket(pair);

    return pair;
  } catch (err) {
    console.error(`[Market] Failed to parse market response: ${err instanceof Error ? err.message : err}`);
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
export async function getOppositeTokenId(tokenId: string): Promise<string | null> {
  const market = await fetchMarketByTokenId(tokenId);
  if (!market) return null;

  // Determine if the input token is YES or NO, return the opposite
  if (market.yesTokenId === tokenId) {
    return market.noTokenId;
  } else if (market.noTokenId === tokenId) {
    return market.yesTokenId;
  }

  // Shouldn't happen, but defensive
  console.warn(`[Market] Token ${tokenId.slice(0, 16)}... not found in market ${market.marketId}`);
  return null;
}

/**
 * Get market token pair from cache or fetch
 * Returns both token IDs for a market given any one of them
 */
export async function getMarketTokenPair(tokenId: string): Promise<MarketTokenPair | null> {
  return fetchMarketByTokenId(tokenId);
}

/**
 * Determine if a token is the YES or NO outcome
 * 
 * @param tokenId - The token ID to check
 * @returns "YES" | "NO" | null
 */
export async function getTokenOutcome(tokenId: string): Promise<"YES" | "NO" | null> {
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
  const uncached = tokenIds.filter(id => !isCacheValid(id));
  
  if (uncached.length === 0) return;

  // Fetch in batches to avoid rate limiting
  const BATCH_SIZE = 5;
  for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
    const batch = uncached.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(id => fetchMarketByTokenId(id)));
    
    // Small delay between batches
    if (i + BATCH_SIZE < uncached.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
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

// ============================================================================
// CRITICAL RESOLVER: conditionId + outcomeIndex → tokenId
// ============================================================================

/**
 * Resolve tokenId from conditionId and outcomeIndex
 * 
 * This is the CRITICAL mapping required for trade execution.
 * Whale trades from Data API contain:
 *   - conditionId (market identifier)
 *   - outcomeIndex (0 = YES, 1 = NO)
 * 
 * But CLOB execution REQUIRES:
 *   - tokenId (specific outcome token)
 * 
 * This function performs the deterministic resolution.
 * 
 * @param conditionId - The market's condition ID
 * @param outcomeIndex - 0 for YES, 1 for NO
 * @returns tokenId if found, null if resolution fails (DO NOT EXECUTE if null)
 */
export async function resolveTokenId(
  conditionId: string,
  outcomeIndex: number,
): Promise<string | null> {
  // Validate outcomeIndex is a number
  if (typeof outcomeIndex !== "number" || isNaN(outcomeIndex)) {
    console.warn(`[Market] Invalid outcomeIndex type: ${typeof outcomeIndex} (${outcomeIndex})`);
    return null;
  }
  
  // Normalize to integer and validate range (must be exactly 0 or 1)
  const normalizedIndex = Math.floor(outcomeIndex);
  if (normalizedIndex !== 0 && normalizedIndex !== 1) {
    console.warn(`[Market] Invalid outcomeIndex: ${outcomeIndex} (must be 0 or 1, not ${normalizedIndex})`);
    return null;
  }

  // Validate conditionId
  if (!conditionId || typeof conditionId !== "string" || conditionId.trim() === "") {
    console.warn(`[Market] Invalid conditionId: ${conditionId}`);
    return null;
  }

  // Fetch market data by condition ID
  const market = await fetchMarketByConditionId(conditionId);
  if (!market) {
    console.warn(`[Market] Could not resolve tokenId for condition ${conditionId.slice(0, 16)}...`);
    return null;
  }

  // Map outcomeIndex to tokenId
  // outcomeIndex 0 = YES token, outcomeIndex 1 = NO token
  const tokenId = normalizedIndex === 0 ? market.yesTokenId : market.noTokenId;
  
  if (!tokenId || tokenId.trim() === "") {
    console.warn(`[Market] Invalid tokenId for condition ${conditionId.slice(0, 16)}... outcome ${normalizedIndex}`);
    return null;
  }

  return tokenId;
}

/**
 * Batch resolve multiple tokenIds from conditionId + outcomeIndex pairs
 * Useful when processing multiple whale trades
 * 
 * @param pairs - Array of { conditionId, outcomeIndex } pairs
 * @returns Map from "conditionId:outcomeIndex" to tokenId (null entries for failed resolutions)
 */
export async function batchResolveTokenIds(
  pairs: Array<{ conditionId: string; outcomeIndex: number }>,
): Promise<Map<string, string | null>> {
  const results = new Map<string, string | null>();
  
  // Group by conditionId to minimize API calls (since one conditionId gives both tokens)
  const conditionIds = new Set(pairs.map(p => p.conditionId));
  
  // Prefetch all unique condition IDs
  const prefetchPromises = Array.from(conditionIds).map(async (conditionId) => {
    return { conditionId, market: await fetchMarketByConditionId(conditionId) };
  });
  
  const prefetchResults = await Promise.all(prefetchPromises);
  const marketByCondition = new Map<string, MarketTokenPair | null>();
  for (const { conditionId, market } of prefetchResults) {
    marketByCondition.set(conditionId, market);
  }
  
  // Resolve each pair
  for (const { conditionId, outcomeIndex } of pairs) {
    const key = `${conditionId}:${outcomeIndex}`;
    
    // Validate and normalize outcomeIndex
    if (typeof outcomeIndex !== "number" || isNaN(outcomeIndex)) {
      results.set(key, null);
      continue;
    }
    
    const normalizedIndex = Math.floor(outcomeIndex);
    if (normalizedIndex !== 0 && normalizedIndex !== 1) {
      results.set(key, null);
      continue;
    }
    
    const market = marketByCondition.get(conditionId);
    if (!market) {
      results.set(key, null);
      continue;
    }
    
    const tokenId = normalizedIndex === 0 ? market.yesTokenId : market.noTokenId;
    results.set(key, tokenId && tokenId.trim() !== "" ? tokenId : null);
  }
  
  return results;
}

/**
 * Get outcomeIndex from tokenId
 * Reverse of resolveTokenId - useful for converting tokenId back to outcomeIndex
 * 
 * @param tokenId - The token ID
 * @returns 0 for YES, 1 for NO, null if not found
 */
export async function getOutcomeIndex(tokenId: string): Promise<number | null> {
  const market = await fetchMarketByTokenId(tokenId);
  if (!market) return null;

  if (market.yesTokenId === tokenId) return 0;
  if (market.noTokenId === tokenId) return 1;
  return null;
}
