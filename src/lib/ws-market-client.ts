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
 * - Keepalive via "PING" text messages (not WebSocket ping frames)
 * - Dead socket detection via PONG timeout (fixes code 1006 disconnects)
 * - Re-subscribes to all tokens after reconnect (exactly once)
 *
 * Official endpoint: wss://ws-subscriptions-clob.polymarket.com/ws/market
 * Per Polymarket docs: URL path determines channel (market vs user)
 * Market Channel: Subscribe via payload {"type":"market","assets_ids":[...]}
 */

import WebSocket from "ws";
import { POLYMARKET_WS, getMarketWsUrl } from "./constants";
import { getMarketDataStore, type OrderbookLevel } from "./market-data-store";
import {
  sortBidsDescending,
  sortAsksAscending,
  parseRawLevels,
} from "./orderbook-utils";

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
  stableConnectionMs?: number;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  connectionTimeoutMs?: number;
  onConnect?: () => void;
  onDisconnect?: (code: number, reason: string) => void;
  onError?: (error: Error) => void;
  onMessage?: (type: string, data: any) => void;
}

/**
 * Initial subscription message format.
 * Per Polymarket Python quickstart `on_open()`:
 *   ws.send(json.dumps({"assets_ids": self.data, "type": MARKET_CHANNEL}))
 */
interface SubscribeMessage {
  type: "market";
  assets_ids: string[];
}

/**
 * Additional subscription/unsubscription message format.
 * Per Polymarket Python quickstart `subscribe_to_tokens_ids()` and `unsubscribe_to_tokens_ids()`:
 *   ws.send(json.dumps({"assets_ids": assets_ids, "operation": "subscribe"}))
 *   ws.send(json.dumps({"assets_ids": assets_ids, "operation": "unsubscribe"}))
 */
interface SubscriptionOperationMessage {
  operation: "subscribe" | "unsubscribe";
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

// Import VPN status for logging at disconnect
import { isVpnActive, getVpnType } from "./vpn";

export class WebSocketMarketClient {
  private ws: WebSocket | null = null;
  private state: WsConnectionState = "DISCONNECTED";
  private subscriptions = new Set<string>();
  private pendingSubscriptions = new Set<string>();

  // Reconnection state - single-flight guard to prevent concurrent reconnect loops
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isReconnecting = false;

  // Keepalive state - sends "PING" text message on interval
  private pingTimer: NodeJS.Timeout | null = null;
  private lastPongAt = 0;
  private pongTimeoutTimer: NodeJS.Timeout | null = null;
  private pongTimeoutMs: number;

  // Stable connection timer - resets backoff after connection is stable
  private stableConnectionTimer: NodeJS.Timeout | null = null;

  // Connection timeout
  private connectionTimer: NodeJS.Timeout | null = null;

  // L2 orderbook reconstruction
  private orderbooks = new Map<
    string,
    { bids: Map<string, number>; asks: Map<string, number> }
  >();

  // Metrics
  private messagesReceived = 0;
  private lastMessageAt = 0;
  private connectTime = 0;

  // Disconnect tracking (Part D: WS 1006 Monitoring)
  private disconnectCount = 0;
  private lastDisconnectCode: number | null = null;
  private lastDisconnectTime = 0;
  private lastDisconnectVpnActive: boolean | null = null;
  private lastDisconnectVpnType: "wireguard" | "openvpn" | "none" | null = null;

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
  private onMessageCb?: (type: string, data: any) => void;

  constructor(options?: WsClientOptions) {
    // Use getMarketWsUrl() for correct path: /ws/market (not just /ws/)
    this.url = options?.url ?? getMarketWsUrl();
    this.reconnectBaseMs =
      options?.reconnectBaseMs ?? POLYMARKET_WS.RECONNECT_BASE_MS;
    this.reconnectMaxMs =
      options?.reconnectMaxMs ?? POLYMARKET_WS.RECONNECT_MAX_MS;
    this.stableConnectionMs =
      options?.stableConnectionMs ?? POLYMARKET_WS.STABLE_CONNECTION_MS;
    this.pingIntervalMs =
      options?.pingIntervalMs ?? POLYMARKET_WS.PING_INTERVAL_MS;
    this.pongTimeoutMs =
      options?.pongTimeoutMs ?? POLYMARKET_WS.PONG_TIMEOUT_MS;
    this.connectionTimeoutMs =
      options?.connectionTimeoutMs ?? POLYMARKET_WS.CONNECTION_TIMEOUT_MS;

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
      console.log(`[WS-Market] Already ${this.state}, skipping connect`);
      return;
    }

