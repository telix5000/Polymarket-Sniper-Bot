/**
 * Churn Engine - Configuration Module
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POLYMARKET CASINO BOT - Configuration
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * REQUIRED ENV (you must set these):
 *   PRIVATE_KEY                    - Your wallet private key
 *   RPC_URL                        - Polygon RPC endpoint
 *   LIVE_TRADING=I_UNDERSTAND_THE_RISKS  - Safety flag for real trades
 *
 * RECOMMENDED ENV (alerts & monitoring):
 *   TELEGRAM_BOT_TOKEN             - Telegram bot token for alerts
 *   TELEGRAM_CHAT_ID               - Telegram chat ID for alerts
 *   GITHUB_ERROR_REPORTER_TOKEN    - GitHub token for auto-creating issues
 *
 * OPTIONAL ENV (VPN for geo-blocking):
 *   WG_CONFIG or WIREGUARD_CONFIG  - WireGuard config (base64)
 *   OVPN_CONFIG or OPENVPN_CONFIG  - OpenVPN config (base64)
 *
 * Everything else uses SANE DEFAULTS based on the EV math:
 *   - Break-even win rate ≈ 48%
 *   - Target win rate = 55-60%
 *   - avg_win ≈ 14¢, avg_loss ≈ 9¢ (after hedge), churn ≈ 2¢
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

// Helper to read numeric env vars
const envNum = (key: string, defaultValue: number): number => {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  const parsed = parseFloat(value);
  return isNaN(parsed) ? defaultValue : parsed;
};

// Helper to read boolean env vars
const envBool = (key: string, defaultValue: boolean): boolean => {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === "true";
};

// Helper to read string env vars
const envStr = (key: string, defaultValue: string): string => {
  return process.env[key] ?? defaultValue;
};

/**
 * Churn Engine Configuration
 * All values from ENV with sensible defaults
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PARAMETER GROUPS & RATIONALE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1) EV MODEL: ROLLING_WINDOW=200, CHURN_COST=2¢, MIN_EV=0, PROFIT_FACTOR=1.25
 *    → Break-even at ~48% wins, positive at 50%+
 *
 * 2) BIAS: Top 50 wallets, $300 min flow, 3+ trades, 15min stale
 *    → Dumb by design. Permission, not prediction.
 *
 * 3) ENTRY/EXIT: Band=12¢, TP=14¢, Hedge=16¢, Max=30¢, Hold=1hr
 *    → Produces avg_win≈14¢, avg_loss≈9¢ (after hedge)
 *
 * 4) PRICE BOUNDS: 30-82¢, preferred 35-65¢
 *    → <30¢ = one bad tick kills you
 *    → >82¢ = no upside left
 *    → 35-65¢ = ideal churn zone (room to win, hedge, be wrong)
 *
 * 5) LIQUIDITY: Spread≤6¢, Depth≥$25, 10 trades, 20 book updates
 *    → Keeps churn cost at ~2¢ (not 6¢+ which kills EV)
 *
 * 6) HEDGE: 40% first, 70% max
 *    → Absorbs shock, never flips into hedge-trap
 *
 * 7) RESERVE: 25% untouchable, $100 floor
 *    → Survives variance long enough for math to matter
 *
 * 8) EXPOSURE: 1% per trade, 30% max deployed, 12 positions max
 *    → Caps drawdowns mechanically
 *
 * 9) AUTO-PAUSE: 300s when EV<0 or PF<1.25
 *    → Bot stops itself instead of hoping
 * ═══════════════════════════════════════════════════════════════════════════
 */
export interface ChurnConfig {
  // Capital & Position Sizing
  tradeFraction: number;
  maxTradeUsd: number;
  maxDeployedFractionTotal: number;
  maxOpenPositionsTotal: number;
  maxOpenPositionsPerMarket: number;
  cooldownSecondsPerToken: number;

  // Entry/Exit Bands (cents)
  entryBandCents: number;
  tpCents: number;
  hedgeTriggerCents: number;
  maxAdverseCents: number;
  maxHoldSeconds: number;

  // Hedge Behavior
  hedgeRatio: number;
  maxHedgeRatio: number;

