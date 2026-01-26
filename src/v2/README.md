# Polymarket Trading Bot V2

Simple, efficient trading bot with preset-based configuration.

## Quick Start

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

### Optional

| Variable | Default | Description | V1 Alias |
|----------|---------|-------------|----------|
| `INTERVAL_MS` | `5000` | Cycle interval in milliseconds | `FETCH_INTERVAL` (in seconds) |
| `TELEGRAM_BOT_TOKEN` | - | Telegram bot token | `TELEGRAM_TOKEN` |
| `TELEGRAM_CHAT_ID` | - | Telegram chat ID | `TELEGRAM_CHAT` |

---

## V1 → V2 ENV Migration Guide

Your existing V1 ENV variables will work! Here's the mapping:

| V1 Variable | V2 Variable | Notes |
|-------------|-------------|-------|
| `STRATEGY_PRESET` | `STRATEGY_PRESET` | ✅ Same |
| `ARB_LIVE_TRADING=I_UNDERSTAND_THE_RISKS` | `LIVE_TRADING=I_UNDERSTAND_THE_RISKS` | Both work |
| `MAX_POSITION_USD` | `MAX_POSITION_USD` | ✅ Same |
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
| `TELEGRAM_BOT_TOKEN` | `TELEGRAM_BOT_TOKEN` | ✅ Same |
| `TELEGRAM_CHAT_ID` | `TELEGRAM_CHAT_ID` | ✅ Same |
| `LEADERBOARD_LIMIT` | `LEADERBOARD_LIMIT` | ✅ Same |
| `ARB_ENABLED` | `ARB_ENABLED` | ✅ Same |
| `ARB_MAX_USD` | `ARB_MAX_USD` | ✅ Same |
| `ARB_MIN_EDGE_BPS` | `ARB_MIN_EDGE_BPS` | ✅ Same |

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

**V1 Aliases:** `TRADE_MULTIPLIER`, `MIN_TRADE_SIZE_USD`

### Sell Signal Protection

When a tracked trader SELLS a position you also hold:
- If you're losing > 40%: Stop loss (sell immediately)
- If you're losing 15-40%: Hedge (buy opposite side)
- If you're profitable: Hold (ignore their sell)

This is automatic when copy trading is enabled.

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
2. **Sell Signal Protection** - React to tracked trader sells
3. **AutoSell** - Free capital from near-$1 positions
4. **StopLoss** - Protect from catastrophic losses  
5. **Hedge** - Protect from moderate losses
6. **Scalp** - Take profits on winners
7. **Stack** - Double down on winners
8. **Endgame** - Buy high-confidence positions
9. **Arbitrage** - Buy when YES + NO < $1
10. **Redeem** - Claim resolved positions (runs on separate interval)

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
