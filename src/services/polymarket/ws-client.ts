/**
 * Polymarket WebSocket Client
 *
 * Thin wrapper around the WebSocket clients for market and user data.
 * Re-exports from lib for backward compatibility with centralized reconnect handling.
 *
 * Features:
 * - Market WebSocket client for L2 orderbook data
 * - User WebSocket client for authenticated order/trade events
 * - Automatic reconnection with exponential backoff + jitter
 * - Connection state management with health monitoring
 * - Centralized configuration via constants
 *
 * Usage:
 *   // Market data (public)
 *   import { getWebSocketMarketClient } from '../services/polymarket';
 *   const wsMarket = getWebSocketMarketClient();
 *   wsMarket.connect();
 *   wsMarket.subscribe(['token-id-1', 'token-id-2']);
 *
 *   // User data (authenticated)
 *   import { getWebSocketUserClient } from '../services/polymarket';
 *   const wsUser = getWebSocketUserClient();
 *   await wsUser.connect(clobClient);
 */

// Import for internal use
import { getWebSocketMarketClient as _getMarketClient } from "../../lib/ws-market-client";
import { getWebSocketUserClient as _getUserClient } from "../../lib/ws-user-client";

// Re-export WebSocket market client
export {
  WebSocketMarketClient,
  getWebSocketMarketClient,
  initWebSocketMarketClient,
  type WsConnectionState,
  type WsClientOptions,
} from "../../lib/ws-market-client";

// Re-export WebSocket user client
export {
  WebSocketUserClient,
  getWebSocketUserClient,
  initWebSocketUserClient,
  type WsUserConnectionState,
  type WsUserClientOptions,
  // Order state types
  type OrderStatus,
  type UserEventType,
  type OrderEvent,
  type TradeEvent,
  type BalanceEvent,
  type UserEvent,
  // Order state store
  OrderStateStore,
  type TrackedOrder,
  type TrackedTrade,
} from "../../lib/ws-user-client";

// Re-export market data store
export {
  MarketDataStore,
  getMarketDataStore,
  initMarketDataStore,
  type TokenMarketData,
  type OrderbookLevel,
  type OrderbookSnapshot,
  type MarketDataMode,
} from "../../lib/market-data-store";

// Re-export market data facade
export {
  MarketDataFacade,
  initMarketDataFacade,
  getMarketDataFacade,
  isMarketDataFacadeInitialized,
  type OrderbookState,
  type DetailedOrderbook,
  type FacadeMetrics,
} from "../../lib/market-data-facade";

// WebSocket URLs and configuration from constants
export {
  POLYMARKET_WS,
  getMarketWsUrl,
  getUserWsUrl,
} from "../../lib/constants";

// ============================================================================
// WebSocket Connection Utilities
// ============================================================================

/**
 * Reconnection configuration
 *
 * These values are already implemented in the WebSocket clients but exposed here
 * for reference and potential customization.
 */
export interface ReconnectConfig {
  /** Base delay in ms for exponential backoff */
  reconnectBaseMs: number;
  /** Maximum delay in ms */
  reconnectMaxMs: number;
  /** Time in ms connection must be stable before resetting backoff */
  stableConnectionMs: number;
  /** Ping interval in ms for keepalive */
  pingIntervalMs: number;
  /** Pong timeout in ms (market client only) */
  pongTimeoutMs: number;
  /** Connection timeout in ms */
  connectionTimeoutMs: number;
}

/**
 * Get default reconnect configuration from environment/constants
 */
export function getDefaultReconnectConfig(): ReconnectConfig {
  // Import dynamically to avoid circular dependency
  const { POLYMARKET_WS } = require("../../lib/constants");

  return {
    reconnectBaseMs: POLYMARKET_WS.RECONNECT_BASE_MS,
    reconnectMaxMs: POLYMARKET_WS.RECONNECT_MAX_MS,
    stableConnectionMs: POLYMARKET_WS.STABLE_CONNECTION_MS,
    pingIntervalMs: POLYMARKET_WS.PING_INTERVAL_MS,
    pongTimeoutMs: POLYMARKET_WS.PONG_TIMEOUT_MS,
    connectionTimeoutMs: POLYMARKET_WS.CONNECTION_TIMEOUT_MS,
  };
}

// ============================================================================
// WebSocket Manager - Unified connection management
// ============================================================================

/**
 * WebSocket connection health status
 */
export interface WsHealthStatus {
  marketClient: {
    connected: boolean;
    state: string;
    subscriptions: number;
    lastMessageAgeMs: number;
    reconnectAttempts: number;
    uptimeMs: number;
  };
  userClient: {
    connected: boolean;
    state: string;
    lastMessageAgeMs: number;
    reconnectAttempts: number;
    uptimeMs: number;
    activeOrders: number;
  };
}

/**
 * Get unified WebSocket health status
 */
export function getWsHealthStatus(): WsHealthStatus {
  const marketClient = _getMarketClient();
  const userClient = _getUserClient();

  const marketMetrics = marketClient.getMetrics();
  const userMetrics = userClient.getMetrics();

  return {
    marketClient: {
      connected: marketClient.isConnected(),
      state: marketMetrics.state,
      subscriptions: marketMetrics.subscriptions,
      lastMessageAgeMs: marketMetrics.lastMessageAgeMs,
      reconnectAttempts: marketMetrics.reconnectAttempts,
      uptimeMs: marketMetrics.uptimeMs,
    },
    userClient: {
      connected: userClient.isConnected(),
      state: userMetrics.state,
      lastMessageAgeMs: userMetrics.lastMessageAgeMs,
      reconnectAttempts: userMetrics.reconnectAttempts,
      uptimeMs: userMetrics.uptimeMs,
      activeOrders: userMetrics.orderStoreMetrics.activeOrders,
    },
  };
}

/**
 * Disconnect all WebSocket clients
 */
export function disconnectAllWs(): void {
  const marketClient = _getMarketClient();
  const userClient = _getUserClient();

  marketClient.disconnect();
  userClient.disconnect();
}
