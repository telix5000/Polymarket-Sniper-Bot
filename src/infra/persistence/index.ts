/**
 * Persistence Module Index
 *
 * Consolidated data storage and caching infrastructure.
 *
 * This module provides:
 * - Type-safe store interfaces with consistent APIs
 * - Health checks for monitoring store health
 * - Metrics for observability
 * - LRU eviction and TTL support
 *
 * Stores available:
 * - MarketCache: Market token pair caching with multi-key indexing
 * - PositionStore: Position data with staleness tracking
 * - StoreRegistry: Central registry for health check aggregation
 *
 * Note: MarketDataStore remains in lib/market-data-store.ts for backward
 * compatibility, but implements the same health check interface.
 *
 * Usage:
 *   import { getMarketCache, getPositionStore, getStoreRegistry } from '../infra/persistence';
 *
 *   // Cache a market
 *   getMarketCache().cacheMarket(market);
 *
 *   // Sync positions
 *   getPositionStore().syncPositions(positions);
 *
 *   // Check health
 *   const registry = getStoreRegistry();
 *   registry.register(getMarketCache());
 *   registry.register(getPositionStore());
 *   console.log(registry.getHealthSummary());
 */

// Types
export type {
  HealthStatus,
  HealthCheckable,
  StoreMetricsBase,
  MetricsReportable,
  Store,
  StoreOptions,
  LogContext,
} from "./types";

export { createLogContext, formatLogContext } from "./types";

// Base store (for extension)
export { BaseStore, type BaseStoreMetrics } from "./base-store";

// Market cache
export {
  MarketCache,
  getMarketCache,
  initMarketCache,
  clearMarketCache,
  getMarketCacheStats,
  type MarketTokenPair,
  type MarketCacheMetrics,
} from "./market-cache";

// Position store
export {
  PositionStore,
  getPositionStore,
  initPositionStore,
  type StoredPosition,
  type PositionStoreMetrics,
} from "./position-store";

// Store registry
export {
  StoreRegistry,
  getStoreRegistry,
  initStoreRegistry,
  type AggregatedHealthStatus,
  type AggregatedMetrics,
} from "./store-registry";
