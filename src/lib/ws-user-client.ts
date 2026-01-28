/**
 * WebSocketUserClient - CLOB WebSocket client for user order/trade events
 *
 * Connects to Polymarket's CLOB WebSocket for authenticated events:
 * - Order status changes (OPEN, MATCHED, CANCELLED, etc.)
 * - Trade/fill events
 * - Balance updates
 *
 * This eliminates the need to poll for order status and fill detection.
 *
 * Official endpoint: wss://ws-subscriptions-clob.polymarket.com/ws/user
 * Per Polymarket docs: URL path determines channel (market vs user)
 * Authentication: Sent via subscribe payload with API credentials
 */

import WebSocket from "ws";
import type { ClobClient } from "@polymarket/clob-client";
import { POLYMARKET_WS, getUserWsUrl } from "./constants";

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
  | "LIVE" // Order is on the orderbook
  | "MATCHED" // Order was fully filled
  | "DELAYED" // Order is being processed
  | "CANCELLED" // Order was cancelled
  | "EXPIRED"; // Order expired (GTC timeout)

/** User channel message types */
export type UserEventType =
  | "order" // Order status change
  | "trade" // Trade/fill event
  | "balance"; // Balance update

/** Order event from WebSocket */
export interface OrderEvent {
  type: "order";
  id: string; // Order ID
  status: OrderStatus;
  asset_id: string; // Token ID
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
  id: string; // Trade ID
  taker_order_id: string;
  maker_order_id: string;
  status: string;
  asset_id: string; // Token ID
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
  stableConnectionMs?: number;
  pingIntervalMs?: number;
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
        `(${order.sizeMatched}/${order.originalSize} filled @ ${(order.price * 100).toFixed(1)}¢)`,
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
        `= $${fillValue.toFixed(2)} (order: ${trade.orderId.slice(0, 12)}...)`,
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
    return Array.from(this.orders.values()).filter((o) => o.status === "LIVE");
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

  // Auth credentials cached from CLOB client
  private authCredentials: {
    apiKey: string;
    secret: string;
    passphrase: string;
  } | null = null;

  // Flag to disable reconnection when auth credentials are missing
  private authDisabled = false;

  // State stores
  private orderStore = new OrderStateStore();

  // Reconnection state - single-flight guard to prevent concurrent reconnect loops
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isReconnecting = false;

  // Keepalive state - sends "PING" text message on interval
  private pingTimer: NodeJS.Timeout | null = null;

  // Stable connection timer - resets backoff after connection is stable
  private stableConnectionTimer: NodeJS.Timeout | null = null;

  // Connection timeout
  private connectionTimer: NodeJS.Timeout | null = null;

  // Metrics
  private messagesReceived = 0;
  private lastMessageAt = 0;
  private connectTime = 0;

  // Configuration
  private readonly url: string;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly stableConnectionMs: number;
  private readonly pingIntervalMs: number;
  private readonly connectionTimeoutMs: number;

  // Callbacks
  private onConnectCb?: () => void;
  private onDisconnectCb?: (code: number, reason: string) => void;
  private onErrorCb?: (error: Error) => void;
  private onOrderUpdateCb?: (event: OrderEvent) => void;
  private onTradeCb?: (event: TradeEvent) => void;
  private onBalanceCb?: (event: BalanceEvent) => void;

