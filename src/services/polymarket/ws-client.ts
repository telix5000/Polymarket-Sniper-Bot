/**
 * Polymarket WebSocket Client
 *
 * Thin wrapper around the WebSocket clients for market and user data.
 * Re-exports from lib for backward compatibility.
 *
 * Future improvements:
 * - Unified reconnection handling
 * - Connection state management
 * - Message buffering during reconnects
 */

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

// WebSocket URLs from constants
export {
  POLYMARKET_WS,
  getMarketWsUrl,
  getUserWsUrl,
} from "../../lib/constants";
