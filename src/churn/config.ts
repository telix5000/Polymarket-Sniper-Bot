/**
 * Churn Engine - Configuration Module
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POLYMARKET CASINO BOT - Configuration
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE MATH IS LAW. Every parameter is fixed by the EV equation:
 *
 *   EV = p(win) × avg_win - p(loss) × avg_loss - churn_cost
 *
 * Fixed values:
 *   avg_win  = 14¢  (TP_CENTS)
 *   avg_loss = 9¢   (after hedge caps losses)
 *   churn    = 2¢   (spread + slippage)
 *
 * Break-even: p > (9 + 2) / (14 + 9) = 47.8%
 *
 *   50% wins → EV positive
 *   55% wins → solid profit
 *   60% wins → strong profit
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * USER CONFIGURATION (ONLY THESE MATTER):
 *   MAX_TRADE_USD                  - Your bet size in dollars (default: $25)
 *
 * REQUIRED ENV:
 *   PRIVATE_KEY                    - Your wallet private key
 *   RPC_URL                        - Polygon RPC endpoint
 *   LIVE_TRADING=I_UNDERSTAND_THE_RISKS
 *
 * OPTIONAL ENV:
 *   TELEGRAM_BOT_TOKEN             - Alerts
 *   TELEGRAM_CHAT_ID               - Alerts
 *   GITHUB_ERROR_REPORTER_TOKEN    - Auto error reporting
 *   WG_CONFIG / WIREGUARD_CONFIG   - WireGuard (base64)
 *   OVPN_CONFIG / OPENVPN_CONFIG   - OpenVPN (base64)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERYTHING ELSE IS FIXED BY THE MATH. DO NOT CHANGE.
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
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONLY USER-TUNABLE PARAMETER: MAX_TRADE_USD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Set MAX_TRADE_USD to your preferred bet size. Everything else is fixed
 * by the math equation and will manage risk automatically.
 *
 * Example: MAX_TRADE_USD=50 means each trade is up to $50
 *
 * The math parameters below are FIXED. They produce:
 *   avg_win  = 14¢
 *   avg_loss = 9¢ (after hedging)
 *   break-even = 48% win rate
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */
export interface ChurnConfig {
  // ═══════════════════════════════════════════════════════════════════════════
  // USER CONFIGURABLE (the ONLY thing you should change)
  // ═══════════════════════════════════════════════════════════════════════════
  maxTradeUsd: number;  // Your bet size in USD (default: $25)

  // ═══════════════════════════════════════════════════════════════════════════
  // FIXED BY THE MATH (do not change)
  // ═══════════════════════════════════════════════════════════════════════════

  // Capital & Position Sizing (fixed ratios)
  tradeFraction: number;
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
  positionPollIntervalMs: number;
  logLevel: string;

  // Wallet / Reserve Management
  reserveFraction: number;
  minReserveUsd: number;
  useAvailableBalanceOnly: boolean;

