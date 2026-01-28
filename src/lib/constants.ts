/**
 * V2 Constants - All configuration constants
 */

// Helper to read numeric env vars
const envNum = (key: string, defaultValue: number): number => {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  const parsed = parseFloat(value);
  return isNaN(parsed) ? defaultValue : parsed;
};

// Helper to read string env vars with optional validation
const envStr = <T extends string>(
  key: string,
  defaultValue: T,
  validValues?: T[],
): T => {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  if (validValues && !validValues.includes(value as T)) {
    console.warn(
      `Invalid value for ${key}: ${value}. Using default: ${defaultValue}`,
    );
    return defaultValue;
  }
  return value as T;
};

// API Endpoints
export const POLYMARKET_API = {
  CLOB: "https://clob.polymarket.com",
  DATA: "https://data-api.polymarket.com",
  GAMMA: "https://gamma-api.polymarket.com",
  STRAPI: "https://strapi-matic.poly.market",
} as const;

// WebSocket Endpoints and Configuration
export const POLYMARKET_WS = {
  // WebSocket host (without path) - configurable via env var
  // Per Polymarket docs: https://docs.polymarket.com/quickstart/websocket/WSS-Quickstart
  // The URL is constructed as: BASE_HOST + "/ws/" + channel_type (market or user)
  HOST: envStr("POLY_WS_HOST", "wss://ws-subscriptions-clob.polymarket.com"),

  // @deprecated Use getMarketWsUrl() or getUserWsUrl() instead
  // Kept for backward compatibility - this URL alone returns 404
  BASE_URL: envStr(
    "POLY_WS_BASE_URL",
    "wss://ws-subscriptions-clob.polymarket.com/ws/",
  ),

  // Reconnection settings (exponential backoff with jitter)
  RECONNECT_BASE_MS: envNum("WS_RECONNECT_BASE_MS", 1000),
  RECONNECT_MAX_MS: envNum("WS_RECONNECT_MAX_MS", 30000),

  // Time in ms a connection must be stable before resetting backoff
  STABLE_CONNECTION_MS: envNum("WS_STABLE_CONNECTION_MS", 15000),

  // Staleness threshold - data older than this triggers REST fallback
  STALE_MS: envNum("WS_STALE_MS", 2000),

  // REST fallback rate limiting
  REST_FALLBACK_MIN_INTERVAL_MS: envNum("REST_FALLBACK_MIN_INTERVAL_MS", 500),

  // Memory protection - cap tracked tokens
  MAX_TOKENS: envNum("MARKETDATA_MAX_TOKENS", 500),

  // Depth window for shallow depth calculation (cents from touch)
  DEPTH_WINDOW_CENTS: envNum("MARKETDATA_DEPTH_WINDOW_CENTS", 5),

  // Keepalive ping interval (send "PING" text message)
  PING_INTERVAL_MS: envNum("WS_PING_INTERVAL_MS", 25000),

  // Pong timeout - how long to wait for PONG response before assuming dead socket
  PONG_TIMEOUT_MS: envNum("WS_PONG_TIMEOUT_MS", 10000),

  // Connection timeout
  CONNECTION_TIMEOUT_MS: envNum("WS_CONNECTION_TIMEOUT_MS", 10000),
} as const;

/**
 * Get the WebSocket URL for the Market channel (public orderbook data).
 * Per Polymarket docs: wss://ws-subscriptions-clob.polymarket.com/ws/market
 */
export function getMarketWsUrl(): string {
  return `${POLYMARKET_WS.HOST}/ws/market`;
}

/**
 * Get the WebSocket URL for the User channel (authenticated order/trade events).
 * Per Polymarket docs: wss://ws-subscriptions-clob.polymarket.com/ws/user
 */
export function getUserWsUrl(): string {
  return `${POLYMARKET_WS.HOST}/ws/user`;
}

// Polygon Network
export const POLYGON = {
  CHAIN_ID: 137,
  USDC_ADDRESS: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  USDC_DECIMALS: 6,
  CTF_ADDRESS: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
  CTF_EXCHANGE: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
  NEG_RISK_CTF_EXCHANGE: "0xC5d563A36AE78145C45a50134d48A1215220f80a",
  NEG_RISK_ADAPTER: "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296",
} as const;

// Order Settings
export const ORDER = {
  MAX_RETRIES: 3,
  MIN_ORDER_USD: 0.01,
  MIN_TRADEABLE_PRICE: 0.001,
  MIN_SHARES_THRESHOLD: 0.0001,
  GLOBAL_MIN_BUY_PRICE: 0.1,
  DEFAULT_SLIPPAGE_PCT: 3,
  COOLDOWN_MS: 1000,
  MARKET_COOLDOWN_MS: 5000,
} as const;

/**
 * Order Type Settings - Controls FOK vs GTC for all orders
 *
 * ORDER TYPE DIFFERENCES:
 *
 * FOK (Fill-Or-Kill) - DEFAULT:
 *   - Order fills IMMEDIATELY and COMPLETELY, or is cancelled
 *   - Best for: Fast-moving markets, whale copy trades
 *   - Risk: May miss opportunities if price moves
 *   - DOES NOT sit on orderbook - instant execution only
 *
 * GTC (Good-Til-Cancelled) - LIMIT ORDER:
 *   - Order posts to orderbook and WAITS until filled
 *   - Best for: Getting specific price, capturing price deviance
 *   - Risk: May never fill if price moves away
 *   - SITS on orderbook until filled, cancelled, or expired
 *
 * CRITICAL: FOK orders do NOT "sit there until filled" - they either
 * fill instantly or fail. Use GTC if you want a limit order that waits!
 *
 * CONFIGURATION PRIORITY:
 *   1. BUY_ORDER_TYPE / SELL_ORDER_TYPE (specific override)
 *   2. ORDER_TYPE (master setting for both)
 *   3. Default: FOK
 */

