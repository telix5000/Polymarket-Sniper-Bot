/**
 * WebSocketUserClient - CLOB WebSocket client for user order/trade events
 * 
 * Connects to Polymarket's CLOB User WebSocket for authenticated events:
 * - Order status changes (OPEN, MATCHED, CANCELLED, etc.)
 * - Trade/fill events
 * - Balance updates
 * 
 * This eliminates the need to poll for order status and fill detection.
 * 
 * Official endpoint: wss://ws-subscriptions-clob.polymarket.com/ws/user
 * Authentication: Uses CLOB API key via L1 authentication headers
 */

import WebSocket from "ws";
import type { ClobClient } from "@polymarket/clob-client";
import { POLYMARKET_WS } from "./constants";

// ============================================================================
// Types
// ============================================================================

/** WebSocket connection state */
export type WsUserConnectionState = 
  | "DISCONNECTED" 
  | "CONNECTING" 
  | "AUTHENTICATING"
  | "CONNECTED" 
  | "RECONNECTING";

/** Order status from WebSocket */
export type OrderStatus = 
  | "LIVE"      // Order is on the orderbook
  | "MATCHED"   // Order was fully filled
  | "DELAYED"   // Order is being processed
  | "CANCELLED" // Order was cancelled
  | "EXPIRED";  // Order expired (GTC timeout)

/** User channel message types */
export type UserEventType = 
  | "order"         // Order status change
  | "trade"         // Trade/fill event
  | "balance";      // Balance update

/** Order event from WebSocket */
export interface OrderEvent {
  type: "order";
  id: string;           // Order ID
  status: OrderStatus;
  asset_id: string;     // Token ID
  side: "BUY" | "SELL";
  price: string;
  original_size: string;
  size_matched: string;
  fee_rate_bps: string;
  created_at: string;
  expiration?: string;
  outcome?: string;
  market?: string;
}

/** Trade/fill event from WebSocket */
export interface TradeEvent {
  type: "trade";
  id: string;           // Trade ID
  taker_order_id: string;
  maker_order_id: string;
  status: string;
  asset_id: string;     // Token ID
  side: "BUY" | "SELL";
  price: string;
  size: string;
  fee_rate_bps: string;
  match_time: string;
  market?: string;
  outcome?: string;
  owner?: string;
  bucket_index?: number;
}

/** Balance update event */
export interface BalanceEvent {
  type: "balance";
  asset_type: string;
  asset_id?: string;
  balance: string;
  timestamp: string;
}

/** User event (union type) */
export type UserEvent = OrderEvent | TradeEvent | BalanceEvent;

/** Client options */
export interface WsUserClientOptions {
  url?: string;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  heartbeatIntervalMs?: number;
  connectionTimeoutMs?: number;
  onConnect?: () => void;
  onDisconnect?: (code: number, reason: string) => void;
  onError?: (error: Error) => void;
  onOrderUpdate?: (event: OrderEvent) => void;
  onTrade?: (event: TradeEvent) => void;
  onBalance?: (event: BalanceEvent) => void;
}

// ============================================================================
// OrderStateStore - Track order states
// ============================================================================

export interface TrackedOrder {
  orderId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  originalSize: number;
  sizeMatched: number;
  status: OrderStatus;
  createdAt: number;
  updatedAt: number;
}

export interface TrackedTrade {
  tradeId: string;
  orderId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  timestamp: number;
}

/**
 * OrderStateStore - Tracks order states from User WebSocket channel
 */
export class OrderStateStore {
  private orders = new Map<string, TrackedOrder>();
  private trades = new Map<string, TrackedTrade>();
  private ordersByToken = new Map<string, Set<string>>();
  
  // Metrics
  private totalOrderUpdates = 0;
  private totalTrades = 0;

  /**
   * Update order from WebSocket event
   */
  updateOrder(event: OrderEvent): TrackedOrder {
    const order: TrackedOrder = {
      orderId: event.id,
      tokenId: event.asset_id,
      side: event.side,
      price: parseFloat(event.price),
      originalSize: parseFloat(event.original_size),
      sizeMatched: parseFloat(event.size_matched),
      status: event.status,
      createdAt: new Date(event.created_at).getTime(),
      updatedAt: Date.now(),
    };

    this.orders.set(order.orderId, order);
    
    // Index by token
    if (!this.ordersByToken.has(order.tokenId)) {
      this.ordersByToken.set(order.tokenId, new Set());
    }
    this.ordersByToken.get(order.tokenId)!.add(order.orderId);

    this.totalOrderUpdates++;
    
    // Log state transition
    console.log(
      `📋 [OrderState] ${order.side} ${order.orderId.slice(0, 12)}... → ${order.status} ` +
      `(${order.sizeMatched}/${order.originalSize} filled @ ${(order.price * 100).toFixed(1)}¢)`
    );

    return order;
  }

