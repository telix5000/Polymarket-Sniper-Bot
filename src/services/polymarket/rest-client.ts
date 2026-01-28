/**
 * Polymarket REST Client
 *
 * Thin wrapper around the Polymarket CLOB API client.
 * Re-exports authentication and client creation from lib for backward compatibility.
 *
 * Future improvements:
 * - Centralized retry/rate limit handling
 * - Request logging and metrics
 * - Connection pooling
 */

// Re-export from lib for backward compatibility
export {
  createClobClient,
  isLiveTradingEnabled,
  getAuthDiagnostics,
  type AuthResult,
  type AuthDiagnostics,
} from "../../lib/auth";

// Re-export order functions
export { postOrder, type PostOrderInput } from "../../lib/order";

// Re-export position functions
export { getPositions, invalidatePositions } from "../../lib/positions";

// Re-export balance functions
export { getUsdcBalance, getPolBalance } from "../../lib/balance";

// Re-export market functions
export {
  fetchMarketByConditionId,
  fetchMarketByTokenId,
  getOppositeTokenId,
  getMarketTokenPair,
  getTokenOutcome,
  prefetchMarkets,
  clearMarketCache,
  getMarketCacheStats,
  type MarketTokenPair,
} from "../../lib/market";

// API endpoints from constants
export { POLYMARKET_API, POLYGON } from "../../lib/constants";
