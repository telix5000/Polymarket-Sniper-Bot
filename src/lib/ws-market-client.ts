/**
 * WebSocketMarketClient - CLOB WebSocket client for market data
 * 
 * Connects to Polymarket's CLOB WebSocket and subscribes to Market Channel
 * for real-time L2 orderbook updates.
 * 
 * Features:
 * - Subscribe/unsubscribe to multiple tokenIds
 * - Automatic reconnection with exponential backoff + jitter
 * - Updates MarketDataStore on every message
 * - Staleness tracking per tokenId
 * - Health metrics and logging
 * 
 * Official endpoint: wss://ws-subscriptions-clob.polymarket.com/ws/
 * Market Channel: Subscribe to "market" channel with asset_id (tokenId)
 */

import WebSocket from "ws";
import { POLYMARKET_WS } from "./constants";
import { getMarketDataStore, type OrderbookLevel } from "./market-data-store";

// ============================================================================
// Types
// ============================================================================

/** WebSocket connection state */
export type WsConnectionState = 
  | "DISCONNECTED" 
  | "CONNECTING" 
  | "CONNECTED" 
  | "RECONNECTING";

/** WebSocket client options */
export interface WsClientOptions {
  url?: string;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  heartbeatIntervalMs?: number;
  connectionTimeoutMs?: number;
  onConnect?: () => void;
  onDisconnect?: (code: number, reason: string) => void;
  onError?: (error: Error) => void;
  onMessage?: (type: string, data: any) => void;
}

/** Subscription message format */
interface SubscribeMessage {
  type: "subscribe";
  channel: "market";
  assets_ids: string[];
}

/** Unsubscribe message format */
interface UnsubscribeMessage {
  type: "unsubscribe";
  channel: "market";
  assets_ids: string[];
}

/** Market channel message from WebSocket */
interface MarketChannelMessage {
  event_type: "book" | "price_change" | "last_trade_price" | "tick_size_change";
  asset_id: string;
  market?: string;
  hash?: string;
  timestamp?: string;
  // For "book" events
  bids?: Array<{ price: string; size: string }>;
  asks?: Array<{ price: string; size: string }>;
  // For price_change events
  price?: string;
  changes?: Array<{ price: string; size: string; side: "BUY" | "SELL" }>;
}

// ============================================================================
// WebSocketMarketClient Implementation
// ============================================================================

export class WebSocketMarketClient {
  private ws: WebSocket | null = null;
  private state: WsConnectionState = "DISCONNECTED";
  private subscriptions = new Set<string>();
  private pendingSubscriptions = new Set<string>();
  
  // Reconnection state
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private connectionTimer: NodeJS.Timeout | null = null;
  
  // L2 orderbook reconstruction
  private orderbooks = new Map<string, { bids: Map<string, number>; asks: Map<string, number> }>();
  
  // Metrics
  private messagesReceived = 0;
  private lastMessageAt = 0;
  private connectTime = 0;

  // Configuration
  private readonly url: string;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly connectionTimeoutMs: number;
  
  // Callbacks
  private onConnectCb?: () => void;
  private onDisconnectCb?: (code: number, reason: string) => void;
  private onErrorCb?: (error: Error) => void;
  private onMessageCb?: (type: string, data: any) => void;