    // Single-flight guard: if we're already in a reconnect loop, skip
    if (this.isReconnecting && this.reconnectTimer) {
      console.log("[WS-Market] Reconnect already scheduled, skipping");
      return;
    }

    this.state = this.reconnectAttempt > 0 ? "RECONNECTING" : "CONNECTING";
    console.log(
      `[WS-Market] ${this.state} to ${this.url} (attempt ${this.reconnectAttempt + 1})...`,
    );

    try {
      this.ws = new WebSocket(this.url);
      this.setupEventHandlers();
      this.startConnectionTimeout();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[WS-Market] Connection failed: ${error.message}`);
      this.onErrorCb?.(error);
      this.scheduleReconnect();
    }
  }

  /**
   * Disconnect from WebSocket - performs clean shutdown
   */
  disconnect(): void {
    console.log("[WS-Market] Disconnecting...");
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
   * Get client metrics including disconnect tracking (Part D: WS 1006 Monitoring)
   */
  getMetrics(): {
    state: WsConnectionState;
    subscriptions: number;
    messagesReceived: number;
    lastMessageAgeMs: number;
    lastPongAgeMs: number;
    reconnectAttempts: number;
    uptimeMs: number;
    // Disconnect tracking
    disconnectCount: number;
    lastDisconnectCode: number | null;
    lastDisconnectAgeMs: number;
    lastDisconnectVpnActive: boolean | null;
    lastDisconnectVpnType: string | null;
  } {
    return {
      state: this.state,
      subscriptions: this.subscriptions.size,
      messagesReceived: this.messagesReceived,
      lastMessageAgeMs:
        this.lastMessageAt > 0 ? Date.now() - this.lastMessageAt : 0,
      lastPongAgeMs: this.lastPongAt > 0 ? Date.now() - this.lastPongAt : 0,
      reconnectAttempts: this.reconnectAttempt,
      uptimeMs: this.connectTime > 0 ? Date.now() - this.connectTime : 0,
      // Disconnect tracking
      disconnectCount: this.disconnectCount,
      lastDisconnectCode: this.lastDisconnectCode,
      lastDisconnectAgeMs:
        this.lastDisconnectTime > 0 ? Date.now() - this.lastDisconnectTime : 0,
      lastDisconnectVpnActive: this.lastDisconnectVpnActive,
      lastDisconnectVpnType: this.lastDisconnectVpnType,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private - Event Handlers
  // ═══════════════════════════════════════════════════════════════════════════

  private setupEventHandlers(): void {
    if (!this.ws) return;

    this.ws.on("open", () => {
      this.clearConnectionTimeout();
      this.isReconnecting = false;
      this.state = "CONNECTED";
      this.connectTime = Date.now();

      console.log(`[WS-Market] Connected to ${this.url}`);

      // Update store state
      getMarketDataStore().setWsConnected(true);

      // Start keepalive ping
      this.startPing();

      // Start stable connection timer to reset backoff
      this.startStableConnectionTimer();

      // Send pending subscriptions (use initial format for first subscribe after connect)
      if (this.pendingSubscriptions.size > 0) {
        this.sendSubscribe(Array.from(this.pendingSubscriptions), true);
        this.pendingSubscriptions.clear();
      } else if (this.subscriptions.size > 0) {
        // Re-subscribe to all on reconnect (use initial format)
        this.sendSubscribe(Array.from(this.subscriptions), true);
      }

      this.onConnectCb?.();
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      this.lastMessageAt = Date.now();
      this.messagesReceived++;

      try {
        const msgStr = data.toString();
        // Handle PONG response to our PING keepalive
        if (msgStr === "PONG") {
          this.lastPongAt = Date.now();
          this.clearPongTimeout();
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
      const lastMsgAge =
        this.lastMessageAt > 0 ? Date.now() - this.lastMessageAt : -1;
      const lastPongAge =
        this.lastPongAt > 0 ? Date.now() - this.lastPongAt : -1;

      // Track disconnect metrics (Part D: WS 1006 Monitoring)
      this.disconnectCount++;
      this.lastDisconnectCode = code;
      this.lastDisconnectTime = Date.now();
      this.lastDisconnectVpnActive = isVpnActive();
      this.lastDisconnectVpnType = getVpnType();

      // Emit structured disconnect event for diagnostics
      const disconnectEvent = {
        event: "WS_MARKET_DISCONNECT",
        timestamp: new Date().toISOString(),
        code,
        reason: reasonStr,
        lastMessageAgeMs: lastMsgAge,
        lastPongAgeMs: lastPongAge,
        disconnectCount: this.disconnectCount,
        vpnActive: this.lastDisconnectVpnActive,
        vpnType: this.lastDisconnectVpnType,
      };
      console.log(JSON.stringify(disconnectEvent));

      console.log(
        `[WS-Market] Connection closed: code=${code}, reason="${reasonStr}", lastMessageAgeMs=${lastMsgAge}, lastPongAgeMs=${lastPongAge}, disconnectCount=${this.disconnectCount}`,
      );

      this.ws = null;
      this.clearPing();
      this.clearPongTimeout();
      this.clearStableConnectionTimer();

      // Update store state
      getMarketDataStore().setWsConnected(false);

      this.onDisconnectCb?.(code, reasonStr);

      // Don't reconnect if closed intentionally (code 1000)
      if (code !== 1000) {
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
          `[WS-Market] WebSocket error connecting to ${this.url}: ${errorInfo}`,
        );
        this.onErrorCb?.(err);
      },
    );
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
      console.log(
        `[WS-Market] Subscribed to ${message.assets_ids?.length || 0} assets`,
      );
    } else if (message.type === "unsubscribed") {
      console.log(
        `[WS-Market] Unsubscribed from ${message.assets_ids?.length || 0} assets`,
      );
    } else if (message.type === "error") {
      console.error(
        `[WS-Market] Server error: ${message.message || JSON.stringify(message)}`,
      );
    }

    this.onMessageCb?.(
      message.type || message.event_type || "unknown",
      message,
    );
  }

  private processMarketUpdate(update: MarketChannelMessage): void {
    const tokenId = update.asset_id;
    if (!tokenId) return;

    const store = getMarketDataStore();

    if (update.event_type === "book") {
      // Full orderbook snapshot
      // IMPORTANT: WS L2 returns bids ascending (worst first), asks ascending (best first)
      // We normalize to: bids descending (best first), asks ascending (best first)
      const rawBids = this.parseOrderbookLevels(update.bids);
      const rawAsks = this.parseOrderbookLevels(update.asks);

      // Normalize: sort bids descending, asks ascending so [0] is always best price
      const bids = sortBidsDescending(rawBids);
      const asks = sortAsksAscending(rawAsks);

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
        // Normal incremental update: both sides have liquidity
        store.updateFromWs(tokenId, bids, asks);
      } else {
        // Orderbook became empty or invalid after applying deltas.
        // Log and drop local state so that a fresh snapshot is required.
        console.warn(
          `[WS-Market] Orderbook for ${tokenId.slice(0, 12)}... became empty after price_change; clearing local state to force resnapshot`,
        );
        this.orderbooks.delete(tokenId);
      }
    }
    // Ignore other event types (last_trade_price, tick_size_change) for now
  }

  private parseOrderbookLevels(
    levels?: Array<{ price: string; size: string }>,
  ): OrderbookLevel[] {
    if (!levels || !Array.isArray(levels)) return [];

    return levels
      .map((l) => ({
        price: parseFloat(l.price),
        size: parseFloat(l.size),
      }))
      .filter((l) => !isNaN(l.price) && !isNaN(l.size) && l.size > 0);
  }

  private mapToSortedLevels(
    map: Map<string, number>,
    descending: boolean,
  ): OrderbookLevel[] {
    const levels: OrderbookLevel[] = [];

    for (const [priceStr, size] of map.entries()) {
      if (size > 0) {
        levels.push({ price: parseFloat(priceStr), size });
      }
    }

    // Sort: bids descending (best first), asks ascending (best first)
    levels.sort((a, b) => (descending ? b.price - a.price : a.price - b.price));

    return levels;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private - Message Sending
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Send initial subscribe or additional subscription.
   * Per Polymarket Python quickstart (https://docs.polymarket.com/quickstart/websocket/WSS-Quickstart):
   *
   * - Initial (on_open): {"type": "market", "assets_ids": [...]}
   * - Additional (subscribe_to_tokens_ids): {"operation": "subscribe", "assets_ids": [...]}
   *
   * The API supports both formats - initial uses "type" field, subsequent uses "operation" field.
   */
  private sendSubscribe(tokenIds: string[], isInitial = false): void {
    if (!this.ws || this.state !== "CONNECTED") return;

    // Use initial format on first connect (type: "market"), operation format for additions
    const message: SubscribeMessage | SubscriptionOperationMessage = isInitial
      ? { type: "market", assets_ids: tokenIds }
      : { operation: "subscribe", assets_ids: tokenIds };

    try {
      this.ws.send(JSON.stringify(message));
      console.log(`[WS-Market] Subscribing to ${tokenIds.length} tokens`);
    } catch (err) {
      console.error(`[WS-Market] Failed to send subscribe: ${err}`);
    }
  }

  private sendUnsubscribe(tokenIds: string[]): void {
    if (!this.ws || this.state !== "CONNECTED") return;

    const message: SubscriptionOperationMessage = {
      operation: "unsubscribe",
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

  /**
   * Start sending "PING" text messages at interval for keepalive.
   * The server should respond with "PONG".
   * If no PONG is received within pongTimeoutMs, the socket is considered dead.
   */
  private startPing(): void {
    this.clearPing();
    this.lastPongAt = Date.now(); // Initialize to avoid immediate timeout
    this.pingTimer = setInterval(() => {
      if (this.ws && this.state === "CONNECTED") {
        try {
          this.ws.send("PING");
          // Only start pong timeout if one isn't already running
          // This prevents resetting the timeout on every ping
          if (!this.pongTimeoutTimer) {
            this.startPongTimeout();
          }
        } catch {
          // Send failed, connection likely dead
          console.warn("[WS-Market] Ping send failed, scheduling reconnect");
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
    this.clearPongTimeout();
  }

  /**
   * Start a timeout that fires if PONG is not received in time.
   * This detects "silent" dead sockets where TCP connection hangs.
   */
  private startPongTimeout(): void {
    this.clearPongTimeout();
    this.pongTimeoutTimer = setTimeout(() => {
      if (this.state === "CONNECTED") {
        const lastMsgAge =
          this.lastMessageAt > 0 ? Date.now() - this.lastMessageAt : -1;
        console.warn(
          `[WS-Market] No PONG received within ${this.pongTimeoutMs}ms, socket appears dead (lastMessageAgeMs=${lastMsgAge}), scheduling reconnect`,
        );
        // Force close the socket to trigger reconnect
        if (this.ws) {
          try {
            this.ws.terminate();
          } catch {
            // Ignore terminate errors
          }
        }
        this.scheduleReconnect();
      }
    }, this.pongTimeoutMs);
  }

  private clearPongTimeout(): void {
    if (this.pongTimeoutTimer) {
      clearTimeout(this.pongTimeoutTimer);
      this.pongTimeoutTimer = null;
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
        console.log("[WS-Market] Connection stable, resetting backoff counter");
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
      if (this.state === "CONNECTING" || this.state === "RECONNECTING") {
        console.warn("[WS-Market] Connection timeout, scheduling reconnect");
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
    // Single-flight guard: if already reconnecting, don't start another
    if (this.isReconnecting && this.reconnectTimer) {
      console.log(
        "[WS-Market] Reconnect already scheduled, skipping duplicate",
      );
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
      `[WS-Market] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt}, max backoff ${this.reconnectMaxMs}ms)`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
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
export function initWebSocketMarketClient(
  options?: WsClientOptions,
): WebSocketMarketClient {
  if (globalWsClient) {
    globalWsClient.disconnect();
  }
  globalWsClient = new WebSocketMarketClient(options);
  return globalWsClient;
}
