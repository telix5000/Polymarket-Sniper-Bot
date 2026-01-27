# ⚡ APEX v3.0 - Aggressive Polymarket Execution

Next-generation trading bot with intelligent capital allocation and adaptive strategies.

## 🚀 What's New in APEX v3.0

### Core Features
- **🎯 APEX Hunter**: Active market scanner detecting 6 opportunity patterns
- **🧠 APEX Oracle**: Daily performance review with automatic capital reallocation
- **📊 Dynamic Scaling**: Percentage-based position sizing with account tier detection
- **⚡ APEX Strategies**: Velocity, Shadow, Blitz, Closer, Amplifier, Grinder
- **🎚️ Three Modes**: CONSERVATIVE (5%), BALANCED (7%), AGGRESSIVE (10%)
- **📈 Telegram Reports**: Hourly summaries, daily reviews, weekly progress

### One-Line Configuration
```bash
# That's it! Balance auto-detected, positions auto-scaled
APEX_MODE=AGGRESSIVE PRIVATE_KEY=0x... RPC_URL=https://polygon-rpc.com npm start
```

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure (copy .env.example to .env)
cp .env.example .env

# 3. Set your keys in .env
PRIVATE_KEY=0x...
RPC_URL=https://polygon-rpc.com
APEX_MODE=AGGRESSIVE  # or BALANCED or CONSERVATIVE

# 4. Enable live trading (optional - defaults to simulation)
LIVE_TRADING=I_UNDERSTAND_THE_RISKS

# 5. Start trading
npm start
```

**⚠️ Important**: The bot defaults to **simulation mode**. Set `LIVE_TRADING=I_UNDERSTAND_THE_RISKS` to enable real trades.

## APEX Modes

| Mode | Position Size | Max Exposure | Weekly Target | Best For |
|------|--------------|--------------|---------------|----------|
| **CONSERVATIVE** | 5% of balance | 60% | +12% | Safe & steady growth |
| **BALANCED** | 7% of balance | 70% | +18% | Moderate risk/reward |
| **AGGRESSIVE** | 10% of balance | 80% | +25% | Maximum performance |

## Account Tiers (Auto-Detected)

Position sizes automatically scale with your balance:

| Tier | Balance Range | Multiplier | Description |
|------|---------------|------------|-------------|
| **Entry** | $100 - $500 | 1.0× | Starting out |
| **Growing** | $500 - $1,500 | 1.2× | Building capital |
| **Advanced** | $1,500 - $3,000 | 1.4× | Experienced |
| **Elite** | $3,000+ | 1.5× | Pro trader |

## APEX Strategies

### Entry Strategies
- **⚡ APEX Hunter**: Scans for momentum, mispricing, volume spikes, new markets
- **⚡ APEX Velocity**: Momentum trading (12%+ velocity detection)
- **⚡ APEX Shadow**: Copy trading (follows your target addresses)
- **⚡ APEX Closer**: Endgame positions (92-97¢)
- **⚡ APEX Amplifier**: Stacks winning positions
- **⚡ APEX Grinder**: High volume opportunities

### Exit Strategies
- **⚡ APEX Blitz**: Quick scalps (0.6-3% profit)
- **⚡ APEX Command**: Auto-sell at 99.5¢
- **⚡ APEX Guardian**: Hard stop-loss protection
- **⚡ APEX Ratchet**: Dynamic trailing stop
- **⚡ APEX Ladder**: Partial profit taking
- **⚡ APEX Reaper**: Strategy performance cleanup

📚 **Documentation:**
- **[Selling Logic Guide](docs/SELLING_LOGIC.md)** - Complete documentation of all sell pathways
- **[Quick Reference](docs/SELL_QUICK_REFERENCE.md)** - Fast troubleshooting guide
- **[Emergency Sells](docs/EMERGENCY_SELLS.md)** - CONSERVATIVE/MODERATE/NUCLEAR modes
- **🛡️ Smart Sell**: Intelligent sell execution with slippage protection

### Performance Tracking
- **🧠 APEX Oracle**: Analyzes last 24 hours of trades
- Ranks strategies: Champion (75+), Performing (55-75), Testing (40-55), Struggling (30-40), Disabled (<30)
- Automatically reallocates capital to best performers
- Daily review sent via Telegram

## 🛡️ Smart Sell - Avoiding Bad Bids

APEX v3.0 includes an intelligent sell system that prevents losing money to bad bids:

### Key Features
- **Orderbook Depth Analysis**: Calculates expected fill price across multiple levels before executing
- **Dynamic Slippage Protection**: Adjusts tolerance based on position state (profit, loss, near-resolution)
- **Liquidity Checks**: Won't sell into thin orderbooks unless explicitly forced
- **Order Type Selection**: Uses FOK (instant fill) only when the order can fully fill with sufficient USD liquidity within 1–2 bid levels; otherwise uses GTC (patient limit)
- **Expected Fill Preview**: Know what you'll get before you execute

### How It Works

1. **Analyzes Orderbook**: Checks all bid levels to calculate your expected average fill price
2. **Calculates Slippage**: Compares expected fill vs best bid to determine actual slippage
3. **Protects Your Capital**: Rejects sells that would result in unacceptable slippage
4. **Adapts to Conditions**: Uses tighter limits for winning positions, looser for stop-losses

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SELL_DEFAULT_SLIPPAGE_PCT` | 2 | Normal slippage tolerance (%) |
| `SELL_MAX_SLIPPAGE_PCT` | 5 | Maximum slippage for urgent sells (%) |
| `SELL_MIN_LIQUIDITY_USD` | 10 | Minimum liquidity required at best bid ($) |
| `SELL_ORDER_TYPE` | FOK | Default order type (FOK or GTC) |
| `SELL_HIGH_PRICE_SLIPPAGE_PCT` | 0.5 | Slippage for near-$1 positions (%) |
| `SELL_LOSS_SLIPPAGE_PCT` | 5 | Slippage allowed for stop-loss (%) |

