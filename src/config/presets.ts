export const ARB_PRESETS = {
  off: {
    ARB_ENABLED: false,
  },
  safe_small: {
    ARB_ENABLED: true,
    ARB_SCAN_INTERVAL_MS: 1000,
    ARB_MIN_EDGE_BPS: 120,
    ARB_MIN_PROFIT_USD: 0.1,
    ARB_MIN_LIQUIDITY_USD: 2000,
    ARB_MAX_SPREAD_BPS: 200,
    ARB_TRADE_BASE_USD: 2,
    ARB_SIZE_SCALING: "sqrt",
    ARB_SLIPPAGE_BPS: 60,
    ARB_FEE_BPS: 10,
    ARB_MAX_POSITION_USD: 10,
    ARB_MAX_WALLET_EXPOSURE_USD: 25,
    ARB_MAX_TRADES_PER_HOUR: 1000,
    ARB_MARKET_COOLDOWN_SECONDS: 10,
    ARB_MAX_CONSECUTIVE_FAILURES: 3,
    ARB_MAX_CONCURRENT_TRADES: 5,
    ARB_STARTUP_COOLDOWN_SECONDS: 30,
  },
  classic: {
    ARB_ENABLED: true,
    ARB_SCAN_INTERVAL_MS: 500,
    ARB_MIN_EDGE_BPS: 100,
    ARB_MIN_PROFIT_USD: 0.1,
    ARB_MIN_LIQUIDITY_USD: 2000,
    ARB_MAX_SPREAD_BPS: 200,
    ARB_TRADE_BASE_USD: 5,
    ARB_SIZE_SCALING: "sqrt",
    ARB_SLIPPAGE_BPS: 60,
    ARB_FEE_BPS: 10,
    ARB_MAX_POSITION_USD: 25,
    ARB_MAX_WALLET_EXPOSURE_USD: 100,
    ARB_MAX_TRADES_PER_HOUR: 2000,
    ARB_MARKET_COOLDOWN_SECONDS: 5,
    ARB_MAX_CONSECUTIVE_FAILURES: 3,
    ARB_MAX_CONCURRENT_TRADES: 10,
    ARB_STARTUP_COOLDOWN_SECONDS: 15,
  },
  micro: {
    ARB_ENABLED: true,
    ARB_SCAN_INTERVAL_MS: 250,
    ARB_MIN_EDGE_BPS: 50,
    ARB_MIN_PROFIT_USD: 0.05,
    ARB_MIN_LIQUIDITY_USD: 5000,
    ARB_MAX_SPREAD_BPS: 150,
    ARB_TRADE_BASE_USD: 3,
    ARB_SIZE_SCALING: "sqrt",
    ARB_SLIPPAGE_BPS: 40,
    ARB_FEE_BPS: 10,
    ARB_MAX_POSITION_USD: 25,
    ARB_MAX_WALLET_EXPOSURE_USD: 125,
    ARB_MAX_TRADES_PER_HOUR: 5000,
    ARB_MARKET_COOLDOWN_SECONDS: 3,
    ARB_MAX_CONSECUTIVE_FAILURES: 5,
    ARB_MAX_CONCURRENT_TRADES: 15,
    ARB_STARTUP_COOLDOWN_SECONDS: 10,
  },
  quality: {
    ARB_ENABLED: true,
    ARB_SCAN_INTERVAL_MS: 1000,
    ARB_MIN_EDGE_BPS: 150,
    ARB_MIN_PROFIT_USD: 0.25,
    ARB_MIN_LIQUIDITY_USD: 15000,
    ARB_MAX_SPREAD_BPS: 100,
    ARB_TRADE_BASE_USD: 8,
    ARB_SIZE_SCALING: "sqrt",
    ARB_SLIPPAGE_BPS: 30,
    ARB_FEE_BPS: 10,
    ARB_MAX_POSITION_USD: 40,
    ARB_MAX_WALLET_EXPOSURE_USD: 200,
    ARB_MAX_TRADES_PER_HOUR: 1500,
    ARB_MARKET_COOLDOWN_SECONDS: 10,
    ARB_MAX_CONSECUTIVE_FAILURES: 3,
    ARB_MAX_CONCURRENT_TRADES: 8,
    ARB_STARTUP_COOLDOWN_SECONDS: 20,
  },
  late: {
    ARB_ENABLED: true,
    ARB_SCAN_INTERVAL_MS: 250,
    ARB_MIN_EDGE_BPS: 60,
    ARB_MIN_PROFIT_USD: 0.1,
    ARB_MIN_LIQUIDITY_USD: 3000,
    ARB_MAX_SPREAD_BPS: 250,
    ARB_TRADE_BASE_USD: 5,
    ARB_SIZE_SCALING: "sqrt",
    ARB_SLIPPAGE_BPS: 80,
    ARB_FEE_BPS: 10,
    ARB_MAX_HOLD_MINUTES: 30,
    ARB_MAX_POSITION_USD: 25,
    ARB_MAX_WALLET_EXPOSURE_USD: 120,
    ARB_MAX_TRADES_PER_HOUR: 3000,
    ARB_MARKET_COOLDOWN_SECONDS: 3,
    ARB_MAX_CONSECUTIVE_FAILURES: 5,
    ARB_MAX_CONCURRENT_TRADES: 12,
    ARB_STARTUP_COOLDOWN_SECONDS: 5,
  },
} as const;