  // Liquidation Mode
  forceLiquidation: boolean;  // If true, start liquidating positions even with no effective bankroll
  liquidationMaxSlippagePct: number;  // Max slippage for liquidation sells (default: 10%)
  liquidationPollIntervalMs: number;  // Poll interval in liquidation mode (default: 1000ms)

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
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MATH (DO NOT CHANGE WITHOUT UNDERSTANDING)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * EV = p(win) × avg_win - p(loss) × avg_loss - churn
 *
 * Our equation:
 *   avg_win  = TP_CENTS           = 14¢
 *   avg_loss = ~9¢                (hedging caps this)
 *   churn    = CHURN_COST_CENTS   = 2¢
 *
 * Break-even: (9 + 2) / (14 + 9) = 47.8%
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POLYMARKET API RATE LIMITS (as of 2024)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * General CLOB:           900 req/sec  (9,000 / 10 sec)
 * Orderbook (/book):      150 req/sec  (1,500 / 10 sec)
 * Price endpoints:        150 req/sec  (1,500 / 10 sec)
 * Trades/Orders:           90 req/sec  (900 / 10 sec)
 * Balance allowance:       20 req/sec  (200 / 10 sec)
 *
 * WE CAN POLL AGGRESSIVELY:
 * - 100ms intervals = 10 req/sec (well under limits)
 * - Even 50ms would be fine for position tracking
 *
 * Source: https://docs.polymarket.com/quickstart/introduction/rate-limits
 * ═══════════════════════════════════════════════════════════════════════════
 */
export function loadConfig(): ChurnConfig {
  return {
    // ═══════════════════════════════════════════════════════════════════════
    // USER CONFIGURABLE - This is the ONLY thing you should change
    // ═══════════════════════════════════════════════════════════════════════
    maxTradeUsd: envNum("MAX_TRADE_USD", 25),  // 💰 Your bet size (default: $25)

    // ═══════════════════════════════════════════════════════════════════════
    // FIXED BY THE MATH - Do NOT change these values
    // The math equation requires these exact parameters to work
    // ═══════════════════════════════════════════════════════════════════════

    // Capital sizing (fixed ratios that scale with MAX_TRADE_USD)
    tradeFraction: 0.01,              // 1% of bankroll per trade
    maxDeployedFractionTotal: 0.3,    // 30% max exposure
    maxOpenPositionsTotal: 12,        // Max concurrent positions
    maxOpenPositionsPerMarket: 2,     // Max per market
    cooldownSecondsPerToken: 180,     // 3min between trades same token

    // Entry/Exit bands - produces avg_win=14¢, avg_loss=9¢
    entryBandCents: 12,               // Min price movement to enter
    tpCents: 14,                      // Take profit = 14¢
    hedgeTriggerCents: 16,            // Hedge at 16¢ adverse
    maxAdverseCents: 30,              // HARD STOP at 30¢ loss
    maxHoldSeconds: 3600,             // 1 hour max hold

    // Hedge behavior - caps avg_loss to ~9¢ instead of 30¢
    hedgeRatio: 0.4,                  // Hedge 40% on first trigger
    maxHedgeRatio: 0.7,               // Never hedge more than 70%

    // Entry price bounds - room to win, hedge, and be wrong
    minEntryPriceCents: 30,           // <30¢ = one bad tick kills you
    maxEntryPriceCents: 82,           // >82¢ = no room for TP
    preferredEntryLowCents: 35,       // Ideal zone starts
    preferredEntryHighCents: 65,      // Ideal zone ends
    entryBufferCents: 4,              // Safety buffer

    // Liquidity gates - keeps churn cost at ~2¢
    minSpreadCents: 6,                // Max acceptable spread
    minDepthUsdAtExit: 25,            // Need liquidity to exit
    minTradesLastX: 10,               // Market must be active
    minBookUpdatesLastX: 20,          // Book must be updating
    activityWindowSeconds: 300,       // 5min activity window

    // EV / Casino controls - bot stops itself when math says stop
    rollingWindowTrades: 200,         // Sample size for stats
    churnCostCentsEstimate: 2,        // 2¢ churn cost
    minEvCents: 0,                    // Pause if EV < 0
    minProfitFactor: 1.25,            // avg_win/avg_loss >= 1.25
    pauseSeconds: 300,                // 5min pause when table closed

    // Bias (Leaderboard flow) - permission, not prediction
    biasMode: "leaderboard_flow",
    leaderboardTopN: 50,              // Track top 50 wallets
    biasWindowSeconds: 3600,          // 1 hour window
    biasMinNetUsd: 300,               // $300 net flow minimum
    biasMinTrades: 3,                 // At least 3 trades
    biasStaleSeconds: 900,            // Bias expires after 15min
    allowEntriesOnlyWithBias: true,
    onBiasFlip: "MANAGE_EXITS_ONLY",
    onBiasNone: "PAUSE_ENTRIES",

    // Polling (fixed - fast polling for accurate position tracking)
    pollIntervalMs: 200,              // 200ms = 5 req/sec
    positionPollIntervalMs: 100,      // 100ms when holding positions
    logLevel: envStr("LOG_LEVEL", "info"),

    // Wallet / Reserve (fixed - survive variance)
    reserveFraction: 0.25,            // 25% always reserved
    minReserveUsd: 100,               // $100 minimum reserve
    useAvailableBalanceOnly: true,

    // Liquidation Mode - force sell existing positions when balance is too low
    forceLiquidation: envBool("FORCE_LIQUIDATION", false),
    liquidationMaxSlippagePct: envNum("LIQUIDATION_MAX_SLIPPAGE_PCT", 10),  // 10% default
    liquidationPollIntervalMs: envNum("LIQUIDATION_POLL_INTERVAL_MS", 1000),  // 1s default

    // ═══════════════════════════════════════════════════════════════════════
    // AUTH & INTEGRATIONS (user provides these)
    // ═══════════════════════════════════════════════════════════════════════
    privateKey: process.env.PRIVATE_KEY ?? "",
    rpcUrl: envStr("RPC_URL", "https://polygon-rpc.com"),
    liveTradingEnabled:
      envStr("LIVE_TRADING", "") === "I_UNDERSTAND_THE_RISKS",

    // Telegram (optional)
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID,

    // POL Reserve - auto-fill gas (fixed settings)
    polReserveEnabled: true,
    polReserveTarget: 2.0,
    polReserveMin: 0.5,
    polReserveMaxSwapUsd: 10,
    polReserveCheckIntervalMin: 30,
    polReserveSlippagePct: 3,
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
 * Only validates user-configurable values (MAX_TRADE_USD) and required auth
 */
export function validateConfig(config: ChurnConfig): ValidationError[] {
  const errors: ValidationError[] = [];

  // Required: wallet key
  if (!config.privateKey) {
    errors.push({ field: "PRIVATE_KEY", message: "Required" });
  }

  // User-configurable: bet size must be positive
  if (config.maxTradeUsd <= 0) {
    errors.push({ field: "MAX_TRADE_USD", message: "Must be positive" });
  }

  return errors;
}

/**
 * Log effective configuration (simple, user-friendly)
 */
export function logConfig(config: ChurnConfig, log: (msg: string) => void): void {
  log("");
  log("🎰 POLYMARKET CASINO BOT");
  log("═".repeat(50));
  log("");
  log("💰 YOUR SETTINGS:");
  log(`   Bet size: $${config.maxTradeUsd} per trade`);
  log(`   Live trading: ${config.liveTradingEnabled ? "✅ ENABLED" : "⚠️ SIMULATION"}`);
  log(`   Telegram: ${config.telegramBotToken && config.telegramChatId ? "✅ ENABLED" : "❌ DISABLED"}`);
  if (config.forceLiquidation) {
    log(`   Force liquidation: ⚠️ ENABLED`);
  }
  log("");
  log("📊 THE MATH (fixed, don't change):");
  log(`   Take profit: +${config.tpCents}¢ (avg win)`);
  log(`   Hedge trigger: -${config.hedgeTriggerCents}¢`);
  log(`   Hard stop: -${config.maxAdverseCents}¢`);
  log(`   Avg loss after hedge: ~9¢`);
  log(`   Break-even: 48% win rate`);
  log("");
  log("🐋 WHALE TRACKING:");
  log(`   Following top ${config.leaderboardTopN} wallets`);
  log(`   Min flow: $${config.biasMinNetUsd}`);
  log("");
  log("🛡️ RISK LIMITS:");
  log(`   Reserve: ${config.reserveFraction * 100}% untouchable`);
  log(`   Max exposure: ${config.maxDeployedFractionTotal * 100}%`);
  log(`   Max positions: ${config.maxOpenPositionsTotal}`);
  log("");
  log("═".repeat(50));
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