  // Entry Price Bounds (cents)
  minEntryPriceCents: number;
  maxEntryPriceCents: number;
  preferredEntryLowCents: number;
  preferredEntryHighCents: number;
  entryBufferCents: number;

  // Liquidity Gates
  minSpreadCents: number;
  minDepthUsdAtExit: number;
  minTradesLastX: number;
  minBookUpdatesLastX: number;
  activityWindowSeconds: number;

  // EV / Casino Controls
  rollingWindowTrades: number;
  churnCostCentsEstimate: number;
  minEvCents: number;
  minProfitFactor: number;
  pauseSeconds: number;

  // Bias (Leaderboard Flow)
  biasMode: string;
  leaderboardTopN: number;
  biasWindowSeconds: number;
  biasMinNetUsd: number;
  biasMinTrades: number;
  biasStaleSeconds: number;
  allowEntriesOnlyWithBias: boolean;
  onBiasFlip: string;
  onBiasNone: string;

  // Polling / Ops
  pollIntervalMs: number;
  logLevel: string;

  // Wallet / Reserve Management
  reserveFraction: number;
  minReserveUsd: number;
  useAvailableBalanceOnly: boolean;

  // Auth
  privateKey: string;
  rpcUrl: string;
  liveTradingEnabled: boolean;

  // Telegram (optional)
  telegramBotToken?: string;
  telegramChatId?: string;

  // POL Reserve (auto-fill gas)
  polReserveEnabled: boolean;
  polReserveTarget: number;
  polReserveMin: number;
  polReserveMaxSwapUsd: number;
  polReserveCheckIntervalMin: number;
  polReserveSlippagePct: number;
}

/**
 * Load configuration from environment
 */
