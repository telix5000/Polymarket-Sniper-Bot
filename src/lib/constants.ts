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
  GLOBAL_MIN_BUY_PRICE: 0.10,
  DEFAULT_SLIPPAGE_PCT: 3,
  COOLDOWN_MS: 1000,
  MARKET_COOLDOWN_MS: 5000,
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

  // Default order type for sells: "FOK" (Fill-Or-Kill) or "GTC" (Good-Til-Cancelled)
  // FOK = aggressive, instant fill or nothing
  // GTC = patient, waits on orderbook for better price
  DEFAULT_ORDER_TYPE: envStr<"FOK" | "GTC">("SELL_ORDER_TYPE", "FOK", [
    "FOK",
    "GTC",
  ]),

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
