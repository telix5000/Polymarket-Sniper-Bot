/**
 * Services Index
 *
 * Central export point for all service modules.
 * Services encapsulate external API interactions and provide clean interfaces.
 *
 * Available services:
 * - polymarket: Polymarket REST and WebSocket clients
 * - interfaces: Service interface definitions for dependency injection
 */

// Polymarket services
export * from "./polymarket";

// Service interfaces for dependency injection and testing
export {
  type OrderParams,
  type OrderResult,
  type IOrderService,
  type OrderbookSnapshot,
  type MarketActivityData,
  type IMarketDataService,
  type ExchangePosition,
  type IPositionService,
  type NotificationType,
  type NotificationMessage,
  type INotificationService,
  type WalletBalanceInfo,
  type IWalletService,
  type ITradingServices,
  type ServiceFactory,
  createMockServices,
} from "./interfaces";
