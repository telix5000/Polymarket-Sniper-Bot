/**
 * V2 Constants
 * Self-contained constants for the V2 trading bot
 */

// Polymarket API endpoints
export const POLYMARKET_API = {
  DATA_API: "https://data-api.polymarket.com",
  CLOB_API: "https://clob.polymarket.com",
  GAMMA_API: "https://gamma-api.polymarket.com",
} as const;

// Polygon network constants
export const POLYGON = {
  CHAIN_ID: 137,
  USDC_ADDRESS: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  USDC_DECIMALS: 6,
  CTF_ADDRESS: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
  CTF_EXCHANGE: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
} as const;

// Order execution settings
export const ORDER_SETTINGS = {
  MAX_RETRIES: 3,
  MIN_REMAINING_USD: 0.01,
  DEFAULT_SLIPPAGE_PCT: 3,
  MIN_TRADEABLE_PRICE: 0.001, // 0.1 cents - absolute floor
  GLOBAL_MIN_BUY_PRICE: 0.10, // 10 cents - avoid loser positions
} as const;

// Timing constants
export const TIMING = {
  DEFAULT_CYCLE_MS: 5000,
  POSITION_CACHE_TTL_MS: 30000,
  ORDER_COOLDOWN_MS: 1000,
  TELEGRAM_SUMMARY_INTERVAL_MS: 300000, // 5 minutes
} as const;
