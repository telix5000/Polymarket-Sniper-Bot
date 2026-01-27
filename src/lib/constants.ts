/**
 * V2 Constants - All configuration constants
 */

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