  /**
   * Record trade from WebSocket event
   */
  recordTrade(event: TradeEvent): TrackedTrade {
    const trade: TrackedTrade = {
      tradeId: event.id,
      orderId: event.taker_order_id,
      tokenId: event.asset_id,
      side: event.side,
      price: parseFloat(event.price),
      size: parseFloat(event.size),
      timestamp: new Date(event.match_time).getTime(),
    };

    this.trades.set(trade.tradeId, trade);
    this.totalTrades++;

    // Log fill
    const fillValue = trade.size * trade.price;
    console.log(
      `💰 [Trade] ${trade.side} fill: ${trade.size.toFixed(4)} shares @ ${(trade.price * 100).toFixed(1)}¢ ` +
      `= $${fillValue.toFixed(2)} (order: ${trade.orderId.slice(0, 12)}...)`
    );

    return trade;
  }

  /**
   * Get order by ID
   */
  getOrder(orderId: string): TrackedOrder | null {
    return this.orders.get(orderId) ?? null;
  }

  /**
   * Get orders for a token
   */
  getOrdersForToken(tokenId: string): TrackedOrder[] {
    const orderIds = this.ordersByToken.get(tokenId);
    if (!orderIds) return [];
    
    const orders: TrackedOrder[] = [];
    for (const id of orderIds) {
      const order = this.orders.get(id);
      if (order) orders.push(order);
    }
    return orders;
  }

  /**
   * Get active (LIVE) orders
   */
  getActiveOrders(): TrackedOrder[] {
    return Array.from(this.orders.values()).filter(o => o.status === "LIVE");
  }

  /**
   * Get recent trades (last N)
   */
  getRecentTrades(limit: number = 50): TrackedTrade[] {
    const trades = Array.from(this.trades.values());
    trades.sort((a, b) => b.timestamp - a.timestamp);
    return trades.slice(0, limit);
  }

  /**
   * Clear old data (memory management)
   */
  cleanup(maxAgeMs: number = 24 * 60 * 60 * 1000): void {
    const cutoff = Date.now() - maxAgeMs;
    
    // Clean old orders
    for (const [id, order] of this.orders.entries()) {
      if (order.updatedAt < cutoff && order.status !== "LIVE") {
        this.orders.delete(id);
        const tokenOrders = this.ordersByToken.get(order.tokenId);
        if (tokenOrders) {
          tokenOrders.delete(id);
        }
      }
    }

    // Clean old trades
    for (const [id, trade] of this.trades.entries()) {
      if (trade.timestamp < cutoff) {
        this.trades.delete(id);
      }
    }
  }

  /**
   * Get metrics
   */
  getMetrics(): {
    activeOrders: number;
    totalOrders: number;
    totalTrades: number;
    totalOrderUpdates: number;
  } {
    return {
      activeOrders: this.getActiveOrders().length,
      totalOrders: this.orders.size,
      totalTrades: this.trades.size,
      totalOrderUpdates: this.totalOrderUpdates,
    };
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.orders.clear();
    this.trades.clear();
    this.ordersByToken.clear();
    this.totalOrderUpdates = 0;
    this.totalTrades = 0;
  }
}

// ============================================================================
// WebSocketUserClient Implementation
// ============================================================================

export class WebSocketUserClient {
  private ws: WebSocket | null = null;
  private state: WsUserConnectionState = "DISCONNECTED";
  private clobClient: ClobClient | null = null;
  
  // State stores
  private orderStore = new OrderStateStore();
  
  // Reconnection state
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private connectionTimer: NodeJS.Timeout | null = null;
  
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
  private onOrderUpdateCb?: (event: OrderEvent) => void;
  private onTradeCb?: (event: TradeEvent) => void;
  private onBalanceCb?: (event: BalanceEvent) => void;