  constructor(options?: WsClientOptions) {
    this.url = options?.url ?? POLYMARKET_WS.BASE_URL;
    this.reconnectBaseMs = options?.reconnectBaseMs ?? POLYMARKET_WS.RECONNECT_BASE_MS;
    this.reconnectMaxMs = options?.reconnectMaxMs ?? POLYMARKET_WS.RECONNECT_MAX_MS;
    this.heartbeatIntervalMs = options?.heartbeatIntervalMs ?? POLYMARKET_WS.HEARTBEAT_INTERVAL_MS;
    this.connectionTimeoutMs = options?.connectionTimeoutMs ?? POLYMARKET_WS.CONNECTION_TIMEOUT_MS;
    
    this.onConnectCb = options?.onConnect;
    this.onDisconnectCb = options?.onDisconnect;
    this.onErrorCb = options?.onError;
    this.onMessageCb = options?.onMessage;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Public API - Connection Management
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Connect to WebSocket
   */
  connect(): void {
    if (this.state === "CONNECTED" || this.state === "CONNECTING") {
      return;
    }

    this.state = this.reconnectAttempt > 0 ? "RECONNECTING" : "CONNECTING";
    console.log(`[WS-Market] ${this.state} to ${this.url}...`);

    try {
      this.ws = new WebSocket(this.url);
      this.setupEventHandlers();
      this.startConnectionTimeout();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[WS-Market] Connection error: ${error.message}`);
      this.onErrorCb?.(error);
      this.scheduleReconnect();
    }
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect(): void {
    this.clearTimers();
    this.state = "DISCONNECTED";
    
    if (this.ws) {
      try {
        this.ws.close(1000, "Client disconnect");
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }

    // Update store state
    getMarketDataStore().setWsConnected(false);
    
    console.log("[WS-Market] Disconnected");
  }

  /**
   * Get current connection state
   */
  getState(): WsConnectionState {
    return this.state;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.state === "CONNECTED";
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Public API - Subscriptions
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Subscribe to market data for token IDs
   */
  subscribe(tokenIds: string[]): void {
    if (tokenIds.length === 0) return;

    // Track subscriptions
    for (const id of tokenIds) {
      this.subscriptions.add(id);
    }

    if (this.state === "CONNECTED" && this.ws) {
      this.sendSubscribe(tokenIds);
    } else {
      // Queue for when connected
      for (const id of tokenIds) {
        this.pendingSubscriptions.add(id);
      }
    }
  }

  /**
   * Unsubscribe from market data for token IDs
   */
  unsubscribe(tokenIds: string[]): void {
    if (tokenIds.length === 0) return;

    // Remove from tracking
    for (const id of tokenIds) {
      this.subscriptions.delete(id);
      this.pendingSubscriptions.delete(id);
      this.orderbooks.delete(id);
    }

    if (this.state === "CONNECTED" && this.ws) {
      this.sendUnsubscribe(tokenIds);
    }
  }

  /**
   * Get currently subscribed token IDs
   */
  getSubscriptions(): string[] {
    return Array.from(this.subscriptions);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Public API - Metrics
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get client metrics
   */
  getMetrics(): {
    state: WsConnectionState;
    subscriptions: number;
    messagesReceived: number;
    lastMessageAgeMs: number;
    reconnectAttempts: number;
    uptimeMs: number;
  } {
    return {
      state: this.state,
      subscriptions: this.subscriptions.size,
      messagesReceived: this.messagesReceived,
      lastMessageAgeMs: this.lastMessageAt > 0 ? Date.now() - this.lastMessageAt : 0,
      reconnectAttempts: this.reconnectAttempt,
      uptimeMs: this.connectTime > 0 ? Date.now() - this.connectTime : 0,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private - Event Handlers
  // ═══════════════════════════════════════════════════════════════════════════

  private setupEventHandlers(): void {
    if (!this.ws) return;

    this.ws.on("open", () => {
      this.clearConnectionTimeout();
      this.state = "CONNECTED";
      this.reconnectAttempt = 0;
      this.connectTime = Date.now();

      console.log("[WS-Market] Connected");
      
      // Update store state
      getMarketDataStore().setWsConnected(true);

      // Start heartbeat
      this.startHeartbeat();

      // Send pending subscriptions
      if (this.pendingSubscriptions.size > 0) {
        this.sendSubscribe(Array.from(this.pendingSubscriptions));
        this.pendingSubscriptions.clear();
      } else if (this.subscriptions.size > 0) {
        // Re-subscribe to all on reconnect
        this.sendSubscribe(Array.from(this.subscriptions));
      }

      this.onConnectCb?.();
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      this.lastMessageAt = Date.now();
      this.messagesReceived++;
      
      try {
        const message = JSON.parse(data.toString());
        this.handleMessage(message);
      } catch (err) {
        console.warn(`[WS-Market] Failed to parse message: ${err}`);
      }
    });

    this.ws.on("close", (code: number, reason: Buffer) => {
      const reasonStr = reason.toString() || "Unknown";
      console.log(`[WS-Market] Connection closed: ${code} - ${reasonStr}`);
      
      this.ws = null;
      this.clearHeartbeat();
      
      // Update store state
      getMarketDataStore().setWsConnected(false);

      this.onDisconnectCb?.(code, reasonStr);

      // Don't reconnect if closed intentionally
      if (code !== 1000) {
        this.scheduleReconnect();
      } else {
        this.state = "DISCONNECTED";
      }
    });

    this.ws.on("error", (err: Error) => {
      console.error(`[WS-Market] WebSocket error: ${err.message}`);
      this.onErrorCb?.(err);
    });

    this.ws.on("pong", () => {
      // Heartbeat acknowledged
    });
  }

  private handleMessage(message: any): void {
    // Handle different message types
    if (Array.isArray(message)) {
      // Batch of market updates
      for (const update of message) {
        this.processMarketUpdate(update);
      }
    } else if (message.event_type) {
      // Single market update
      this.processMarketUpdate(message as MarketChannelMessage);
    } else if (message.type === "subscribed") {
      console.log(`[WS-Market] Subscribed to ${message.assets_ids?.length || 0} assets`);
    } else if (message.type === "unsubscribed") {
      console.log(`[WS-Market] Unsubscribed from ${message.assets_ids?.length || 0} assets`);
    } else if (message.type === "error") {
      console.error(`[WS-Market] Server error: ${message.message || JSON.stringify(message)}`);
    }

    this.onMessageCb?.(message.type || message.event_type || "unknown", message);
  }

  private processMarketUpdate(update: MarketChannelMessage): void {
    const tokenId = update.asset_id;
    if (!tokenId) return;

    const store = getMarketDataStore();

    if (update.event_type === "book") {
      // Full orderbook snapshot
      const bids = this.parseOrderbookLevels(update.bids);
      const asks = this.parseOrderbookLevels(update.asks);
      
      if (bids.length > 0 && asks.length > 0) {
        // Initialize/reset orderbook state
        const bidMap = new Map<string, number>();
        const askMap = new Map<string, number>();
        
        for (const level of bids) {
          bidMap.set(level.price.toString(), level.size);
        }
        for (const level of asks) {
          askMap.set(level.price.toString(), level.size);
        }
        
        this.orderbooks.set(tokenId, { bids: bidMap, asks: askMap });
        store.updateFromWs(tokenId, bids, asks);
      }
    } else if (update.event_type === "price_change" && update.changes) {
      // Incremental orderbook update (L2 delta)
      const book = this.orderbooks.get(tokenId);
      if (!book) {
        // No snapshot yet, can't apply delta
        return;
      }

      // Apply changes
      for (const change of update.changes) {
        const price = change.price;
        const size = parseFloat(change.size);
        const side = change.side;

        const map = side === "BUY" ? book.bids : book.asks;
        
        if (size === 0) {
          map.delete(price);
        } else {
          map.set(price, size);
        }
      }

      // Reconstruct sorted arrays
      const bids = this.mapToSortedLevels(book.bids, true);
      const asks = this.mapToSortedLevels(book.asks, false);

      if (bids.length > 0 && asks.length > 0) {
        store.updateFromWs(tokenId, bids, asks);
      }
    }
    // Ignore other event types (last_trade_price, tick_size_change) for now
  }

  private parseOrderbookLevels(levels?: Array<{ price: string; size: string }>): OrderbookLevel[] {
    if (!levels || !Array.isArray(levels)) return [];
    
    return levels
      .map(l => ({
        price: parseFloat(l.price),
        size: parseFloat(l.size),
      }))
      .filter(l => !isNaN(l.price) && !isNaN(l.size) && l.size > 0);
  }

  private mapToSortedLevels(map: Map<string, number>, descending: boolean): OrderbookLevel[] {
    const levels: OrderbookLevel[] = [];
    
    for (const [priceStr, size] of map.entries()) {
      if (size > 0) {
        levels.push({ price: parseFloat(priceStr), size });
      }
    }

    // Sort: bids descending (best first), asks ascending (best first)
    levels.sort((a, b) => descending ? b.price - a.price : a.price - b.price);
    
    return levels;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private - Message Sending
  // ═══════════════════════════════════════════════════════════════════════════

  private sendSubscribe(tokenIds: string[]): void {
    if (!this.ws || this.state !== "CONNECTED") return;

    const message: SubscribeMessage = {
      type: "subscribe",
      channel: "market",
      assets_ids: tokenIds,
    };

    try {
      this.ws.send(JSON.stringify(message));
      console.log(`[WS-Market] Subscribing to ${tokenIds.length} tokens`);
    } catch (err) {
      console.error(`[WS-Market] Failed to send subscribe: ${err}`);
    }
  }

  private sendUnsubscribe(tokenIds: string[]): void {
    if (!this.ws || this.state !== "CONNECTED") return;

    const message: UnsubscribeMessage = {
      type: "unsubscribe",
      channel: "market",
      assets_ids: tokenIds,
    };

    try {
      this.ws.send(JSON.stringify(message));
      console.log(`[WS-Market] Unsubscribing from ${tokenIds.length} tokens`);
    } catch (err) {
      console.error(`[WS-Market] Failed to send unsubscribe: ${err}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private - Timers and Reconnection
  // ═══════════════════════════════════════════════════════════════════════════

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.state === "CONNECTED") {
        try {
          this.ws.ping();
        } catch {
          // Ping failed, connection likely dead
          this.scheduleReconnect();
        }
      }
    }, this.heartbeatIntervalMs);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private startConnectionTimeout(): void {
    this.connectionTimer = setTimeout(() => {
      if (this.state === "CONNECTING" || this.state === "RECONNECTING") {
        console.warn("[WS-Market] Connection timeout");
        if (this.ws) {
          try {
            this.ws.close();
          } catch {
            // Ignore
          }
        }
        this.scheduleReconnect();
      }
    }, this.connectionTimeoutMs);
  }