### Best Practices (From Polymarket Community)

1. **For liquid markets**: Use FOK with default slippage (2%) - fast and reliable
2. **For thin orderbooks**: Use GTC limit orders - waits for better price
3. **Near resolution ($0.95+)**: Use tight slippage (0.5%) - don't give away profits
4. **Stop-loss situations**: Allow higher slippage (5%) - getting out is priority
5. **Large positions**: Consider splitting into smaller orders

---

# Legacy V2 Documentation

> **Note**: The following documentation is for the legacy V2 system. For APEX v3.0, use the simplified configuration above.

## Quick Start (V2)

```bash
# Minimum config - auto-fetches top 20 traders from leaderboard
PRIVATE_KEY=0x... RPC_URL=https://polygon-rpc.com npm run start:v2

# With preset
STRATEGY_PRESET=aggressive PRIVATE_KEY=0x... RPC_URL=https://polygon-rpc.com npm run start:v2

# With specific addresses to copy
TARGET_ADDRESSES=0xabc...,0xdef... PRIVATE_KEY=0x... RPC_URL=https://polygon-rpc.com npm run start:v2
```

## Environment Variables

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `PRIVATE_KEY` | Wallet private key (with 0x) | `0xabc123...` |
| `RPC_URL` | Polygon RPC endpoint | `https://polygon-rpc.com` |

### Live Trading

| Variable | Description |
|----------|-------------|
| `LIVE_TRADING` | Set to `I_UNDERSTAND_THE_RISKS` to enable real trades. Default is simulated. |

**V1 Alias:** `ARB_LIVE_TRADING`

### Preset Selection

| Variable | Values | Default | Description |
|----------|--------|---------|-------------|
| `STRATEGY_PRESET` | `conservative`, `balanced`, `aggressive` | `balanced` | Strategy parameters |

**V1 Alias:** `PRESET` also works

### Global Position Size

| Variable | Description | Default |
|----------|-------------|---------|
| `MAX_POSITION_USD` | Maximum USD per position (overrides all strategy max sizes) | From preset |

**V1 Alias:** `ARB_MAX_POSITION_USD`

### Reserve System

The reserve system keeps a percentage of your balance protected from regular trades. This ensures you always have funds for hedging and emergencies.

| Variable | Conservative | Balanced | Aggressive | Description |
|----------|--------------|----------|------------|-------------|
| `HEDGING_RESERVE_PCT` | 25 | 20 | 15 | % of balance to keep in reserve |
| `RESERVE_PCT` | 25 | 20 | 15 | Alias for HEDGING_RESERVE_PCT |

**How it works:**
- Regular trades (stack, endgame, copy, arb) can only use available balance (total - reserved)
- Protective trades (hedge, sell signal protection) CAN dip into reserves
- Example: With $100 balance and 20% reserve → Regular trades can use $80, hedging can use full $100

### POL Reserve System

The POL reserve system automatically maintains a minimum POL (Polygon native token) balance for gas fees. When POL drops below the minimum threshold, it automatically swaps USDC to POL via QuickSwap.