  constructor(options?: WsUserClientOptions) {
    this.url = options?.url ?? POLYMARKET_WS.USER_URL;
    this.reconnectBaseMs = options?.reconnectBaseMs ?? POLYMARKET_WS.RECONNECT_BASE_MS;
    this.reconnectMaxMs = options?.reconnectMaxMs ?? POLYMARKET_WS.RECONNECT_MAX_MS;
    this.heartbeatIntervalMs = options?.heartbeatIntervalMs ?? POLYMARKET_WS.HEARTBEAT_INTERVAL_MS;
    this.connectionTimeoutMs = options?.connectionTimeoutMs ?? POLYMARKET_WS.CONNECTION_TIMEOUT_MS;
    
    this.onConnectCb = options?.onConnect;
    this.onDisconnectCb = options?.onDisconnect;
    this.onErrorCb = options?.onError;
    this.onOrderUpdateCb = options?.onOrderUpdate;
    this.onTradeCb = options?.onTrade;
    this.onBalanceCb = options?.onBalance;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Public API - Connection Management
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Connect to WebSocket with authentication
   * @param clobClient - Authenticated CLOB client for credentials
   */
  async connect(clobClient: ClobClient): Promise<void> {
    if (this.state === "CONNECTED" || this.state === "CONNECTING" || this.state === "AUTHENTICATING") {
      return;
    }

    this.clobClient = clobClient;
    this.state = this.reconnectAttempt > 0 ? "RECONNECTING" : "CONNECTING";
    console.log(`[WS-User] ${this.state} to ${this.url}...`);

    try {
      // Get authentication headers from CLOB client
      // The user WebSocket requires L1 auth headers
      const authHeaders = await this.getAuthHeaders(clobClient);
      
      this.ws = new WebSocket(this.url, {
        headers: authHeaders,
      });
      this.setupEventHandlers();
      this.startConnectionTimeout();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[WS-User] Connection error: ${error.message}`);
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
    
    console.log("[WS-User] Disconnected");
  }

  /**
   * Get current connection state
   */
  getState(): WsUserConnectionState {
    return this.state;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.state === "CONNECTED";
  }

  /**
   * Get the order state store
   */
  getOrderStore(): OrderStateStore {
    return this.orderStore;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Public API - Metrics
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get client metrics
   */
  getMetrics(): {
    state: WsUserConnectionState;
    messagesReceived: number;
    lastMessageAgeMs: number;
    reconnectAttempts: number;
    uptimeMs: number;
    orderStoreMetrics: ReturnType<OrderStateStore["getMetrics"]>;
  } {
    return {
      state: this.state,
      messagesReceived: this.messagesReceived,
      lastMessageAgeMs: this.lastMessageAt > 0 ? Date.now() - this.lastMessageAt : 0,
      reconnectAttempts: this.reconnectAttempt,
      uptimeMs: this.connectTime > 0 ? Date.now() - this.connectTime : 0,
      orderStoreMetrics: this.orderStore.getMetrics(),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private - Authentication
  // ═══════════════════════════════════════════════════════════════════════════

  private async getAuthHeaders(clobClient: ClobClient): Promise<Record<string, string>> {
    // The CLOB client has built-in authentication
    // We need to create L1 auth headers for WebSocket connection
    // This uses the same credentials as the CLOB client
    try {
      // Get the API key and secret from the CLOB client's internal state
      // The createL1Headers method generates the required auth headers
      const headers = await (clobClient as any).createL1Headers?.() ?? {};
      
      // If createL1Headers is not available, fall back to basic auth approach
      if (Object.keys(headers).length === 0) {
        // The WebSocket server expects POLY_ADDRESS and POLY_SIGNATURE headers
        // These are typically set during CLOB client initialization
        const creds = (clobClient as any).creds;
        if (creds?.apiKey) {
          return {
            "POLY_API_KEY": creds.apiKey,
            "POLY_API_SECRET": creds.secret || "",
            "POLY_PASSPHRASE": creds.passphrase || "",
          };
        }
      }
      
      return headers;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(
        `[WS-User] Failed to get auth headers. This may indicate an incompatible ClobClient version or missing API key credentials. Original error: ${error.message}`
      );
      // Surface the failure to consumers so they can handle authentication issues explicitly
      this.onErrorCb?.(error);
      return {};
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private - Event Handlers
  // ═══════════════════════════════════════════════════════════════════════════

  private setupEventHandlers(): void {
    if (!this.ws) return;

    this.ws.on("open", () => {
      this.clearConnectionTimeout();
      this.state = "AUTHENTICATING";
      console.log("[WS-User] Connection open, authenticating...");
      
      // Send subscribe message for user channel
      this.sendSubscribe();
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      this.lastMessageAt = Date.now();
      this.messagesReceived++;
      
      try {
        const message = JSON.parse(data.toString());
        this.handleMessage(message);
      } catch (err) {
        console.warn(`[WS-User] Failed to parse message: ${err}`);
      }
    });

    this.ws.on("close", (code: number, reason: Buffer) => {
      const reasonStr = reason.toString() || "Unknown";
      console.log(`[WS-User] Connection closed: ${code} - ${reasonStr}`);
      
      this.ws = null;
      this.clearHeartbeat();

      this.onDisconnectCb?.(code, reasonStr);

      // Don't reconnect if closed intentionally
      if (code !== 1000 && this.clobClient) {
        this.scheduleReconnect();
      } else {
        this.state = "DISCONNECTED";
      }
    });

    this.ws.on("error", (err: Error) => {
      console.error(`[WS-User] WebSocket error: ${err.message}`);
      this.onErrorCb?.(err);
    });

    this.ws.on("pong", () => {
      // Heartbeat acknowledged
    });
  }

  private handleMessage(message: any): void {
    // Handle subscription confirmation
    if (message.type === "subscribed") {
      this.state = "CONNECTED";
      this.reconnectAttempt = 0;
      this.connectTime = Date.now();
      
      console.log("[WS-User] Authenticated and subscribed to user channel");
      this.startHeartbeat();
      this.onConnectCb?.();
      return;
    }

    // Handle auth errors
    if (message.type === "error") {
      console.error(`[WS-User] Server error: ${message.message || JSON.stringify(message)}`);
      if (message.message?.includes("auth") || message.message?.includes("unauthorized")) {
        this.onErrorCb?.(new Error(`Authentication failed: ${message.message}`));
      }
      return;
    }

    // Handle user events
    if (Array.isArray(message)) {
      for (const event of message) {
        this.processUserEvent(event);
      }
    } else if (message.type) {
      this.processUserEvent(message);
    }
  }

  private processUserEvent(event: any): void {
    const eventType = event.type as UserEventType;

    switch (eventType) {
      case "order":
        const orderEvent = event as OrderEvent;
        this.orderStore.updateOrder(orderEvent);
        this.onOrderUpdateCb?.(orderEvent);
        break;

      case "trade":
        const tradeEvent = event as TradeEvent;
        this.orderStore.recordTrade(tradeEvent);
        this.onTradeCb?.(tradeEvent);
        break;

      case "balance":
        const balanceEvent = event as BalanceEvent;
        this.onBalanceCb?.(balanceEvent);
        break;

      default:
        // Unknown event type, log for debugging
        console.debug(`[WS-User] Unknown event type: ${eventType}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private - Message Sending
  // ═══════════════════════════════════════════════════════════════════════════

  private sendSubscribe(): void {
    if (!this.ws) return;

    // Subscribe to user channel
    const message = {
      type: "subscribe",
      channel: "user",
    };

    try {
      this.ws.send(JSON.stringify(message));
      console.log("[WS-User] Sent subscribe to user channel");
    } catch (err) {
      console.error(`[WS-User] Failed to send subscribe: ${err}`);
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
      if (this.state === "CONNECTING" || this.state === "RECONNECTING" || this.state === "AUTHENTICATING") {
        console.warn("[WS-User] Connection timeout");
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
    if (!this.clobClient) {
      this.state = "DISCONNECTED";
      return;
    }

    this.clearTimers();
    this.state = "RECONNECTING";
    this.reconnectAttempt++;

    // Exponential backoff with jitter
    const baseDelay = Math.min(
      this.reconnectBaseMs * Math.pow(2, this.reconnectAttempt - 1),
      this.reconnectMaxMs
    );
    const jitter = Math.random() * baseDelay * 0.3;
    const delay = baseDelay + jitter;

    console.log(`[WS-User] Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempt})`);

    this.reconnectTimer = setTimeout(() => {
      if (this.clobClient) {
        this.connect(this.clobClient);
      }
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

let globalUserWsClient: WebSocketUserClient | null = null;

/**
 * Get the global WebSocketUserClient instance
 */
export function getWebSocketUserClient(): WebSocketUserClient {
  if (!globalUserWsClient) {
    globalUserWsClient = new WebSocketUserClient();
  }
  return globalUserWsClient;
}

/**
 * Initialize a new global WebSocketUserClient (for testing or reset)
 */
export function initWebSocketUserClient(options?: WsUserClientOptions): WebSocketUserClient {
  if (globalUserWsClient) {
    globalUserWsClient.disconnect();
  }
  globalUserWsClient = new WebSocketUserClient(options);
  return globalUserWsClient;
}
