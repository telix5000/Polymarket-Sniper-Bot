/**
 * Service Interfaces
 *
 * Defines interfaces for external services and side effects.
 * This allows the core trading logic to remain pure and testable
 * while the implementation details of service interaction are encapsulated.
 *
 * Key services:
 * - OrderService: Places and manages orders
 * - MarketDataService: Provides real-time market data
 * - PositionService: Tracks and manages positions
 * - NotificationService: Sends alerts and notifications
 */

// ═══════════════════════════════════════════════════════════════════════════
// Order Service
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Order placement parameters
 */
export interface OrderParams {
  tokenId: string;
  side: "BUY" | "SELL";
  sizeUsd: number;
  priceCents: number;
  /** Optional maximum slippage in cents */
  maxSlippageCents?: number;
}

/**
 * Order execution result
 */
export interface OrderResult {
  success: boolean;
  orderId?: string;
  filledUsd?: number;
  filledPriceCents?: number;
  reason?: string;
  /** True if order is GTC and waiting for fill */
  pending?: boolean;
}

/**
 * Interface for order execution service
 */
export interface IOrderService {
  /**
   * Place an order
   */
  placeOrder(params: OrderParams): Promise<OrderResult>;

  /**
   * Cancel an order by ID
   */
  cancelOrder(orderId: string): Promise<boolean>;

  /**
   * Get order status
   */
  getOrderStatus(orderId: string): Promise<OrderResult | null>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Market Data Service
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Orderbook snapshot
 */
export interface OrderbookSnapshot {
  tokenId: string;
  bestBidCents: number;
  bestAskCents: number;
  bidDepthUsd: number;
  askDepthUsd: number;
  spreadCents: number;
  midPriceCents: number;
  timestamp: number;
  source: "WS" | "REST" | "STALE_CACHE";
}

/**
 * Market activity data
 */
export interface MarketActivityData {
  tokenId: string;
  tradesInWindow: number;
  bookUpdatesInWindow: number;
  lastTradeTime: number;
  lastUpdateTime: number;
}

/**
 * Interface for market data service
 */
export interface IMarketDataService {
  /**
   * Get current orderbook for a token
   */
  getOrderbook(tokenId: string): Promise<OrderbookSnapshot | null>;

  /**
   * Get market activity metrics
   */
  getActivity(tokenId: string): Promise<MarketActivityData | null>;

  /**
   * Subscribe to orderbook updates
   */
  subscribeOrderbook(
    tokenId: string,
    callback: (orderbook: OrderbookSnapshot) => void,
  ): () => void;

  /**
   * Check if connected and receiving data
   */
  isConnected(): boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Position Service
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Position data from the exchange
 */
export interface ExchangePosition {
  tokenId: string;
  conditionId: string;
  side: "YES" | "NO";
  size: number;
  avgCost: number;
  currentPrice: number;
  unrealizedPnl: number;
}

/**
 * Interface for position management service
 */
export interface IPositionService {
  /**
   * Get all current positions
   */
  getPositions(): Promise<ExchangePosition[]>;

  /**
   * Get position for a specific token
   */
  getPosition(tokenId: string): Promise<ExchangePosition | null>;

  /**
   * Refresh position data
   */
  refresh(): Promise<void>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Notification Service
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Notification message types
 */
export type NotificationType =
  | "TRADE_ENTRY"
  | "TRADE_EXIT"
  | "HEDGE"
  | "ERROR"
  | "WARNING"
  | "INFO";

/**
 * Notification message
 */
export interface NotificationMessage {
  type: NotificationType;
  title: string;
  body: string;
  /** Optional data payload */
  data?: Record<string, unknown>;
}

/**
 * Interface for notification service
 */
export interface INotificationService {
  /**
   * Send a notification
   */
  send(message: NotificationMessage): Promise<boolean>;

  /**
   * Check if notifications are enabled
   */
  isEnabled(): boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Wallet Service
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Wallet balance information
 */
export interface WalletBalanceInfo {
  usdcBalance: number;
  polBalance: number;
  address: string;
  timestamp: number;
}

/**
 * Interface for wallet service
 */
export interface IWalletService {
  /**
   * Get current wallet balances
   */
  getBalance(): Promise<WalletBalanceInfo>;

  /**
   * Get wallet address
   */
  getAddress(): string;

  /**
   * Check if wallet is connected and authenticated
   */
  isConnected(): boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Combined Service Container
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Container for all trading services
 *
 * This allows the core trading engine to receive all dependencies
 * through a single interface, making testing and dependency injection easier.
 */
export interface ITradingServices {
  order: IOrderService;
  marketData: IMarketDataService;
  position: IPositionService;
  notification: INotificationService;
  wallet: IWalletService;
}

/**
 * Factory function type for creating services
 */
export type ServiceFactory<T> = () => T;

/**
 * Creates a mock service container for testing
 */
export function createMockServices(
  overrides: Partial<ITradingServices> = {},
): ITradingServices {
  const mockOrder: IOrderService = {
    placeOrder: async () => ({ success: false, reason: "Mock service" }),
    cancelOrder: async () => false,
    getOrderStatus: async () => null,
  };

  const mockMarketData: IMarketDataService = {
    getOrderbook: async () => null,
    getActivity: async () => null,
    subscribeOrderbook: () => () => {},
    isConnected: () => false,
  };

  const mockPosition: IPositionService = {
    getPositions: async () => [],
    getPosition: async () => null,
    refresh: async () => {},
  };

  const mockNotification: INotificationService = {
    send: async () => false,
    isEnabled: () => false,
  };

  const mockWallet: IWalletService = {
    getBalance: async () => ({
      usdcBalance: 0,
      polBalance: 0,
      address: "0x0000000000000000000000000000000000000000",
      timestamp: Date.now(),
    }),
    getAddress: () => "0x0000000000000000000000000000000000000000",
    isConnected: () => false,
  };

  return {
    order: overrides.order || mockOrder,
    marketData: overrides.marketData || mockMarketData,
    position: overrides.position || mockPosition,
    notification: overrides.notification || mockNotification,
    wallet: overrides.wallet || mockWallet,
  };
}