| Variable | Default | Description |
|----------|---------|-------------|
| `POL_RESERVE_ENABLED` | `true` | Enable/disable automatic POL rebalancing |
| `POL_RESERVE_TARGET` | `50` | Target POL balance to maintain |
| `MIN_POL_RESERVE` | `50` | Alias for POL_RESERVE_TARGET |
| `POL_RESERVE_MIN` | `10` | Minimum POL before triggering rebalance |
| `POL_RESERVE_MAX_SWAP_USD` | `100` | Maximum USDC to swap per rebalance |
| `POL_RESERVE_CHECK_INTERVAL_MIN` | `5` | How often to check POL balance (minutes) |
| `POL_RESERVE_SLIPPAGE_PCT` | `1` | Slippage tolerance for swap (%) |

**How it works:**
- Every 5 minutes (configurable), the bot checks your POL balance
- If POL < `POL_RESERVE_MIN` (default: 10), it triggers a rebalance
- The bot calculates how much USDC to swap to reach `POL_RESERVE_TARGET` (default: 50)
- Uses QuickSwap DEX to swap USDC → POL with slippage protection
- Alerts via Telegram when rebalancing occurs

**Example:** With 5 POL remaining (< 10 min threshold):
1. Bot detects low POL: "⚠️ POL Low | Current: 5.00 POL | Target: 50 POL"
2. Gets swap quote from QuickSwap
3. Executes swap: "💱 POL Rebalance | Swapping $50 USDC → ~45 POL"
4. Confirms: "✅ POL Swap | Confirmed"

### Dynamic Reserves (Risk-Aware Capital Allocation)

The dynamic reserves system automatically scales your reserve requirements based on position risk analysis. This ensures you always have adequate funds available to cover hedges or handle forced liquidations.

| Variable | Conservative | Balanced | Aggressive | Description |
|----------|--------------|----------|------------|-------------|
| `DYNAMIC_RESERVES_ENABLED` | true | true | true | Enable risk-aware reserve scaling |
| `DYNAMIC_RESERVES_BASE_FLOOR_USD` | 25 | 20 | 15 | Minimum reserve floor in USD |
| `DYNAMIC_RESERVES_EQUITY_PCT` | 8 | 5 | 3 | Reserve as % of equity (input as whole number, e.g., 5 for 5%) |
| `DYNAMIC_RESERVES_MAX_USD` | 250 | 200 | 150 | Maximum reserve cap in USD |
| `DYNAMIC_RESERVES_HEDGE_CAP_USD` | 25 | 50 | 100 | Max per-position reserve (aligns with hedge max) |
| `DYNAMIC_RESERVES_HEDGE_TRIGGER_PCT` | 15 | 20 | 25 | Loss % to trigger hedge-tier reserve |
| `DYNAMIC_RESERVES_CATASTROPHIC_PCT` | 40 | 50 | 60 | Loss % for catastrophic-tier reserve |
| `DYNAMIC_RESERVES_HIGH_WIN_PRICE` | 0.90 | 0.85 | 0.80 | Price threshold for high win probability (low reserve) |

**How it works:**

The system calculates reserves using BOTH percentage-based reserves (existing) AND risk-aware position analysis:

1. **Percentage Reserve**: Scales with drawdown (existing V1 feature)
   - Base: `RESERVE_PCT` of balance
   - +5% at 5% drawdown, +15% at 10% drawdown, +25% at 20% drawdown

2. **Risk-Aware Reserve**: Analyzes each position for risk
   - **Near Resolution (≥99¢)**: No reserve needed - high probability of payout
   - **High Win Probability (≥threshold)**: Minimal reserve (2% of notional, capped at $0.50)
   - **Normal**: Small buffer (10% of notional, capped at $2)
   - **Hedge Trigger (loss ≥ trigger%)**: 50% of notional, capped at hedge cap
   - **Catastrophic (loss ≥ catastrophic%)**: 100% of notional, capped at hedge cap

3. **Effective Reserve**: Takes the HIGHER of percentage-based and risk-aware reserves

**Risk Modes:**
- **RISK_ON**: Balance exceeds effective reserve - normal trading allowed
- **RISK_OFF**: Reserve shortfall - BUY orders blocked (hedging and protective actions still allowed)

**Example:**
With $100 balance, 20% base reserve, and one position at -30% loss (hedge tier):
- Percentage reserve: $20 (20% of $100)
- Risk-aware reserve: $25 base + $12.50 position reserve = $37.50
- Effective reserve: $37.50 (higher of the two)
- Available for regular trades: $62.50

### Optional

| Variable | Default | Description | V1 Alias |
|----------|---------|-------------|----------|
| `INTERVAL_MS` | `5000` | Cycle interval in milliseconds | `FETCH_INTERVAL` (in seconds) |
| `TELEGRAM_BOT_TOKEN` | - | Telegram bot token | `TELEGRAM_TOKEN` |
| `TELEGRAM_CHAT_ID` | - | Telegram chat ID | `TELEGRAM_CHAT` |
| `TELEGRAM_SILENT` | `false` | Send notifications silently (no sound) | - |
| `INITIAL_INVESTMENT_USD` | - | Your initial investment amount for tracking overall P&L return % | - |