export const MONITOR_PRESETS = {
  off: {
    MONITOR_ENABLED: false,
    MONITOR_REQUIRE_CONFIRMED: true,
  },
  conservative: {
    MONITOR_ENABLED: true,
    FETCH_INTERVAL: 2,
    MIN_TRADE_SIZE_USD: 250,
    TRADE_MULTIPLIER: 0.2,
    RETRY_LIMIT: 1,
    TRADE_AGGREGATION_ENABLED: true,
    TRADE_AGGREGATION_WINDOW_SECONDS: 15,
    FRONTRUN_SIZE_MULTIPLIER: 0.1,
    FRONTRUN_MAX_SIZE_USD: 25,
    GAS_PRICE_MULTIPLIER: 1.08,
    MONITOR_REQUIRE_CONFIRMED: true,
  },
  balanced: {
    MONITOR_ENABLED: true,
    FETCH_INTERVAL: 2,
    MIN_TRADE_SIZE_USD: 75,
    TRADE_MULTIPLIER: 0.2,
    RETRY_LIMIT: 1,
    TRADE_AGGREGATION_ENABLED: true,
    TRADE_AGGREGATION_WINDOW_SECONDS: 15,
    FRONTRUN_SIZE_MULTIPLIER: 0.1,
    FRONTRUN_MAX_SIZE_USD: 50,
    GAS_PRICE_MULTIPLIER: 1.08,
    MONITOR_REQUIRE_CONFIRMED: true,
  },
  active: {
    MONITOR_ENABLED: true,
    FETCH_INTERVAL: 1,
    MIN_TRADE_SIZE_USD: 25,
    TRADE_MULTIPLIER: 0.15,
    RETRY_LIMIT: 1,
    TRADE_AGGREGATION_ENABLED: true,
    TRADE_AGGREGATION_WINDOW_SECONDS: 10,
    FRONTRUN_SIZE_MULTIPLIER: 0.05,
    FRONTRUN_MAX_SIZE_USD: 100,
    GAS_PRICE_MULTIPLIER: 1.05,
    MONITOR_REQUIRE_CONFIRMED: false,
  },
  test: {
    MONITOR_ENABLED: true,
    FETCH_INTERVAL: 2,
    MIN_TRADE_SIZE_USD: 5,
    TRADE_MULTIPLIER: 0.05,
    RETRY_LIMIT: 0,
    TRADE_AGGREGATION_ENABLED: false,
    FRONTRUN_SIZE_MULTIPLIER: 0.02,
    FRONTRUN_MAX_SIZE_USD: 10,
    GAS_PRICE_MULTIPLIER: 1.02,
    MONITOR_REQUIRE_CONFIRMED: false,
  },
} as const;