// Master order type setting - applies to BOTH buys and sells
const MASTER_ORDER_TYPE = envStr<"FOK" | "GTC" | "">("ORDER_TYPE", "", [
  "FOK",
  "GTC",
  "",
]);

/**
 * Get order type with fallback logic:
 * specific env > master ORDER_TYPE > default
 */
function getOrderType(
  specificEnv: string,
  defaultValue: "FOK" | "GTC",
): "FOK" | "GTC" {
  const specific = process.env[specificEnv];
  if (specific === "FOK" || specific === "GTC") {
    return specific;
  }
  if (MASTER_ORDER_TYPE === "FOK" || MASTER_ORDER_TYPE === "GTC") {
    return MASTER_ORDER_TYPE;
  }
  return defaultValue;
}

/**
 * Buy Order Settings
 */
export const BUY = {
  // Order type for buys: "FOK" (Fill-Or-Kill) or "GTC" (Good-Til-Cancelled)
  // Priority: BUY_ORDER_TYPE > ORDER_TYPE > FOK (default)
  DEFAULT_ORDER_TYPE: getOrderType("BUY_ORDER_TYPE", "FOK"),

  // For GTC orders, default expiration in seconds (1 hour default)
  // Shorter than SELL because market conditions change faster for entries
  GTC_EXPIRATION_SECONDS: envNum("BUY_GTC_EXPIRATION_SECONDS", 3600),

  // Default slippage tolerance for BUY orders (percentage, e.g., 2 = 2%)
  // Only used with FOK orders - GTC orders use exact price
  DEFAULT_SLIPPAGE_PCT: envNum("BUY_DEFAULT_SLIPPAGE_PCT", 2),

  // Maximum slippage allowed even for urgent buys (e.g., 5 = 5%)
  MAX_SLIPPAGE_PCT: envNum("BUY_MAX_SLIPPAGE_PCT", 5),
} as const;

/**
 * Sell Order Settings - Best practices from Polymarket docs and community
 *
 * These protect against losing money to bad bids by:
 * 1. Analyzing orderbook depth before selling
 * 2. Calculating expected fill price across levels
 * 3. Enforcing slippage limits
 * 4. Choosing appropriate order types (FOK vs GTC)
 *
 * All values can be overridden via environment variables.
 */
export const SELL = {
  // Default slippage tolerance as percentage (e.g., 2 = 2%)
  // Lower values = stricter protection but may fail to fill
  DEFAULT_SLIPPAGE_PCT: envNum("SELL_DEFAULT_SLIPPAGE_PCT", 2),

  // Maximum slippage allowed even for urgent sells (e.g., 5 = 5%)
  MAX_SLIPPAGE_PCT: envNum("SELL_MAX_SLIPPAGE_PCT", 5),

  // Minimum slippage for very liquid markets (e.g., 0.5 = 0.5%)
  MIN_SLIPPAGE_PCT: envNum("SELL_MIN_SLIPPAGE_PCT", 0.5),

  // Minimum liquidity (in USD) required at best bid before selling
  // Prevents selling into thin orderbooks
  MIN_LIQUIDITY_USD: envNum("SELL_MIN_LIQUIDITY_USD", 10),

  // When checking orderbook depth, how many levels to analyze
  DEPTH_LEVELS_TO_CHECK: envNum("SELL_DEPTH_LEVELS", 5),

  // Minimum fill ratio required for FOK orders (e.g., 0.8 = 80%)
  // If we can't fill at least this much at acceptable price, don't execute
  MIN_FILL_RATIO: envNum("SELL_MIN_FILL_RATIO", 0.8),

  // Order type for sells: "FOK" (Fill-Or-Kill) or "GTC" (Good-Til-Cancelled)
  // Priority: SELL_ORDER_TYPE > ORDER_TYPE > FOK (default)
  DEFAULT_ORDER_TYPE: getOrderType("SELL_ORDER_TYPE", "FOK"),

  // For GTC orders, default expiration in seconds (24 hours)
  GTC_EXPIRATION_SECONDS: envNum("SELL_GTC_EXPIRATION_SECONDS", 86400),

  // When price is near $1 (high win probability), use more aggressive slippage
  HIGH_PRICE_THRESHOLD: envNum("SELL_HIGH_PRICE_THRESHOLD", 0.95),
  HIGH_PRICE_SLIPPAGE_PCT: envNum("SELL_HIGH_PRICE_SLIPPAGE_PCT", 0.5),

  // When position is in significant loss, allow more slippage to exit
  // (stop-loss scenarios where getting out is priority)
  LOSS_THRESHOLD_PCT: envNum("SELL_LOSS_THRESHOLD_PCT", 20),
  LOSS_SLIPPAGE_PCT: envNum("SELL_LOSS_SLIPPAGE_PCT", 5),
} as const;

// Timing
export const TIMING = {
  CYCLE_MS: 5000,
  POSITION_CACHE_MS: 30000,
  SUMMARY_INTERVAL_MS: 300000,
  REDEEM_INTERVAL_MS: 600000,
} as const;

// ERC20 ABI (minimal)
export const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
] as const;

// CTF ABI (minimal for redemption)
export const CTF_ABI = [
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])",
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
  "function payoutDenominator(bytes32 conditionId) view returns (uint256)",
  "function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)",
] as const;

// Proxy Wallet ABI (minimal for redemption via proxy)
export const PROXY_ABI = [
  "function proxy(address dest, bytes calldata data) external returns (bytes memory)",
] as const;
