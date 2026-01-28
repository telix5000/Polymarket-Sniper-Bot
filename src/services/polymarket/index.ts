/**
 * Polymarket Services Index
 *
 * Central export point for all Polymarket API services.
 * Provides a clean API for interacting with Polymarket's REST and WebSocket APIs.
 *
 * Usage:
 *   // Authentication and CLOB client
 *   import { createClobClient, isLiveTradingEnabled } from '../services/polymarket';
 *
 *   // REST API with rate limiting
 *   import { clobGet, dataApiGet, withRateLimitAndRetry, rateLimiters } from '../services/polymarket';
 *
 *   // WebSocket clients
 *   import { WebSocketMarketClient, getWebSocketUserClient } from '../services/polymarket';
 *
 *   // Market data facade (combines WS + REST fallback)
 *   import { getMarketDataFacade, initMarketDataFacade } from '../services/polymarket';
 */

// REST API client and functions
export * from "./rest-client";

// WebSocket clients and data layer
export * from "./ws-client";

// Rate limiting utilities (also exported via rest-client)
export * from "./rate-limit";