  constructor(options?: WsUserClientOptions) {
    // Use getUserWsUrl() for correct path: /ws/user (not just /ws/)
    this.url = options?.url ?? getUserWsUrl();
    this.reconnectBaseMs =
      options?.reconnectBaseMs ?? POLYMARKET_WS.RECONNECT_BASE_MS;
    this.reconnectMaxMs =
      options?.reconnectMaxMs ?? POLYMARKET_WS.RECONNECT_MAX_MS;
    this.stableConnectionMs =
      options?.stableConnectionMs ?? POLYMARKET_WS.STABLE_CONNECTION_MS;
    this.pingIntervalMs =
      options?.pingIntervalMs ?? POLYMARKET_WS.PING_INTERVAL_MS;
    this.connectionTimeoutMs =
      options?.connectionTimeoutMs ?? POLYMARKET_WS.CONNECTION_TIMEOUT_MS;

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
    if (
      this.state === "CONNECTED" ||
      this.state === "CONNECTING" ||
      this.state === "AUTHENTICATING"
    ) {
      console.log(`[WS-User] Already ${this.state}, skipping connect`);
      return;
    }

    // Check if auth has been permanently disabled due to missing credentials
    if (this.authDisabled) {
      console.warn(
        "[WS-User] Auth disabled due to missing credentials - not attempting connection",
      );
      return;
    }

    // Single-flight guard: if we're already in a reconnect loop, skip
    if (this.isReconnecting && this.reconnectTimer) {
      console.log("[WS-User] Reconnect already scheduled, skipping");
      return;
    }

    this.clobClient = clobClient;

    // Extract and validate auth credentials
    const creds = await this.extractAuthCredentials(clobClient);
    if (!creds) {
      console.warn(
        "[WS-User] ⚠️ Missing API credentials (apiKey/secret/passphrase) - User WebSocket DISABLED",
      );
      console.warn(
        "[WS-User] Order tracking will rely on REST API polling instead",
      );
      this.authDisabled = true;
      this.state = "DISCONNECTED";
      this.onErrorCb?.(new Error("Missing API credentials for User WebSocket"));
      return;
    }
    this.authCredentials = creds;

    this.state = this.reconnectAttempt > 0 ? "RECONNECTING" : "CONNECTING";
    console.log(
      `[WS-User] ${this.state} to ${this.url} (attempt ${this.reconnectAttempt + 1})...`,
    );

    try {
      // Connect to base URL (same as market client) - no auth headers needed
      // Auth is sent via subscribe payload after connection
      this.ws = new WebSocket(this.url);
      this.setupEventHandlers();
      this.startConnectionTimeout();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[WS-User] Connection failed: ${error.message}`);
      this.onErrorCb?.(error);
      this.scheduleReconnect();
    }
  }

  /**
   * Disconnect from WebSocket - performs clean shutdown
   */
  disconnect(): void {
    console.log("[WS-User] Disconnecting...");
    this.clearAllTimers();
    this.isReconnecting = false;
    this.reconnectAttempt = 0;
    this.state = "DISCONNECTED";

    if (this.ws) {
      // Remove all listeners before closing to prevent callbacks
      this.ws.removeAllListeners();
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
      lastMessageAgeMs:
        this.lastMessageAt > 0 ? Date.now() - this.lastMessageAt : 0,
      reconnectAttempts: this.reconnectAttempt,
      uptimeMs: this.connectTime > 0 ? Date.now() - this.connectTime : 0,
      orderStoreMetrics: this.orderStore.getMetrics(),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private - Authentication
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Extract and validate API credentials from CLOB client.
   * Returns null if credentials are missing or incomplete.
   *
   * NOTE: The CLOB client stores credentials with field names:
   * - creds.key (NOT apiKey) - this is the API key
   * - creds.secret
   * - creds.passphrase
   */
  private async extractAuthCredentials(
    clobClient: ClobClient,
  ): Promise<{ apiKey: string; secret: string; passphrase: string } | null> {
    try {
      // Try to get credentials from CLOB client's internal state
      const creds = (clobClient as any).creds;

      // IMPORTANT: CLOB client uses "key" not "apiKey" for the API key field.
      // The derived credentials from createOrDeriveApiKey() return { key, secret, passphrase }.
      // We also check "apiKey" as a defensive fallback in case the CLOB client API changes
      // or for backward compatibility with older versions.
      const apiKey =
        creds?.key || creds?.apiKey || process.env.POLY_API_KEY || "";
      const secret = creds?.secret || process.env.POLY_API_SECRET || "";
      const passphrase = creds?.passphrase || process.env.POLY_PASSPHRASE || "";

      // Debug logging for credential mapping - only log when DEBUG is enabled
      // or when credentials are missing (to help diagnose issues)
      const hasApiKey = !!apiKey;
      const hasSecret = !!secret;
      const hasPassphrase = !!passphrase;

      if (process.env.DEBUG || !hasApiKey || !hasSecret || !hasPassphrase) {
        console.log("[WS-User] Credential mapping check:", {
          hasCredsObject: !!creds,
          hasKey: !!creds?.key,
          hasApiKey: !!creds?.apiKey,
          hasSecret: !!creds?.secret,
          hasPassphrase: !!creds?.passphrase,
          mappedApiKey: hasApiKey,
          mappedSecret: hasSecret,
          mappedPassphrase: hasPassphrase,
        });
      }

      // Validate all required credentials are present
      if (!hasApiKey || !hasSecret || !hasPassphrase) {
        console.warn("[WS-User] Missing credentials after mapping:", {
          hasApiKey,
          hasSecret,
          hasPassphrase,
        });
        return null;
      }

      return { apiKey, secret, passphrase };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(
        `[WS-User] Failed to extract auth credentials: ${error.message}`,
      );
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private - Event Handlers
  // ═══════════════════════════════════════════════════════════════════════════

  private setupEventHandlers(): void {
    if (!this.ws) return;

    this.ws.on("open", () => {
      this.clearConnectionTimeout();
      this.isReconnecting = false;
      this.state = "AUTHENTICATING";
      console.log(
        `[WS-User] Connected to ${this.url}, sending auth subscription...`,
      );

      // Send subscribe message for user channel with auth credentials
      this.sendSubscribe();
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      this.lastMessageAt = Date.now();
      this.messagesReceived++;

      try {
        const msgStr = data.toString();
        // Handle PONG response to our PING keepalive
        if (msgStr === "PONG") {
          return;
        }
        const message = JSON.parse(msgStr);
        this.handleMessage(message);
      } catch {
        // Non-JSON message (like PONG) - ignore
      }
    });

    this.ws.on("close", (code: number, reason: Buffer) => {
      const reasonStr = reason.toString() || "No reason provided";
      console.log(
        `[WS-User] Connection closed: code=${code}, reason="${reasonStr}"`,
      );

      this.ws = null;
      this.clearPing();
      this.clearStableConnectionTimer();

      this.onDisconnectCb?.(code, reasonStr);

      // Don't reconnect if:
      // - closed intentionally (code 1000)
      // - auth is disabled
      // - no CLOB client available
      if (code !== 1000 && !this.authDisabled && this.clobClient) {
        this.scheduleReconnect();
      } else {
        this.state = "DISCONNECTED";
        this.reconnectAttempt = 0;
      }
    });

    this.ws.on(
      "error",
      (err: Error & { code?: string; statusCode?: number }) => {
        // Log detailed error info including URL, any status codes, and error codes
        // This helps diagnose handshake failures (e.g., 404 from wrong URL path)
        const parts: string[] = [err.message];
        if (err.code) parts.push(`code: ${err.code}`);
        if (err.statusCode) parts.push(`statusCode: ${err.statusCode}`);
        const errorInfo = parts.join(", ");
        console.error(
          `[WS-User] WebSocket error connecting to ${this.url}: ${errorInfo}`,
        );
        this.onErrorCb?.(err);
      },
    );
  }

  private handleMessage(message: any): void {
    // Handle subscription confirmation
    if (message.type === "subscribed") {
      this.state = "CONNECTED";
      this.connectTime = Date.now();

      console.log("[WS-User] Authenticated and subscribed to user channel");

      // Start keepalive ping
      this.startPing();

      // Start stable connection timer to reset backoff
      this.startStableConnectionTimer();

      this.onConnectCb?.();
      return;
    }

    // Handle auth errors
    if (message.type === "error") {
      const errorMsg = message.message || JSON.stringify(message);
      console.error(`[WS-User] Server error: ${errorMsg}`);

      // Check if it's an auth error - disable reconnection to prevent spam
      if (
        errorMsg.includes("auth") ||
        errorMsg.includes("unauthorized") ||
        errorMsg.includes("invalid")
      ) {
        console.warn(
          "[WS-User] Authentication error detected - disabling reconnection",
        );
        this.authDisabled = true;
        this.onErrorCb?.(new Error(`Authentication failed: ${errorMsg}`));
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
      case "order": {
        const orderEvent = event as OrderEvent;
        this.orderStore.updateOrder(orderEvent);
        this.onOrderUpdateCb?.(orderEvent);
        break;
      }

      case "trade": {
        const tradeEvent = event as TradeEvent;
        this.orderStore.recordTrade(tradeEvent);
        this.onTradeCb?.(tradeEvent);
        break;
      }

      case "balance": {
        const balanceEvent = event as BalanceEvent;
        this.onBalanceCb?.(balanceEvent);
        break;
      }

      default:
        // Unknown event type, log for debugging
        console.debug(`[WS-User] Unknown event type: ${eventType}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private - Message Sending
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Send subscribe message for user channel with auth credentials in payload.
   * Per Polymarket docs: {"type": "user", "markets": [...], "auth": {...}}
   *
   * The "markets" field can contain condition IDs to filter which markets to receive
   * updates for. An empty array means receive updates for all user's active markets.
   * Per the official Python quickstart, an empty array is the standard approach.
   */
  private sendSubscribe(): void {
    if (!this.ws || !this.authCredentials) {
      console.error(
        "[WS-User] Cannot send subscribe: missing WebSocket or credentials",
      );
      return;
    }

    // Subscribe to user channel with auth credentials in payload
    // NOTE: This message contains sensitive credentials - NEVER log the message content
    // Format per Polymarket Python quickstart: {"type": "user", "markets": [], "auth": {...}}
    // Empty markets array = receive updates for all user's active markets
    const message = {
      type: "user",
      markets: [] as string[], // Can be populated with condition IDs to filter
      auth: {
        apiKey: this.authCredentials.apiKey,
        secret: this.authCredentials.secret,
        passphrase: this.authCredentials.passphrase,
      },
    };

    try {
      this.ws.send(JSON.stringify(message));
      console.log("[WS-User] Sent subscribe to user channel with auth");
    } catch (err) {
      // Do not log the message content as it contains sensitive credentials
      console.error("[WS-User] Failed to send subscribe message");
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private - Timers and Reconnection
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Start sending "PING" text messages at interval for keepalive.
   * The server should respond with "PONG".
   */
  private startPing(): void {
    this.clearPing();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.state === "CONNECTED") {
        try {
          this.ws.send("PING");
        } catch {
          // Send failed, connection likely dead
          console.warn("[WS-User] Ping send failed, scheduling reconnect");
          this.scheduleReconnect();
        }
      }
    }, this.pingIntervalMs);
  }

  private clearPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * Start timer that resets backoff after connection has been stable.
   * This prevents perpetual backoff growth from transient disconnects.
   */
  private startStableConnectionTimer(): void {
    this.clearStableConnectionTimer();
    this.stableConnectionTimer = setTimeout(() => {
      if (this.state === "CONNECTED") {
        console.log("[WS-User] Connection stable, resetting backoff counter");
        this.reconnectAttempt = 0;
      }
    }, this.stableConnectionMs);
  }

  private clearStableConnectionTimer(): void {
    if (this.stableConnectionTimer) {
      clearTimeout(this.stableConnectionTimer);
      this.stableConnectionTimer = null;
    }
  }

  private startConnectionTimeout(): void {
    this.clearConnectionTimeout();
    this.connectionTimer = setTimeout(() => {
      if (
        this.state === "CONNECTING" ||
        this.state === "RECONNECTING" ||
        this.state === "AUTHENTICATING"
      ) {
        console.warn("[WS-User] Connection timeout, scheduling reconnect");
        if (this.ws) {
          this.ws.removeAllListeners();
          try {
            this.ws.close();
          } catch {
            // Ignore
          }
          this.ws = null;
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

  /**
   * Schedule a reconnection with exponential backoff + jitter.
   * Single-flight guard ensures only one reconnect loop runs at a time.
   */
  private scheduleReconnect(): void {
    // Don't reconnect if auth is disabled or no CLOB client
    if (this.authDisabled) {
      console.warn("[WS-User] Not reconnecting: auth disabled");
      this.state = "DISCONNECTED";
      return;
    }

    if (!this.clobClient) {
      console.warn("[WS-User] Not reconnecting: no CLOB client");
      this.state = "DISCONNECTED";
      return;
    }

    // Single-flight guard: if already reconnecting, don't start another
    if (this.isReconnecting && this.reconnectTimer) {
      console.log("[WS-User] Reconnect already scheduled, skipping duplicate");
      return;
    }

    this.clearAllTimers();
    this.isReconnecting = true;
    this.state = "RECONNECTING";
    this.reconnectAttempt++;

    // Exponential backoff with jitter (30% randomness)
    const baseDelay = Math.min(
      this.reconnectBaseMs * Math.pow(2, this.reconnectAttempt - 1),
      this.reconnectMaxMs,
    );
    const jitter = Math.random() * baseDelay * 0.3;
    const delay = Math.round(baseDelay + jitter);

    console.log(
      `[WS-User] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt}, max backoff ${this.reconnectMaxMs}ms)`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.clobClient) {
        this.connect(this.clobClient);
      }
    }, delay);
  }

  private clearAllTimers(): void {
    this.clearPing();
    this.clearStableConnectionTimer();
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
export function initWebSocketUserClient(
  options?: WsUserClientOptions,
): WebSocketUserClient {
  if (globalUserWsClient) {
    globalUserWsClient.disconnect();
  }
  globalUserWsClient = new WebSocketUserClient(options);
  return globalUserWsClient;
}
