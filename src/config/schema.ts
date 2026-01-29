/**
 * Configuration Schema
 *
 * Type definitions for the application configuration.
 * This provides a single source of truth for all configuration options.
 */

/**
 * Infura tier for rate limiting
 */
export type InfuraTier = "core" | "developer" | "team" | "growth";

/**
 * Liquidation mode for position management
 */
export type LiquidationMode = "off" | "losing" | "all";

/**
 * Log level for output verbosity
 * NOTE: Canonical definition is in infra/logging - this is a re-export alias
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Bias mode for leaderboard flow analysis
 */
export type BiasMode = "leaderboard_flow" | "disabled";

/**
 * Core trading configuration
 */
export interface TradingConfig {
  /** Maximum trade size in USD */
  maxTradeUsd: number;

  /** Minimum trade size in USD */
  minTradeUsd: number;

  /** Fraction of bankroll per trade (0-1) */
  tradeFraction: number;

  /** Maximum fraction deployed across all positions (0-1) */
  maxDeployedFractionTotal: number;

  /** Maximum number of open positions */
  maxOpenPositionsTotal: number;

  /** Maximum positions per market */
  maxOpenPositionsPerMarket: number;

  /** Cooldown between trades on the same token (seconds) */
  cooldownSecondsPerToken: number;
}

/**
 * Entry and exit price bands configuration (in cents)
 * Note: Prices in Polymarket are expressed as decimals 0-1, which map to 0-100 cents.
 * These config values are in cents (1-100) to match the trading math.
 */
export interface PriceBandsConfig {
  /** Minimum price change required to trigger entry (in cents, e.g., 12 = 12¢ movement needed) */
  entryBandCents: number;

  /** Take profit target - close position when gain reaches this (in cents) */
  tpCents: number;

  /** Price at which to trigger hedging (in cents of adverse movement) */
  hedgeTriggerCents: number;

  /** Maximum adverse movement before hard stop (in cents) */
  maxAdverseCents: number;

  /** Maximum hold time (seconds) */
  maxHoldSeconds: number;

  /** Minimum entry price (cents) */
  minEntryPriceCents: number;

  /** Maximum entry price (cents) */
  maxEntryPriceCents: number;

  /** Preferred entry zone low bound (cents) */
  preferredEntryLowCents: number;

  /** Preferred entry zone high bound (cents) */
  preferredEntryHighCents: number;

  /** Safety buffer for entries (cents) */
  entryBufferCents: number;
}

/**
 * Hedge behavior configuration
 */
export interface HedgeConfig {
  /** Initial hedge ratio (0-1) */
  hedgeRatio: number;

  /** Maximum hedge ratio (0-1) */
  maxHedgeRatio: number;
}

/**
 * Liquidity gate configuration
 */
export interface LiquidityConfig {
  /** Maximum acceptable spread (cents) */
  minSpreadCents: number;

  /** Minimum liquidity depth at exit price (USD) */
  minDepthUsdAtExit: number;

  /** Minimum trades in activity window */
  minTradesLastX: number;

  /** Minimum book updates in activity window */
  minBookUpdatesLastX: number;

  /** Activity window duration (seconds) */
  activityWindowSeconds: number;
}

/**
 * Expected value (EV) controls configuration
 */
export interface EvConfig {
  /** Rolling window size for statistics */
  rollingWindowTrades: number;

  /** Estimated churn cost (cents) */
  churnCostCentsEstimate: number;

  /** Minimum EV to continue trading (cents) */
  minEvCents: number;

  /** Minimum profit factor (avg_win / avg_loss) */
  minProfitFactor: number;

  /** Pause duration when EV is negative (seconds) */
  pauseSeconds: number;

  /** Cooldown for transient errors (seconds) */
  entryCooldownSecondsTransient: number;
}

/**
 * Bias/leaderboard flow configuration
 */
export interface BiasConfig {
  /** Bias detection mode */
  biasMode: BiasMode | string;

  /** Number of top wallets to track */
  leaderboardTopN: number;

  /** Window for bias calculation (seconds) */
  biasWindowSeconds: number;

  /** Minimum net USD flow for bias */
  biasMinNetUsd: number;

  /** Minimum trades for bias confirmation */
  biasMinTrades: number;

  /** Time until bias becomes stale (seconds) */
  biasStaleSeconds: number;

  /** Require bias for entries */
  allowEntriesOnlyWithBias: boolean;