export const STRATEGY_PRESETS = {
  off: {
    STRATEGY_ENABLED: false,
    ARB_ENABLED: false,
    MONITOR_ENABLED: false,
    QUICK_FLIP_ENABLED: false,
    QUICK_FLIP_TARGET_PCT: 5,
    QUICK_FLIP_STOP_LOSS_PCT: 3,
    QUICK_FLIP_MIN_HOLD_SECONDS: 30,
    AUTO_SELL_ENABLED: false,
    AUTO_SELL_THRESHOLD: 0.99,
    AUTO_SELL_MIN_HOLD_SECONDS: 120,
    ENDGAME_SWEEP_ENABLED: false,
    ENDGAME_MIN_PRICE: 0.98,
    ENDGAME_MAX_PRICE: 0.995,
    MAX_POSITION_USD: 25,
    AUTO_REDEEM_ENABLED: false,
    AUTO_REDEEM_MIN_POSITION_USD: 0.10,
  },
  conservative: {
    STRATEGY_ENABLED: true,
    // Combines ARB + MONITOR settings
    ARB_ENABLED: true,
    MONITOR_ENABLED: true,
    // Quick Flip settings
    QUICK_FLIP_ENABLED: true,
    QUICK_FLIP_TARGET_PCT: 7, // Higher target, fewer trades
    QUICK_FLIP_STOP_LOSS_PCT: 2,
    QUICK_FLIP_MIN_HOLD_SECONDS: 60,
    // Auto-sell settings
    AUTO_SELL_ENABLED: true,
    AUTO_SELL_THRESHOLD: 0.997, // 99.7¢ (only if price improves above endgame purchases)
    AUTO_SELL_MIN_HOLD_SECONDS: 300, // Hold at least 5 minutes before auto-selling
    // Endgame sweep settings
    ENDGAME_SWEEP_ENABLED: true,
    ENDGAME_MIN_PRICE: 0.985, // 98.5¢
    ENDGAME_MAX_PRICE: 0.995, // 99.5¢ (auto-sell threshold is higher to avoid conflict)
    MAX_POSITION_USD: 15, // Conservative position sizing
    // Auto-Redeem settings (claim resolved positions)
    AUTO_REDEEM_ENABLED: true,
    AUTO_REDEEM_MIN_POSITION_USD: 0.10, // Skip dust below 10 cents
    // Rate limits - high throughput for volume
    ORDER_SUBMIT_MAX_PER_HOUR: 3000,
    ORDER_SUBMIT_MIN_INTERVAL_MS: 200,
    ORDER_SUBMIT_MARKET_COOLDOWN_SECONDS: 10,
    // Existing ARB settings
    ARB_SCAN_INTERVAL_MS: 1000,
    ARB_MIN_EDGE_BPS: 120,
    ARB_MAX_SPREAD_BPS: 300,
    ARB_TRADE_BASE_USD: 3,
    ARB_MAX_POSITION_USD: 15,
    ARB_MAX_WALLET_EXPOSURE_USD: 50,
    ARB_MAX_TRADES_PER_HOUR: 2000,
    ARB_MAX_CONCURRENT_TRADES: 8,
    ARB_MARKET_COOLDOWN_SECONDS: 10,
    // Existing Monitor settings (from balanced)
    FETCH_INTERVAL: 2,
    MIN_TRADE_SIZE_USD: 50,
    TRADE_MULTIPLIER: 0.15,
    MONITOR_REQUIRE_CONFIRMED: true,
  },
  balanced: {
    STRATEGY_ENABLED: true,
    // Combines ARB + MONITOR settings
    ARB_ENABLED: true,
    MONITOR_ENABLED: true,
    // Quick Flip settings
    QUICK_FLIP_ENABLED: true,
    QUICK_FLIP_TARGET_PCT: 5, // 5% gain target
    QUICK_FLIP_STOP_LOSS_PCT: 3, // 3% stop loss
    QUICK_FLIP_MIN_HOLD_SECONDS: 30,
    // Auto-sell settings
    AUTO_SELL_ENABLED: true,
    AUTO_SELL_THRESHOLD: 0.996, // 99.6¢ (above endgame max to avoid conflict)
    AUTO_SELL_MIN_HOLD_SECONDS: 120, // Hold at least 2 minutes before auto-selling
    // Endgame sweep settings
    ENDGAME_SWEEP_ENABLED: true,
    ENDGAME_MIN_PRICE: 0.985, // 98.5¢ (ensures 1.3% net profit minimum after 0.2% fees)
    ENDGAME_MAX_PRICE: 0.995, // 99.5¢ (auto-sell threshold is higher)
    MAX_POSITION_USD: 25, // Balanced position sizing
    // Auto-Redeem settings (claim resolved positions)
    AUTO_REDEEM_ENABLED: true,
    AUTO_REDEEM_MIN_POSITION_USD: 0.10, // Skip dust below 10 cents
    // Rate limits - maximize throughput
    ORDER_SUBMIT_MAX_PER_HOUR: 5000,
    ORDER_SUBMIT_MIN_INTERVAL_MS: 100,
    ORDER_SUBMIT_MARKET_COOLDOWN_SECONDS: 5,
    // ARB settings - high volume
    ARB_SCAN_INTERVAL_MS: 500,
    ARB_MIN_EDGE_BPS: 50,
    ARB_MIN_PROFIT_USD: 0.05,
    ARB_MIN_LIQUIDITY_USD: 3000,
    ARB_MAX_SPREAD_BPS: 10000, // Very permissive
    ARB_TRADE_BASE_USD: 5,
    ARB_SIZE_SCALING: "sqrt",
    ARB_SLIPPAGE_BPS: 50,
    ARB_FEE_BPS: 10,
    ARB_MAX_POSITION_USD: 25,
    ARB_MAX_WALLET_EXPOSURE_USD: 150,
    ARB_MAX_TRADES_PER_HOUR: 5000,
    ARB_MARKET_COOLDOWN_SECONDS: 5,
    ARB_MAX_CONSECUTIVE_FAILURES: 5,
    ARB_MAX_CONCURRENT_TRADES: 15,
    ARB_STARTUP_COOLDOWN_SECONDS: 10,
    ARB_DEBUG_TOP_N: 10,
    // Monitor settings - fast scanning
    FETCH_INTERVAL: 1,
    MIN_TRADE_SIZE_USD: 1, // Low minimum to catch more
    MIN_ORDER_USD: 1,
    TRADE_MULTIPLIER: 0.15,
    TRADE_AGGREGATION_ENABLED: true,
    TRADE_AGGREGATION_WINDOW_SECONDS: 10,
    FRONTRUN_SIZE_MULTIPLIER: 0.05,
    FRONTRUN_MAX_SIZE_USD: 100,
    GAS_PRICE_MULTIPLIER: 1.05,
    MONITOR_REQUIRE_CONFIRMED: false,
  },
  aggressive: {
    STRATEGY_ENABLED: true,
    ARB_ENABLED: true,
    MONITOR_ENABLED: true,
    // Quick Flip settings - SCALPING with fee awareness
    // Polymarket fees: 0.1% per trade = 0.2% round-trip
    // At 80-90¢ range, there's room for 5-10% quick moves
    QUICK_FLIP_ENABLED: true,
    QUICK_FLIP_TARGET_PCT: 5, // 5% gross = 4.8% net after 0.2% fees - quick scalp target
    QUICK_FLIP_STOP_LOSS_PCT: 3, // Cut losses at 3% (3.2% net loss with fees)
    QUICK_FLIP_MIN_HOLD_SECONDS: 1, // Exit immediately when target hit
    // Auto-sell at high prices (lock in gains when price spikes)
    AUTO_SELL_ENABLED: true,
    AUTO_SELL_THRESHOLD: 0.95, // Sell when price hits 95¢ (take the win)
    AUTO_SELL_MIN_HOLD_SECONDS: 1, // Instant exit
    // Endgame sweep - TARGET 80-90¢ range for quick scalps
    // At 80¢ → 85¢ = 6.25% gross, 6.05% net
    // At 85¢ → 90¢ = 5.9% gross, 5.7% net  
    // At 90¢ → 95¢ = 5.5% gross, 5.3% net
    // More volatility, more opportunities, don't have to wait for resolution
    ENDGAME_SWEEP_ENABLED: true,
    ENDGAME_MIN_PRICE: 0.80, // Buy positions at 80¢+ (sweet spot for scalping)
    ENDGAME_MAX_PRICE: 0.92, // Up to 92¢ (leave room for quick profit taking)
    MAX_POSITION_USD: 50, // Aggressive position sizing
    // Auto-Redeem settings (claim resolved positions - bonus profit)
    AUTO_REDEEM_ENABLED: true,
    AUTO_REDEEM_MIN_POSITION_USD: 0.01, // Claim everything
    // Rate limits - MAXIMUM THROUGHPUT for high-frequency scalping
    // Polymarket allows ~216,000/hour - we use most of that capacity
    ORDER_SUBMIT_MAX_PER_HOUR: 200000, // 200k/hour for serious scalping
    ORDER_SUBMIT_MIN_INTERVAL_MS: 0, // No delay - fire as fast as possible
    ORDER_SUBMIT_MARKET_COOLDOWN_SECONDS: 0, // No per-market cooldown
    // ARB settings - maximum volume, maximum speed
    ARB_SCAN_INTERVAL_MS: 50, // Scan every 50ms (20 scans/second)
    ARB_MIN_EDGE_BPS: 30, // 0.3% minimum edge (0.1% net after 0.2% fees)
    ARB_MAX_SPREAD_BPS: 50000, // Very permissive
    ARB_FEE_BPS: 10, // 0.1% per side (Polymarket fee)
    ARB_TRADE_BASE_USD: 10,
    ARB_MAX_POSITION_USD: 100,
    ARB_MAX_WALLET_EXPOSURE_USD: 1000,
    ARB_MAX_TRADES_PER_HOUR: 200000, // Match order submission limit
    ARB_MARKET_COOLDOWN_SECONDS: 0, // No cooldown - trade same market repeatedly
    ARB_MAX_CONCURRENT_TRADES: 100, // Run MANY trades in parallel
    ARB_STARTUP_COOLDOWN_SECONDS: 0, // Start immediately
    // Monitor settings - maximum speed scanning
    FETCH_INTERVAL: 1,
    MIN_TRADE_SIZE_USD: 1,
    MIN_ORDER_USD: 1,
    FRONTRUN_MAX_SIZE_USD: 500,
    MONITOR_REQUIRE_CONFIRMED: false,
  },
} as const;

export type ArbPresetName = keyof typeof ARB_PRESETS;
export type MonitorPresetName = keyof typeof MONITOR_PRESETS;
export type StrategyPresetName = keyof typeof STRATEGY_PRESETS;

export const DEFAULT_ARB_PRESET: ArbPresetName = "safe_small";
export const DEFAULT_MONITOR_PRESET: MonitorPresetName = "balanced";
export const DEFAULT_STRATEGY_PRESET: StrategyPresetName = "off";