### Telegram Notifications

When both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set, you'll receive alerts for:

- **Startup/Shutdown**: Bot started and stopped messages
- **Successful Trades**: BUY and SELL orders that execute successfully (including simulated trades with `[SIM]` tag)
- **Failed Trades**: Order failures with error details
- **Redemptions**: Positions redeemed after market resolution
- **Portfolio Summaries**: Every 5 minutes if you have positions, balance, or completed trades

Set `TELEGRAM_SILENT=true` to receive notifications without sound (uses Telegram's `disable_notification` feature).

### P&L Tracking

Set `INITIAL_INVESTMENT_USD` to track your overall portfolio performance:

```bash
INITIAL_INVESTMENT_USD=200 npm run start:v2
```

This will show in summaries:
- **Overall P&L**: +$25.00 (+12.5%) - gain/loss vs your initial investment
- Calculated as: dollar P&L = (current balance + holdings value - initial investment); return % = (current balance + holdings value - initial investment) / initial investment * 100

---

## V1 → V2 ENV Migration Guide

Your existing V1 ENV variables will work! Here's the mapping:

| V1 Variable | V2 Variable | Notes |
|-------------|-------------|-------|
| `STRATEGY_PRESET` | `STRATEGY_PRESET` | ✅ Same |
| `ARB_LIVE_TRADING=I_UNDERSTAND_THE_RISKS` | `LIVE_TRADING=I_UNDERSTAND_THE_RISKS` | Both work |
| `MAX_POSITION_USD` | `MAX_POSITION_USD` | ✅ Same |
| `INITIAL_INVESTMENT_USD` | `INITIAL_INVESTMENT_USD` | ✅ Same - tracks overall P&L return % |
| `HEDGING_ENABLED` | `HEDGE_ENABLED` | Both work |
| `HEDGING_TRIGGER_LOSS_PCT` | `HEDGE_TRIGGER_PCT` | Both work |
| `HEDGING_MAX_HEDGE_USD` | `HEDGE_MAX_USD` | Both work |
| `HEDGING_ALLOW_EXCEED_MAX` | `HEDGING_ALLOW_EXCEED_MAX` | ✅ Same |
| `HEDGING_ABSOLUTE_MAX_USD` | `HEDGING_ABSOLUTE_MAX_USD` | ✅ Same |
| `HEDGING_RESERVE_PCT` | `RESERVE_PCT` | Both work - keeps % for hedging |
| `STOP_LOSS_PCT` | `STOP_LOSS_PCT` | ✅ Same |
| `STOP_LOSS_MIN_HOLD_SECONDS` | `STOP_LOSS_MIN_HOLD_SECONDS` | ✅ Same |
| `SCALP_TAKE_PROFIT_ENABLED` | `SCALP_ENABLED` | Both work |
| `SCALP_TARGET_PROFIT_PCT` | `SCALP_MIN_PROFIT_PCT` | Both work |
| `SCALP_LOW_PRICE_THRESHOLD` | `SCALP_LOW_PRICE_THRESHOLD` | ✅ Same |
| `SCALP_MIN_PROFIT_USD` | `SCALP_MIN_PROFIT_USD` | ✅ Same |
| `POSITION_STACKING_ENABLED` | `STACK_ENABLED` | Both work |
| `POSITION_STACKING_MIN_GAIN_CENTS` | `STACK_MIN_GAIN_CENTS` | Both work |
| `POSITION_STACKING_MAX_CURRENT_PRICE` | `STACK_MAX_PRICE` | Both work |
| `AUTO_REDEEM_ENABLED` | `REDEEM_ENABLED` | Both work |
| `AUTO_REDEEM_CHECK_INTERVAL_MS` | `REDEEM_INTERVAL_MIN` | V1 is ms, V2 is minutes |
| `AUTO_REDEEM_MIN_POSITION_USD` | `AUTO_REDEEM_MIN_POSITION_USD` | ✅ Same |
| `TARGET_ADDRESSES` | `COPY_ADDRESSES` | Both work |
| `MONITOR_ADDRESSES` | `COPY_ADDRESSES` | Both work |
| `TRADE_MULTIPLIER` | `COPY_MULTIPLIER` | Both work |
| `MIN_TRADE_SIZE_USD` | `COPY_MIN_USD` | Both work |
| `MIN_BUY_PRICE` | `COPY_MIN_BUY_PRICE` | Both work - skip BUYs below this price |
| `TELEGRAM_BOT_TOKEN` | `TELEGRAM_BOT_TOKEN` | ✅ Same |
| `TELEGRAM_CHAT_ID` | `TELEGRAM_CHAT_ID` | ✅ Same |
| `LEADERBOARD_LIMIT` | `LEADERBOARD_LIMIT` | ✅ Same |
| `ARB_ENABLED` | `ARB_ENABLED` | ✅ Same |
| `ARB_MAX_USD` | `ARB_MAX_USD` | ✅ Same |
| `ARB_MIN_EDGE_BPS` | `ARB_MIN_EDGE_BPS` | ✅ Same |
| `ARB_MIN_BUY_PRICE` | `ARB_MIN_BUY_PRICE` | ✅ Same (for arbitrage) |

### Example: Your V1 Config Works As-Is

```bash
# This V1 config works perfectly in V2:
STRATEGY_PRESET=aggressive
MAX_POSITION_USD=5
HEDGING_ALLOW_EXCEED_MAX=true
HEDGING_ABSOLUTE_MAX_USD=10
SCALP_LOW_PRICE_THRESHOLD=0
LIVE_TRADING=I_UNDERSTAND_THE_RISKS
```

---

## Strategy Configuration

All strategies can be enabled/disabled and fine-tuned via ENV variables.
If not set, values come from the selected preset.

### Strategy Priority (Conflict Resolution)

**Each position gets ONE action per cycle.** Strategies are evaluated in priority order - once a position is acted upon, it's skipped by all other strategies for that cycle.

| Priority | Strategy | Condition | Action | Why this priority? |
|----------|----------|-----------|--------|-------------------|
| 1 | **AutoSell** | price >= $0.99 | SELL | Guaranteed profit, free capital |
| 2 | **Hedge** | loss >= trigger% | BUY opposite | Try to RECOVER before giving up |
| 3 | **StopLoss** | loss >= max% AND hedge disabled | SELL | Only if NOT hedging |
| 4 | **Scalp** | profit >= min% | SELL | Lock in gains |
| 5 | **Stack** | gain >= minCents | BUY more | Add to winners |
| 6 | **Endgame** | price 85-99¢ | BUY more | Ride to finish |

**Key insight:** Hedge runs BEFORE stop-loss because:
- **Hedge** = try to RECOVER (buy opposite side, wait for resolution)  
- **Stop-loss** = SURRENDER (sell at a loss and exit)
- If hedging is enabled, stop-loss is redundant (hedge guarantees recovery)

**Example:** Position is down 25% and at $0.99 price
- AutoSell triggers first (price >= threshold) → SELLS
- Hedge, StopLoss never evaluate this position

**Example:** Position is down 30% with hedge enabled
- AutoSell: No (price not near $1)
- Hedge: Yes (30% > 20% trigger) → BUYS opposite side
- StopLoss: Skipped (hedge already acting)

This prevents conflicting actions like:
- ❌ StopLoss selling what Hedge would have protected
- ❌ Scalp and AutoSell both trying to sell
- ❌ Stack buying right before StopLoss sells

---

## What V2 Removes (Redundant)

V2 removes complexity that wasn't needed:

| Removed | Why | Replacement |
|---------|-----|-------------|
| **Sell Signal Protection** | Hedge already monitors P&L every cycle | Hedge strategy |
| **OnChainExit** | Same as Redeem | Redeem strategy |
| **Mempool Monitor** | Unreliable, API polling works better | API polling |
| **PositionTracker caching** | Caused stale data bugs | Fresh API with 30s cache |
| **Orchestrator** | Overly complex | Simple main() loop |

---

### AutoSell - Sell positions near $1

Frees up capital from positions that are nearly resolved.

| Variable | Conservative | Balanced | Aggressive | Description |
|----------|--------------|----------|------------|-------------|
| `AUTO_SELL_ENABLED` | true | true | true | Enable/disable |
| `AUTO_SELL_THRESHOLD` | 0.98 | 0.99 | 0.995 | Price to trigger sell (0-1) |
| `AUTO_SELL_MIN_HOLD_SEC` | 60 | 60 | 30 | Min hold time before selling |

### StopLoss - Prevent catastrophic losses

Sells positions when loss exceeds threshold.

| Variable | Conservative | Balanced | Aggressive | Description |
|----------|--------------|----------|------------|-------------|
| `STOP_LOSS_ENABLED` | true | true | true | Enable/disable |
| `STOP_LOSS_PCT` | 20 | 25 | 35 | Max loss % before sell |
| `STOP_LOSS_MIN_HOLD_SECONDS` | 120 | 60 | 30 | Min hold time before stop loss triggers |

### Hedge - Protect losing positions

Buys opposite outcome when position is down.

| Variable | Conservative | Balanced | Aggressive | Description |
|----------|--------------|----------|------------|-------------|
| `HEDGE_ENABLED` | true | true | true | Enable/disable |
| `HEDGE_TRIGGER_PCT` | 15 | 20 | 25 | Loss % to trigger hedge |
| `HEDGE_MAX_USD` | 15 | 25 | 50 | Max USD per hedge (when allowExceedMax=false) |
| `HEDGING_ALLOW_EXCEED_MAX` | false | false | true | When true, use absoluteMaxUsd |
| `HEDGING_ABSOLUTE_MAX_USD` | 25 | 50 | 100 | Max USD when allowExceedMax=true |

**V1 Aliases:** `HEDGING_ENABLED`, `HEDGING_TRIGGER_LOSS_PCT`, `HEDGING_MAX_HEDGE_USD`

### Scalp - Take profits

Sells winning positions to lock in gains.

| Variable | Conservative | Balanced | Aggressive | Description |
|----------|--------------|----------|------------|-------------|
| `SCALP_ENABLED` | true | true | true | Enable/disable |
| `SCALP_MIN_PROFIT_PCT` | 15 | 10 | 5 | Min profit % to take |
| `SCALP_MIN_GAIN_CENTS` | 8 | 5 | 3 | Min gain in cents |
| `SCALP_LOW_PRICE_THRESHOLD` | 0 | 0 | 0 | Skip positions with entry below this (0=disabled) |
| `SCALP_MIN_PROFIT_USD` | 2.0 | 1.0 | 0.5 | Min profit in USD to take |

**V1 Aliases:** `SCALP_TAKE_PROFIT_ENABLED`, `SCALP_TARGET_PROFIT_PCT`

### Stack - Double down on winners

Buys more of positions that are winning (once per position).

| Variable | Conservative | Balanced | Aggressive | Description |
|----------|--------------|----------|------------|-------------|
| `STACK_ENABLED` | true | true | true | Enable/disable |
| `STACK_MIN_GAIN_CENTS` | 25 | 20 | 15 | Min gain to trigger |
| `STACK_MAX_USD` | 15 | 25 | 50 | USD amount per stack |
| `STACK_MAX_PRICE` | 0.90 | 0.95 | 0.97 | Max price to stack at |

**V1 Aliases:** `POSITION_STACKING_ENABLED`, `POSITION_STACKING_MIN_GAIN_CENTS`, `POSITION_STACKING_MAX_CURRENT_PRICE`

### Endgame - Buy high-confidence positions

Adds to positions near resolution (high probability of paying $1).

| Variable | Conservative | Balanced | Aggressive | Description |
|----------|--------------|----------|------------|-------------|
| `ENDGAME_ENABLED` | true | true | true | Enable/disable |
| `ENDGAME_MIN_PRICE` | 0.90 | 0.85 | 0.80 | Min price for endgame |
| `ENDGAME_MAX_PRICE` | 0.98 | 0.99 | 0.995 | Max price for endgame |
| `ENDGAME_MAX_USD` | 15 | 25 | 50 | Max USD per buy |

### Redeem - Claim resolved positions

Automatically redeems resolved markets for USDC.

| Variable | Conservative | Balanced | Aggressive | Description |
|----------|--------------|----------|------------|-------------|
| `REDEEM_ENABLED` | true | true | true | Enable/disable |
| `REDEEM_INTERVAL_MIN` | 15 | 15 | 10 | Minutes between checks |
| `AUTO_REDEEM_MIN_POSITION_USD` | 0.10 | 0.10 | 0.01 | Skip tiny positions |

**V1 Aliases:** `AUTO_REDEEM_ENABLED`, `AUTO_REDEEM_CHECK_INTERVAL_MS`

### Arbitrage - Buy when YES + NO < $1

| Variable | Conservative | Balanced | Aggressive | Description |
|----------|--------------|----------|------------|-------------|
| `ARB_ENABLED` | true | true | true | Enable/disable |
| `ARB_MAX_USD` | 15 | 25 | 50 | Max USD per arbitrage |
| `ARB_MIN_EDGE_BPS` | 50 | 30 | 20 | Min edge in basis points |

---

## Copy Trading

### Auto-Fetch from Leaderboard

If no addresses are specified, V2 automatically fetches top traders from Polymarket leaderboard:

| Variable | Default | Description |
|----------|---------|-------------|
| `LEADERBOARD_LIMIT` | 20 | Number of top traders to fetch (max 50) |

### Manual Address List

Override with your own addresses:

| Variable | Description |
|----------|-------------|
| `TARGET_ADDRESSES` | Comma-separated addresses to copy |

**V1 Aliases:** `COPY_ADDRESSES`, `MONITOR_ADDRESSES`

### Copy Trading Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `COPY_MULTIPLIER` | 1.0 | Size multiplier for copied trades |
| `COPY_MIN_USD` | 5 | Min trade size to copy |
| `COPY_MAX_USD` | 100 | Max trade size per copy |
| `MIN_BUY_PRICE` | 0.50 | Don't copy BUYs below this price ($0.50 = 50¢) |

**V1 Aliases:** `TRADE_MULTIPLIER`, `MIN_TRADE_SIZE_USD`, `COPY_MIN_BUY_PRICE`

---

## Preset Comparison

| Setting | Conservative | Balanced | Aggressive |
|---------|--------------|----------|------------|
| **Risk Level** | Low | Medium | High |
| **Position Sizes** | $15 | $25 | $50 |
| **Stop Loss** | -20% | -25% | -35% |
| **Hedge Trigger** | -15% | -20% | -25% |
| **Take Profit** | +15% | +10% | +5% |
| **Best For** | Capital preservation | General trading | Maximum growth |

---

## Examples

### Your existing V1 config
```bash
STRATEGY_PRESET=aggressive \
MAX_POSITION_USD=5 \
HEDGING_ALLOW_EXCEED_MAX=true \
HEDGING_ABSOLUTE_MAX_USD=10 \
SCALP_LOW_PRICE_THRESHOLD=0 \
LIVE_TRADING=I_UNDERSTAND_THE_RISKS \
PRIVATE_KEY=0x... \
RPC_URL=https://polygon-rpc.com \
npm run start:v2
```

### Conservative with custom hedge
```bash
STRATEGY_PRESET=conservative \
HEDGE_MAX_USD=20 \
PRIVATE_KEY=0x... \
RPC_URL=https://polygon-rpc.com \
npm run start:v2
```

### Copy top 10 traders with Telegram alerts
```bash
LEADERBOARD_LIMIT=10 \
TELEGRAM_BOT_TOKEN=123456:ABC... \
TELEGRAM_CHAT_ID=-100123456 \
PRIVATE_KEY=0x... \
RPC_URL=https://polygon-rpc.com \
npm run start:v2
```

### Copy specific addresses
```bash
TARGET_ADDRESSES=0xabc...,0xdef... \
COPY_MULTIPLIER=0.5 \
PRIVATE_KEY=0x... \
RPC_URL=https://polygon-rpc.com \
npm run start:v2
```

---

## Strategy Execution Order

Strategies run in this order each cycle:

1. **Copy Trades** - Check for new trades from tracked addresses
2. **AutoSell** - Free capital from near-$1 positions
3. **Hedge** - Protect from losses (before giving up with stop-loss)
4. **StopLoss** - Exit if hedge disabled and loss too large
5. **Scalp** - Take profits on winners
6. **Stack** - Double down on winners
7. **Endgame** - Buy high-confidence positions
8. **Arbitrage** - Buy when YES + NO < $1
9. **Redeem** - Claim resolved positions

---

## Switching Between V1 and V2

```bash
# Run V2 (new simple system)
USE_V2=true npm start
# or
npm run start:v2

# Run V1 (legacy system)
USE_V2=false npm start
# or  
npm run start:v1
```

---

## Simple Rules

V2 uses simple, direct logic. If condition is met → execute action:

| Strategy | Condition | Action |
|----------|-----------|--------|
| AutoSell | price >= threshold | SELL |
| StopLoss | loss >= maxLossPct | SELL |
| Hedge | loss >= triggerPct | BUY opposite |
| Scalp | profit >= minProfitPct AND gain >= minGainCents | SELL |
| Stack | gain >= minGainCents AND price <= maxPrice AND not stacked before | BUY more |
| Endgame | price between min and max | BUY more |
| Arbitrage | YES + NO < $1 | BUY both |
| Redeem | position resolved | REDEEM |

No complex internal logic or cross-strategy dependencies. What you set is what it does.

## 🔄 Selling & Exit Strategies

### Understanding Sell Pathways

The bot uses multiple pathways to exit positions, each with different triggers and price protection levels:

1. **Strategy-Based Sells** - Blitz, Command, Guardian, Ratchet, Ladder, Reaper
2. **Emergency Sells** - CONSERVATIVE/MODERATE/NUCLEAR modes for low-balance situations
3. **Recovery Mode** - Automatic liquidation when balance drops critically low
4. **Scavenger Mode** - Special handling during low-liquidity periods

📚 **[Complete Selling Logic Documentation](docs/SELLING_LOGIC.md)**

### Common Sell Error Messages

#### ❌ "Price too low: 1¢ < 67¢"

**Meaning:** Best bid (1¢) is below minimum acceptable price (67¢)

**Common causes:**
- Standard sell: Uses 1% slippage tolerance (won't sell below 66¢ if entry was 67¢)
- Emergency CONSERVATIVE: Won't sell below 50% of entry (34¢)
- Emergency MODERATE: Won't sell below 20% of entry (13¢)

**Solutions:**
- Wait for better liquidity
- Switch to MODERATE mode: `EMERGENCY_SELL_MODE=MODERATE`
- Use NUCLEAR mode if desperate: `EMERGENCY_SELL_MODE=NUCLEAR` (⚠️ sells at ANY price)

#### ❌ "No bids available"

**Meaning:** Orderbook has zero buyers

**Solutions:**
- Wait for market activity
- Check if market is resolved (use redeem instead)
- Consider NUCLEAR mode if you need liquidity immediately

### Emergency Sell Modes

Configure emergency behavior when balance drops below threshold:

```bash
# In .env
EMERGENCY_SELL_MODE=CONSERVATIVE  # CONSERVATIVE | MODERATE | NUCLEAR
EMERGENCY_BALANCE_THRESHOLD=5     # Activate when balance < $5
```

| Mode | Protection | Example |
|------|------------|---------|
| **CONSERVATIVE** | Won't sell below 50% of entry | 67¢ entry → min 34¢ |
| **MODERATE** | Won't sell below 20% of entry | 67¢ entry → min 13¢ |
| **NUCLEAR** | No protection - sells at ANY price | 67¢ entry → will sell at 1¢ ⚠️ |

📚 **[Emergency Sells Guide](docs/EMERGENCY_SELLS.md)**

### Troubleshooting Sell Issues

**Problem:** Positions won't sell, keep showing "Price too low"

**Diagnosis:**
1. Check which sell pathway is active (look for log indicators)
2. Check your emergency mode configuration
3. Verify orderbook has bids (buyers)
4. Review current vs minimum acceptable price

**Quick Fix:**
```bash
# Force sell everything (⚠️ accepts massive losses)
EMERGENCY_SELL_MODE=NUCLEAR
docker-compose restart
```

📚 **[Complete Troubleshooting Guide](docs/SELLING_LOGIC.md#troubleshooting-guide)**

---

## VPN Configuration (Geo-Blocked Regions)

If you're in a geo-blocked region, you'll need a VPN to access Polymarket APIs. The bot supports both WireGuard and OpenVPN.

### WireGuard DNS in Docker (Alpine Linux)

**Setting `WIREGUARD_DNS` is optional and now fully supported in Alpine containers.** The bot automatically handles DNS configuration using PostUp/PostDown scripts instead of resolvconf.

**What happens internally:**
- The bot detects it's running in a container
- Instead of using the `DNS` directive (which requires resolvconf), it generates PostUp/PostDown scripts
- PostUp prepends your VPN DNS servers to `/etc/resolv.conf` while preserving Docker's DNS entries
- PostDown restores the original DNS configuration when the VPN disconnects

**Recommendation:** You can safely omit `WIREGUARD_DNS` because Docker manages DNS automatically. However, if you need custom DNS servers (e.g., for privacy or specific resolver requirements), setting `WIREGUARD_DNS` will work correctly.

### WireGuard Setup

```bash
# Minimal WireGuard config
WIREGUARD_ENABLED=true
WIREGUARD_ADDRESS=10.0.0.2/24
WIREGUARD_PRIVATE_KEY=your_private_key
WIREGUARD_PEER_PUBLIC_KEY=peer_public_key  
WIREGUARD_PEER_ENDPOINT=vpn.example.com:51820
WIREGUARD_ALLOWED_IPS=0.0.0.0/0
# WIREGUARD_DNS=1.1.1.1  # Optional - Docker manages DNS, but custom DNS is supported
```

### OpenVPN Setup

```bash
OPENVPN_ENABLED=true
OPENVPN_CONFIG="<full .ovpn config content>"
# Or mount a config file:
OVPN_CONFIG=/path/to/client.ovpn
```

### VPN Bypass Options

By default, RPC traffic bypasses VPN for speed:

| Variable | Default | Description |
|----------|---------|-------------|
| `VPN_BYPASS_RPC` | `true` | Route blockchain RPC outside VPN |
| `VPN_BYPASS_POLYMARKET_READS` | `true` | Route read-only Polymarket APIs outside VPN |

**Note:** Order submissions always go through VPN to avoid geo-blocking.