  /** Action on bias flip */
  onBiasFlip: string;

  /** Action when no bias */
  onBiasNone: string;
}

/**
 * Wallet and reserve management configuration
 */
export interface ReserveConfig {
  /** Fraction of balance to reserve (0-1) */
  reserveFraction: number;

  /** Minimum reserve amount (USD) */
  minReserveUsd: number;

  /** Only use available (unreserved) balance */
  useAvailableBalanceOnly: boolean;

  /** Enable dynamic reserve calculation */
  dynamicReservesEnabled: boolean;

  /** Rate of reserve adaptation (0-1) */
  reserveAdaptationRate: number;

  /** Weight for missed opportunities in reserve calc */
  missedOpportunityWeight: number;

  /** Weight for hedge coverage in reserve calc */
  hedgeCoverageWeight: number;

  /** Maximum reserve fraction (0-1) */
  maxReserveFraction: number;
}

/**
 * POL (gas token) reserve configuration
 */
export interface PolReserveConfig {
  /** Enable automatic POL top-up */
  polReserveEnabled: boolean;

  /** Target POL balance when refilling */
  polReserveTarget: number;

  /** Minimum POL balance before refilling */
  polReserveMin: number;

  /** Maximum USDC to swap per refill */
  polReserveMaxSwapUsd: number;

  /** Check interval (minutes) */
  polReserveCheckIntervalMin: number;

  /** Slippage tolerance for swap (%) */
  polReserveSlippagePct: number;
}

/**
 * Liquidation mode configuration
 */
export interface LiquidationConfig {
  /** Liquidation mode */
  liquidationMode: LiquidationMode;

  /** Maximum slippage for liquidation sells (%) */
  liquidationMaxSlippagePct: number;

  /** Poll interval in liquidation mode (ms) */
  liquidationPollIntervalMs: number;
}

/**
 * Market scanner configuration
 */
export interface ScannerConfig {
  /** Enable active market scanning */
  scanActiveMarkets: boolean;

  /** Minimum 24h volume to consider (USD) */
  scanMinVolumeUsd: number;

  /** Number of top markets to scan */
  scanTopNMarkets: number;

  /** Scan refresh interval (seconds) */
  scanIntervalSeconds: number;
}

/**
 * On-chain monitoring configuration
 */
export interface OnChainConfig {
  /** Enable on-chain monitoring */
  onchainMonitorEnabled: boolean;

  /** Minimum whale trade size (USD) */
  onchainMinWhaleTradeUsd: number;

  /** Infura tier for rate limiting */
  infuraTier: InfuraTier;
}

/**
 * Whale filtering configuration
 */
export interface WhaleFilterConfig {
  /** Minimum price for whale trades (0-1) */
  whalePriceMin?: number;

  /** Maximum price for whale trades (0-1) */
  whalePriceMax?: number;

  /** Copy any whale buy without bias confirmation */
  copyAnyWhaleBuy: boolean;
}

/**
 * Authentication configuration
 */
export interface AuthConfig {
  /** Wallet private key */
  privateKey: string;

  /** RPC URL for blockchain access */
  rpcUrl: string;

  /** Whether live trading is enabled */
  liveTradingEnabled: boolean;
}

/**
 * Telegram notification configuration
 */
export interface TelegramConfig {
  /** Telegram bot token */
  telegramBotToken?: string;

  /** Telegram chat ID */
  telegramChatId?: string;
}

/**
 * Polling and operation configuration
 */
export interface PollingConfig {
  /** Main poll interval (ms) */
  pollIntervalMs: number;

  /** Position poll interval (ms) */
  positionPollIntervalMs: number;

  /** Balance cache refresh interval (ms) - throttles RPC calls for wallet balance checks */
  balanceRefreshIntervalMs: number;

  /** Log level */
  logLevel: LogLevel | string;
}

/**
 * Complete application configuration
 */
export interface AppConfig
  extends
    TradingConfig,
    PriceBandsConfig,
    HedgeConfig,
    LiquidityConfig,
    EvConfig,
    BiasConfig,
    ReserveConfig,
    PolReserveConfig,
    LiquidationConfig,
    ScannerConfig,
    OnChainConfig,
    WhaleFilterConfig,
    AuthConfig,
    TelegramConfig,
    PollingConfig {}

/**
 * Validation error for configuration
 */
export interface ConfigValidationError {
  /** Field name that failed validation */
  field: string;

  /** Error message */
  message: string;
}
