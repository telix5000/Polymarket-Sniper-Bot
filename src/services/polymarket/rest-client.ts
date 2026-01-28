/**
 * Polymarket REST Client
 *
 * Thin wrapper around the Polymarket CLOB API client.
 * Re-exports authentication and client creation from lib for backward compatibility.
 *
 * Features:
 * - Centralized retry/rate limit handling via rate-limit module
 * - Backward compatible re-exports from lib modules
 * - Request helpers with automatic retry and rate limiting
 *
 * Usage:
 *   // Direct re-exports (backward compatible)
 *   import { createClobClient, postOrder } from '../services/polymarket';
 *
 *   // New rate-limited helpers
 *   import { withRateLimitAndRetry, rateLimiters } from '../services/polymarket';
 */

import axios from "axios";
import { POLYMARKET_API } from "../../lib/constants";
import {
  withRetry,
  withRateLimitAndRetry,
  rateLimiters,
  type RetryConfig,
  type RetryResult,
} from "./rate-limit";

// ============================================================================
// Re-exports for backward compatibility
// ============================================================================

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

// Re-export rate limit utilities
export {
  withRetry,
  withRateLimitAndRetry,
  rateLimiters,
  isRetryableError,
  isRateLimitError,
  isCloudflareBlockError,
  RateLimiter,
  calculateBackoff,
  sleep,
  type RetryConfig,
  type RateLimitConfig,
  type RetryResult,
  DEFAULT_RETRY_CONFIG,
  DEFAULT_RATE_LIMIT_CONFIG,
} from "./rate-limit";

// ============================================================================
// REST API Request Helpers
// ============================================================================

/**
 * Request options for REST API calls
 */
export interface RestRequestOptions {
  /** Timeout in milliseconds */
  timeout?: number;
  /** Retry configuration */
  retryConfig?: Partial<RetryConfig>;
  /** Whether to use rate limiting */
  useRateLimit?: boolean;
  /** Custom headers */
  headers?: Record<string, string>;
}

const DEFAULT_TIMEOUT = 10000;

/**
 * Make a GET request to the CLOB API with retry and rate limiting
 *
 * @param path - API path (without base URL)
 * @param options - Request options
 */
export async function clobGet<T>(
  path: string,
  options: RestRequestOptions = {},
): Promise<RetryResult<T>> {
  const {
    timeout = DEFAULT_TIMEOUT,
    retryConfig,
    useRateLimit = true,
  } = options;

  const url = `${POLYMARKET_API.CLOB}${path.startsWith("/") ? path : `/${path}`}`;

  const requestFn = async () => {
    const response = await axios.get<T>(url, {
      timeout,
      headers: options.headers,
    });
    return response.data;
  };

  if (useRateLimit) {
    return withRateLimitAndRetry(requestFn, rateLimiters.clob, retryConfig);
  }

  return withRetry(requestFn, retryConfig);
}

/**
 * Make a GET request to the Data API with retry and rate limiting
 *
 * @param path - API path (without base URL)
 * @param options - Request options
 */
export async function dataApiGet<T>(
  path: string,
  options: RestRequestOptions = {},
): Promise<RetryResult<T>> {
  const {
    timeout = DEFAULT_TIMEOUT,
    retryConfig,
    useRateLimit = true,
  } = options;

  const url = `${POLYMARKET_API.DATA}${path.startsWith("/") ? path : `/${path}`}`;

  const requestFn = async () => {
    const response = await axios.get<T>(url, {
      timeout,
      headers: options.headers,
    });
    return response.data;
  };

  if (useRateLimit) {
    return withRateLimitAndRetry(requestFn, rateLimiters.data, retryConfig);
  }

  return withRetry(requestFn, retryConfig);
}

/**
 * Make a GET request to the Gamma API with retry and rate limiting
 *
 * @param path - API path (without base URL)
 * @param options - Request options
 */
export async function gammaApiGet<T>(
  path: string,
  options: RestRequestOptions = {},
): Promise<RetryResult<T>> {
  const {
    timeout = DEFAULT_TIMEOUT,
    retryConfig,
    useRateLimit = true,
  } = options;

  const url = `${POLYMARKET_API.GAMMA}${path.startsWith("/") ? path : `/${path}`}`;

  const requestFn = async () => {
    const response = await axios.get<T>(url, {
      timeout,
      headers: options.headers,
    });
    return response.data;
  };

  if (useRateLimit) {
    return withRateLimitAndRetry(requestFn, rateLimiters.gamma, retryConfig);
  }

  return withRetry(requestFn, retryConfig);
}

// ============================================================================
// REST Client Metrics
// ============================================================================

/** Metrics for REST API calls */
export interface RestClientMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  retryCount: number;
  rateLimitHits: number;
  averageLatencyMs: number;
}

/** Global metrics tracker */
const metrics: RestClientMetrics = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  retryCount: 0,
  rateLimitHits: 0,
  averageLatencyMs: 0,
};

let totalLatencyMs = 0;

/**
 * Record a request for metrics
 */
export function recordRequest(
  success: boolean,
  latencyMs: number,
  retries: number = 0,
  rateLimited: boolean = false,
): void {
  metrics.totalRequests++;
  if (success) {
    metrics.successfulRequests++;
  } else {
    metrics.failedRequests++;
  }
  metrics.retryCount += retries;
  if (rateLimited) {
    metrics.rateLimitHits++;
  }
  totalLatencyMs += latencyMs;
  metrics.averageLatencyMs = totalLatencyMs / metrics.totalRequests;
}

/**
 * Get current REST client metrics
 */
export function getRestClientMetrics(): Readonly<RestClientMetrics> {
  return { ...metrics };
}

/**
 * Reset REST client metrics
 */
export function resetRestClientMetrics(): void {
  metrics.totalRequests = 0;
  metrics.successfulRequests = 0;
  metrics.failedRequests = 0;
  metrics.retryCount = 0;
  metrics.rateLimitHits = 0;
  metrics.averageLatencyMs = 0;
  totalLatencyMs = 0;
}