  private clearConnectionTimeout(): void {
    if (this.connectionTimer) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
    }
  }

  private scheduleReconnect(): void {
    this.clearTimers();
    this.state = "RECONNECTING";
    this.reconnectAttempt++;

    // Exponential backoff with jitter
    const baseDelay = Math.min(
      this.reconnectBaseMs * Math.pow(2, this.reconnectAttempt - 1),
      this.reconnectMaxMs
    );
    const jitter = Math.random() * baseDelay * 0.3; // 30% jitter
    const delay = baseDelay + jitter;

    console.log(`[WS-Market] Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempt})`);

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    this.clearConnectionTimeout();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let globalWsClient: WebSocketMarketClient | null = null;

/**
 * Get the global WebSocketMarketClient instance
 */
export function getWebSocketMarketClient(): WebSocketMarketClient {
  if (!globalWsClient) {
    globalWsClient = new WebSocketMarketClient();
  }
  return globalWsClient;
}

/**
 * Initialize a new global WebSocketMarketClient (for testing or reset)
 */
export function initWebSocketMarketClient(options?: WsClientOptions): WebSocketMarketClient {
  if (globalWsClient) {
    globalWsClient.disconnect();
  }
  globalWsClient = new WebSocketMarketClient(options);
  return globalWsClient;
}