export function loadConfig(): ChurnConfig {
  return {
    // Capital & Position Sizing
    tradeFraction: envNum("TRADE_FRACTION", 0.01),
    maxTradeUsd: envNum("MAX_TRADE_USD", 25),
    maxDeployedFractionTotal: envNum("MAX_DEPLOYED_FRACTION_TOTAL", 0.3),
    maxOpenPositionsTotal: envNum("MAX_OPEN_POSITIONS_TOTAL", 12),
    maxOpenPositionsPerMarket: envNum("MAX_OPEN_POSITIONS_PER_MARKET", 2),
    cooldownSecondsPerToken: envNum("COOLDOWN_SECONDS_PER_TOKEN", 180),

    // Entry/Exit Bands (cents)
    entryBandCents: envNum("ENTRY_BAND_CENTS", 12),
    tpCents: envNum("TP_CENTS", 14),
    hedgeTriggerCents: envNum("HEDGE_TRIGGER_CENTS", 16),
    maxAdverseCents: envNum("MAX_ADVERSE_CENTS", 30),
    maxHoldSeconds: envNum("MAX_HOLD_SECONDS", 3600),

    // Hedge Behavior
    hedgeRatio: envNum("HEDGE_RATIO", 0.4),
    maxHedgeRatio: envNum("MAX_HEDGE_RATIO", 0.7),

    // Entry Price Bounds (cents)
    minEntryPriceCents: envNum("MIN_ENTRY_PRICE_CENTS", 30),
    maxEntryPriceCents: envNum("MAX_ENTRY_PRICE_CENTS", 82),
    preferredEntryLowCents: envNum("PREFERRED_ENTRY_LOW_CENTS", 35),
    preferredEntryHighCents: envNum("PREFERRED_ENTRY_HIGH_CENTS", 65),
    entryBufferCents: envNum("ENTRY_BUFFER_CENTS", 4),

    // Liquidity Gates
    minSpreadCents: envNum("MIN_SPREAD_CENTS", 6),
    minDepthUsdAtExit: envNum("MIN_DEPTH_USD_AT_EXIT", 25),
    minTradesLastX: envNum("MIN_TRADES_LAST_X", 10),
    minBookUpdatesLastX: envNum("MIN_BOOK_UPDATES_LAST_X", 20),
    activityWindowSeconds: envNum("ACTIVITY_WINDOW_SECONDS", 300),

    // EV / Casino Controls
    rollingWindowTrades: envNum("ROLLING_WINDOW_TRADES", 200),
    churnCostCentsEstimate: envNum("CHURN_COST_CENTS_ESTIMATE", 2),
    minEvCents: envNum("MIN_EV_CENTS", 0),
    minProfitFactor: envNum("MIN_PROFIT_FACTOR", 1.25),
    pauseSeconds: envNum("PAUSE_SECONDS", 300),

    // Bias (Leaderboard Flow)
    biasMode: envStr("BIAS_MODE", "leaderboard_flow"),
    leaderboardTopN: envNum("LEADERBOARD_TOP_N", 50),
    biasWindowSeconds: envNum("BIAS_WINDOW_SECONDS", 3600),
    biasMinNetUsd: envNum("BIAS_MIN_NET_USD", 300),
    biasMinTrades: envNum("BIAS_MIN_TRADES", 3),
    biasStaleSeconds: envNum("BIAS_STALE_SECONDS", 900),
    allowEntriesOnlyWithBias: envBool("ALLOW_ENTRIES_ONLY_WITH_BIAS", true),
    onBiasFlip: envStr("ON_BIAS_FLIP", "MANAGE_EXITS_ONLY"),
    onBiasNone: envStr("ON_BIAS_NONE", "PAUSE_ENTRIES"),

    // Polling / Ops
    pollIntervalMs: envNum("POLL_INTERVAL_MS", 1500),
    logLevel: envStr("LOG_LEVEL", "info"),

    // Wallet / Reserve Management
    reserveFraction: envNum("RESERVE_FRACTION", 0.25),
    minReserveUsd: envNum("MIN_RESERVE_USD", 100),
    useAvailableBalanceOnly: envBool("USE_AVAILABLE_BALANCE_ONLY", true),

    // Auth
    privateKey: process.env.PRIVATE_KEY ?? "",
    rpcUrl: envStr("RPC_URL", "https://polygon-rpc.com"),
    liveTradingEnabled:
      envStr("LIVE_TRADING", "") === "I_UNDERSTAND_THE_RISKS",

    // Telegram (optional)
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID,

    // POL Reserve (auto-fill gas)
    polReserveEnabled: envBool("POL_RESERVE_ENABLED", true),
    polReserveTarget: envNum("POL_RESERVE_TARGET", 2.0),
    polReserveMin: envNum("POL_RESERVE_MIN", 0.5),
    polReserveMaxSwapUsd: envNum("POL_RESERVE_MAX_SWAP_USD", 10),
    polReserveCheckIntervalMin: envNum("POL_RESERVE_CHECK_INTERVAL_MIN", 30),
    polReserveSlippagePct: envNum("POL_RESERVE_SLIPPAGE_PCT", 3),
  };
}

/**
 * Configuration validation errors
 */
export interface ValidationError {
  field: string;
  message: string;
}

/**
 * Validate configuration
 * Returns array of errors (empty if valid)
 */
export function validateConfig(config: ChurnConfig): ValidationError[] {
  const errors: ValidationError[] = [];

  // Required fields
  if (!config.privateKey) {
    errors.push({ field: "PRIVATE_KEY", message: "Required" });
  }

  // Numeric bounds
  if (config.tradeFraction <= 0 || config.tradeFraction > 1) {
    errors.push({
      field: "TRADE_FRACTION",
      message: "Must be between 0 and 1",
    });
  }
  if (config.maxTradeUsd <= 0) {
    errors.push({ field: "MAX_TRADE_USD", message: "Must be positive" });
  }
  if (
    config.maxDeployedFractionTotal <= 0 ||
    config.maxDeployedFractionTotal > 1
  ) {
    errors.push({
      field: "MAX_DEPLOYED_FRACTION_TOTAL",
      message: "Must be between 0 and 1",
    });
  }
  if (config.reserveFraction < 0 || config.reserveFraction > 1) {
    errors.push({
      field: "RESERVE_FRACTION",
      message: "Must be between 0 and 1",
    });
  }

  // Entry price bounds logic
  // MIN_ENTRY_PRICE_CENTS should equal MAX_ADVERSE_CENTS
  if (config.minEntryPriceCents < config.maxAdverseCents) {
    errors.push({
      field: "MIN_ENTRY_PRICE_CENTS",
      message: `Should be >= MAX_ADVERSE_CENTS (${config.maxAdverseCents})`,
    });
  }

  // MAX_ENTRY_PRICE_CENTS = 100 - TP_CENTS - ENTRY_BUFFER_CENTS
  const expectedMaxEntry =
    100 - config.tpCents - config.entryBufferCents;
  if (config.maxEntryPriceCents > expectedMaxEntry) {
    errors.push({
      field: "MAX_ENTRY_PRICE_CENTS",
      message: `Should be <= 100 - TP_CENTS - ENTRY_BUFFER_CENTS (${expectedMaxEntry})`,
    });
  }

  // Preferred entry within bounds
  if (config.preferredEntryLowCents < config.minEntryPriceCents) {
    errors.push({
      field: "PREFERRED_ENTRY_LOW_CENTS",
      message: `Should be >= MIN_ENTRY_PRICE_CENTS (${config.minEntryPriceCents})`,
    });
  }
  if (config.preferredEntryHighCents > config.maxEntryPriceCents) {
    errors.push({
      field: "PREFERRED_ENTRY_HIGH_CENTS",
      message: `Should be <= MAX_ENTRY_PRICE_CENTS (${config.maxEntryPriceCents})`,
    });
  }

  // Hedge ratios
  if (config.hedgeRatio <= 0 || config.hedgeRatio > 1) {
    errors.push({ field: "HEDGE_RATIO", message: "Must be between 0 and 1" });
  }
  if (config.maxHedgeRatio < config.hedgeRatio) {
    errors.push({
      field: "MAX_HEDGE_RATIO",
      message: "Must be >= HEDGE_RATIO",
    });
  }

  // Profit factor
  if (config.minProfitFactor < 1) {
    errors.push({ field: "MIN_PROFIT_FACTOR", message: "Must be >= 1" });
  }

  return errors;
}

/**
 * Log effective configuration (masked sensitive values)
 */
export function logConfig(config: ChurnConfig, log: (msg: string) => void): void {
  log("=".repeat(60));
  log("CHURN ENGINE - EFFECTIVE CONFIGURATION");
  log("=".repeat(60));

  log("\n[Capital & Position Sizing]");
  log(`  TRADE_FRACTION=${config.tradeFraction}`);
  log(`  MAX_TRADE_USD=${config.maxTradeUsd}`);
  log(`  MAX_DEPLOYED_FRACTION_TOTAL=${config.maxDeployedFractionTotal}`);
  log(`  MAX_OPEN_POSITIONS_TOTAL=${config.maxOpenPositionsTotal}`);
  log(`  MAX_OPEN_POSITIONS_PER_MARKET=${config.maxOpenPositionsPerMarket}`);
  log(`  COOLDOWN_SECONDS_PER_TOKEN=${config.cooldownSecondsPerToken}`);

  log("\n[Entry/Exit Bands (cents)]");
  log(`  ENTRY_BAND_CENTS=${config.entryBandCents}`);
  log(`  TP_CENTS=${config.tpCents}`);
  log(`  HEDGE_TRIGGER_CENTS=${config.hedgeTriggerCents}`);
  log(`  MAX_ADVERSE_CENTS=${config.maxAdverseCents}`);
  log(`  MAX_HOLD_SECONDS=${config.maxHoldSeconds}`);

  log("\n[Hedge Behavior]");
  log(`  HEDGE_RATIO=${config.hedgeRatio}`);
  log(`  MAX_HEDGE_RATIO=${config.maxHedgeRatio}`);

  log("\n[Entry Price Bounds (cents)]");
  log(`  MIN_ENTRY_PRICE_CENTS=${config.minEntryPriceCents}`);
  log(`  MAX_ENTRY_PRICE_CENTS=${config.maxEntryPriceCents}`);
  log(`  PREFERRED_ENTRY_LOW_CENTS=${config.preferredEntryLowCents}`);
  log(`  PREFERRED_ENTRY_HIGH_CENTS=${config.preferredEntryHighCents}`);
  log(`  ENTRY_BUFFER_CENTS=${config.entryBufferCents}`);

  log("\n[Liquidity Gates]");
  log(`  MIN_SPREAD_CENTS=${config.minSpreadCents}`);
  log(`  MIN_DEPTH_USD_AT_EXIT=${config.minDepthUsdAtExit}`);
  log(`  MIN_TRADES_LAST_X=${config.minTradesLastX}`);
  log(`  MIN_BOOK_UPDATES_LAST_X=${config.minBookUpdatesLastX}`);
  log(`  ACTIVITY_WINDOW_SECONDS=${config.activityWindowSeconds}`);

  log("\n[EV / Casino Controls]");
  log(`  ROLLING_WINDOW_TRADES=${config.rollingWindowTrades}`);
  log(`  CHURN_COST_CENTS_ESTIMATE=${config.churnCostCentsEstimate}`);
  log(`  MIN_EV_CENTS=${config.minEvCents}`);
  log(`  MIN_PROFIT_FACTOR=${config.minProfitFactor}`);
  log(`  PAUSE_SECONDS=${config.pauseSeconds}`);

  log("\n[Bias (Leaderboard Flow)]");
  log(`  BIAS_MODE=${config.biasMode}`);
  log(`  LEADERBOARD_TOP_N=${config.leaderboardTopN}`);
  log(`  BIAS_WINDOW_SECONDS=${config.biasWindowSeconds}`);
  log(`  BIAS_MIN_NET_USD=${config.biasMinNetUsd}`);
  log(`  BIAS_MIN_TRADES=${config.biasMinTrades}`);
  log(`  BIAS_STALE_SECONDS=${config.biasStaleSeconds}`);
  log(`  ALLOW_ENTRIES_ONLY_WITH_BIAS=${config.allowEntriesOnlyWithBias}`);
  log(`  ON_BIAS_FLIP=${config.onBiasFlip}`);
  log(`  ON_BIAS_NONE=${config.onBiasNone}`);

  log("\n[Wallet / Reserve Management]");
  log(`  RESERVE_FRACTION=${config.reserveFraction}`);
  log(`  MIN_RESERVE_USD=${config.minReserveUsd}`);
  log(`  USE_AVAILABLE_BALANCE_ONLY=${config.useAvailableBalanceOnly}`);

  log("\n[Operations]");
  log(`  POLL_INTERVAL_MS=${config.pollIntervalMs}`);
  log(`  LOG_LEVEL=${config.logLevel}`);
  log(`  LIVE_TRADING=${config.liveTradingEnabled ? "ENABLED" : "SIMULATION"}`);
  log(`  RPC_URL=${config.rpcUrl.slice(0, 30)}...`);
  log(`  PRIVATE_KEY=${config.privateKey ? "***SET***" : "NOT SET"}`);
  log(
    `  TELEGRAM=${config.telegramBotToken && config.telegramChatId ? "ENABLED" : "DISABLED"}`,
  );

  log("\n[POL Reserve (Auto Gas Fill)]");
  log(`  POL_RESERVE_ENABLED=${config.polReserveEnabled}`);
  log(`  POL_RESERVE_TARGET=${config.polReserveTarget}`);
  log(`  POL_RESERVE_MIN=${config.polReserveMin}`);
  log(`  POL_RESERVE_MAX_SWAP_USD=${config.polReserveMaxSwapUsd}`);
  log(`  POL_RESERVE_CHECK_INTERVAL_MIN=${config.polReserveCheckIntervalMin}`);
  log(`  POL_RESERVE_SLIPPAGE_PCT=${config.polReserveSlippagePct}`);

  log("=".repeat(60));
}

/**
 * Calculate effective bankroll after reserve
 */
export function calculateEffectiveBankroll(
  walletBalance: number,
  config: ChurnConfig,
): { effectiveBankroll: number; reserveUsd: number } {
  const reserveUsd = Math.max(
    walletBalance * config.reserveFraction,
    config.minReserveUsd,
  );
  const effectiveBankroll = Math.max(0, walletBalance - reserveUsd);
  return { effectiveBankroll, reserveUsd };
}

/**
 * Calculate trade size based on config and bankroll
 */
export function calculateTradeSize(
  effectiveBankroll: number,
  config: ChurnConfig,
): number {
  const fractionalSize = effectiveBankroll * config.tradeFraction;
  return Math.min(fractionalSize, config.maxTradeUsd);
}
