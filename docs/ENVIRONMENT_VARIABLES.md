# Environment Variables Guide

This document provides a comprehensive guide to all environment variables supported by the Polymarket Sniper Bot. Use these to customize the bot's behavior for your trading style and risk tolerance.

## Table of Contents

1. [Required Variables](#required-variables)
2. [Trading Configuration](#trading-configuration)
3. [Whale Tracking](#whale-tracking)
4. [Market Scanner](#market-scanner)
5. [Dynamic Reserves](#dynamic-reserves)
6. [Liquidation Mode](#liquidation-mode)
7. [Order Types & Execution](#order-types--execution)
8. [POL (Gas) Management](#pol-gas-management)
9. [Telegram Notifications](#telegram-notifications)
10. [On-Chain Monitoring](#on-chain-monitoring)
11. [Example Configurations](#example-configurations)

---

## Required Variables

These must be set for the bot to function:

| Variable | Description | Example |
|----------|-------------|---------|
| `PRIVATE_KEY` | Your wallet's private key (keep secret!) | `0xabc123...` |
| `LIVE_TRADING` | Set to `I_UNDERSTAND_THE_RISKS` to enable live trading | `I_UNDERSTAND_THE_RISKS` |

### Getting Your Private Key

1. **MetaMask**: Settings → Security & Privacy → Export Private Key
2. **Never share this with anyone**
3. **Use a dedicated trading wallet** (not your main wallet)

---

## Trading Configuration

### Bet Size

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_TRADE_USD` | `25` | Maximum trade size per position in USD |

**Guidance:**
- **Conservative**: $10-25 per trade
- **Moderate**: $25-50 per trade
- **Aggressive**: $50-100 per trade

⚠️ **Warning**: Larger trades require more liquidity. If you set this too high, your orders may not fill.

### RPC Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `RPC_URL` | `https://polygon-rpc.com` | Polygon RPC endpoint |

**Recommended RPC Providers:**
- **Infura** (recommended for on-chain monitoring): `https://polygon-mainnet.infura.io/v3/YOUR_KEY`
- **Alchemy**: `https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY`
- **Public fallback**: `https://polygon-rpc.com`

---

## Whale Tracking

The bot follows top Polymarket traders (whales) and copies their trades.

| Variable | Default | Description |
|----------|---------|-------------|
| `WHALE_TRADE_USD` | `500` | Minimum trade size to consider as "whale trade" |
| `COPY_ANY_WHALE_BUY` | `false` | If `true`, copy ANY whale buy immediately without bias confirmation |

### Whale Tracking Modes

**Conservative Mode** (default):
```env
COPY_ANY_WHALE_BUY=false
```
- Requires $300+ in whale flow AND 3+ trades in same direction
- More selective, fewer trades, higher confidence
- Best for: Beginners, lower risk tolerance

**Aggressive Mode**:
```env
COPY_ANY_WHALE_BUY=true
WHALE_TRADE_USD=500
```
- Copies ANY whale buy ≥ $500 immediately
- More trades, faster execution, follows momentum
- Best for: Experienced traders, higher risk tolerance

**High-Volume Mode**:
```env
COPY_ANY_WHALE_BUY=true
WHALE_TRADE_USD=250
```
- Copies smaller whale trades
- Maximum churn, many trades
- Best for: High-frequency trading, liquid markets

---

## Market Scanner

The market scanner finds active/trending markets to trade even when no whale signals exist.

| Variable | Default | Description |
|----------|---------|-------------|
| `SCAN_ACTIVE_MARKETS` | `true` | Enable scanning for active markets |
| `SCAN_MIN_VOLUME_USD` | `10000` | Minimum 24h volume to consider a market |
| `SCAN_TOP_N_MARKETS` | `20` | Number of top markets to track |
| `SCAN_INTERVAL_SECONDS` | `300` | How often to refresh market scan (5 min default) |

### When to Adjust

**More Selective (quality over quantity)**:
```env
SCAN_MIN_VOLUME_USD=50000
SCAN_TOP_N_MARKETS=10
```

**Maximum Opportunity Discovery**:
```env
SCAN_MIN_VOLUME_USD=5000
SCAN_TOP_N_MARKETS=30
SCAN_INTERVAL_SECONDS=180
```

**Disable Scanner (whale-only mode)**:
```env
SCAN_ACTIVE_MARKETS=false
```

---

## Dynamic Reserves

The dynamic reserve system automatically adjusts how much capital to keep in reserve based on:
- Missed trading opportunities (too much reserve → lower it)
- Missed hedges (not enough reserve → raise it)

| Variable | Default | Description |
|----------|---------|-------------|
| `DYNAMIC_RESERVES_ENABLED` | `true` | Enable dynamic reserve calculation |
| `RESERVE_ADAPTATION_RATE` | `0.1` | How quickly reserves adapt (0-1, 10% default) |
| `MISSED_OPPORTUNITY_WEIGHT` | `0.5` | Weight for missed trade opportunities |
| `HEDGE_COVERAGE_WEIGHT` | `0.5` | Weight for hedge coverage needs |
| `MAX_RESERVE_FRACTION` | `0.5` | Maximum reserve as fraction of balance (50%) |

### Understanding Dynamic Reserves

The base reserve is 25% of your balance. Dynamic reserves adjust this based on:

1. **Missed Opportunities**: If you're missing trades due to insufficient balance, reserves decrease to free up capital
2. **Missed Hedges**: If positions need hedging but you can't afford it, reserves increase

**Conservative (protect capital)**:
```env
DYNAMIC_RESERVES_ENABLED=true
RESERVE_ADAPTATION_RATE=0.05
MAX_RESERVE_FRACTION=0.6
HEDGE_COVERAGE_WEIGHT=0.7
MISSED_OPPORTUNITY_WEIGHT=0.3
```

**Aggressive (maximize trading)**:
```env
DYNAMIC_RESERVES_ENABLED=true
RESERVE_ADAPTATION_RATE=0.15
MAX_RESERVE_FRACTION=0.35
HEDGE_COVERAGE_WEIGHT=0.3
MISSED_OPPORTUNITY_WEIGHT=0.7
```

**Fixed Reserves (disable dynamic)**:
```env
DYNAMIC_RESERVES_ENABLED=false
```

---

## Liquidation Mode

Force the bot to sell existing positions on startup.

| Variable | Default | Description |
|----------|---------|-------------|
| `LIQUIDATION_MODE` | `off` | `off` = normal trading, `losing` = sell losing positions, `all` = sell everything |
| `LIQUIDATION_MAX_SLIPPAGE_PCT` | `10` | Maximum slippage allowed during liquidation (%) |
| `LIQUIDATION_POLL_INTERVAL_MS` | `1000` | Poll interval during liquidation (ms) |

### Liquidation Modes

**Cut Your Losses** (sell only losing positions):
```env
LIQUIDATION_MODE=losing
```
- Only sells positions with negative P&L
- Keeps winning positions to potentially ride them up
- After all losers sold, automatically resumes normal trading

**Exit Everything**:
```env
LIQUIDATION_MODE=all
```
- Sells ALL positions regardless of P&L
- Complete portfolio liquidation
- After all positions sold, automatically resumes normal trading

**Emergency Exit** (with higher slippage):
```env
LIQUIDATION_MODE=all
LIQUIDATION_MAX_SLIPPAGE_PCT=15
```

⚠️ **Important**: After liquidation completes, the bot automatically returns to normal trading mode - no restart needed!

**Legacy Support**: `FORCE_LIQUIDATION=true` still works and maps to `LIQUIDATION_MODE=all`

---

## Order Types & Execution

Control how orders are placed.

| Variable | Default | Description |
|----------|---------|-------------|
| `ORDER_TYPE` | `FOK` | Master order type for all orders (`FOK` or `GTC`) |
| `BUY_ORDER_TYPE` | (uses ORDER_TYPE) | Order type for buy orders |
| `SELL_ORDER_TYPE` | (uses ORDER_TYPE) | Order type for sell orders |
| `BUY_DEFAULT_SLIPPAGE_PCT` | `2` | Default slippage for buys (%) |
| `BUY_MAX_SLIPPAGE_PCT` | `5` | Maximum slippage for buys (%) |
| `SELL_DEFAULT_SLIPPAGE_PCT` | `2` | Default slippage for sells (%) |
| `SELL_MAX_SLIPPAGE_PCT` | `5` | Maximum slippage for sells (%) |

### Order Type Explanation

**FOK (Fill-Or-Kill)** - Default:
- Fills immediately and completely, or cancels
- Best for fast-moving markets
- May miss opportunities if price moves

**GTC (Good-Til-Cancelled)**:
- Posts to orderbook and waits
- Gets specific price
- May never fill if price moves away

**Recommended Configurations**:

**Fast Execution (default)**:
```env
ORDER_TYPE=FOK
BUY_DEFAULT_SLIPPAGE_PCT=2
SELL_DEFAULT_SLIPPAGE_PCT=2
```

**Price-Sensitive**:
```env
ORDER_TYPE=GTC
BUY_GTC_EXPIRATION_SECONDS=3600
SELL_GTC_EXPIRATION_SECONDS=86400
```

**Hybrid (fast buys, patient sells)**:
```env
BUY_ORDER_TYPE=FOK
SELL_ORDER_TYPE=GTC
```

---

## POL (Gas) Management

Auto-refill POL for gas fees.

| Variable | Default | Description |
|----------|---------|-------------|
| `POL_RESERVE_TARGET` | `50` | Target POL when refilling |
| `POL_RESERVE_MIN` | `0.5` | Trigger refill when POL falls below this |
| `POL_RESERVE_MAX_SWAP_USD` | `10` | Maximum USDC to swap per refill |
| `POL_RESERVE_CHECK_INTERVAL_MIN` | `5` | Check POL balance every N minutes |

### Guidance

**Default (minimal gas cost)**:
```env
POL_RESERVE_TARGET=50
POL_RESERVE_MIN=0.5
POL_RESERVE_MAX_SWAP_USD=10
```

**High-Frequency Trading**:
```env
POL_RESERVE_TARGET=100
POL_RESERVE_MIN=1
POL_RESERVE_MAX_SWAP_USD=20
POL_RESERVE_CHECK_INTERVAL_MIN=2
```

---

## Telegram Notifications

Get trade alerts on Telegram.

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Your chat ID (get from @userinfobot) |

### Setup Steps

1. Message @BotFather on Telegram
2. Create a new bot with `/newbot`
3. Copy the token → `TELEGRAM_BOT_TOKEN`
4. Message @userinfobot to get your chat ID → `TELEGRAM_CHAT_ID`

```env
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrsTUVwxyz
TELEGRAM_CHAT_ID=123456789
```

---

## On-Chain Monitoring

Monitor blockchain for whale trades (faster than API polling).

| Variable | Default | Description |
|----------|---------|-------------|
| `ONCHAIN_MONITOR_ENABLED` | `true` | Enable on-chain whale monitoring |
| `INFURA_TIER` | `core` | Your Infura plan (`core`, `developer`, `team`, `growth`) |

### Infura Setup

1. Create account at infura.io
2. Create a new project for Polygon
3. Copy your RPC URL (includes API key)

```env
RPC_URL=https://polygon-mainnet.infura.io/v3/YOUR_API_KEY
ONCHAIN_MONITOR_ENABLED=true
INFURA_TIER=core
```

**Rate Limit by Tier**:
- `core` (free): 100k requests/day
- `developer` ($50/mo): 200k requests/day
- `team` ($225/mo): 2M requests/day
- `growth` (enterprise): unlimited

---

## Example Configurations

### 1. Conservative Beginner

Minimal risk, learn the system:

```env
# Required
PRIVATE_KEY=your_key_here
LIVE_TRADING=I_UNDERSTAND_THE_RISKS

# Trading
MAX_TRADE_USD=10

# Whale Tracking - Conservative
COPY_ANY_WHALE_BUY=false
WHALE_TRADE_USD=1000

# Market Scanner - Selective
SCAN_ACTIVE_MARKETS=true
SCAN_MIN_VOLUME_USD=50000
SCAN_TOP_N_MARKETS=10

# Reserves - Conservative
DYNAMIC_RESERVES_ENABLED=true
MAX_RESERVE_FRACTION=0.5
HEDGE_COVERAGE_WEIGHT=0.7

# Notifications
TELEGRAM_BOT_TOKEN=your_token
TELEGRAM_CHAT_ID=your_chat_id
```

### 2. Balanced Trader

Good balance of activity and safety:

```env
# Required
PRIVATE_KEY=your_key_here
LIVE_TRADING=I_UNDERSTAND_THE_RISKS

# Trading
MAX_TRADE_USD=25

# Whale Tracking - Balanced
COPY_ANY_WHALE_BUY=false
WHALE_TRADE_USD=500

# Market Scanner - Active
SCAN_ACTIVE_MARKETS=true
SCAN_MIN_VOLUME_USD=10000
SCAN_TOP_N_MARKETS=20

# Reserves - Dynamic
DYNAMIC_RESERVES_ENABLED=true
RESERVE_ADAPTATION_RATE=0.1

# RPC
RPC_URL=https://polygon-mainnet.infura.io/v3/YOUR_KEY
ONCHAIN_MONITOR_ENABLED=true
```

### 3. Aggressive Trader

Maximum churn, higher risk:

```env
# Required
PRIVATE_KEY=your_key_here
LIVE_TRADING=I_UNDERSTAND_THE_RISKS

# Trading
MAX_TRADE_USD=50

# Whale Tracking - Aggressive
COPY_ANY_WHALE_BUY=true
WHALE_TRADE_USD=250

# Market Scanner - Maximum
SCAN_ACTIVE_MARKETS=true
SCAN_MIN_VOLUME_USD=5000
SCAN_TOP_N_MARKETS=30
SCAN_INTERVAL_SECONDS=180

# Reserves - Trading-focused
DYNAMIC_RESERVES_ENABLED=true
RESERVE_ADAPTATION_RATE=0.15
MAX_RESERVE_FRACTION=0.35
MISSED_OPPORTUNITY_WEIGHT=0.7
HEDGE_COVERAGE_WEIGHT=0.3

# Fast execution
BUY_DEFAULT_SLIPPAGE_PCT=3
SELL_DEFAULT_SLIPPAGE_PCT=3

# RPC - Premium for speed
RPC_URL=https://polygon-mainnet.infura.io/v3/YOUR_KEY
INFURA_TIER=developer
ONCHAIN_MONITOR_ENABLED=true
```

### 4. Simulation Mode (No Risk)

Test without real money:

```env
# Required
PRIVATE_KEY=your_key_here
# LIVE_TRADING not set = simulation mode

# Can use any settings - no real trades executed
MAX_TRADE_USD=100
COPY_ANY_WHALE_BUY=true
SCAN_ACTIVE_MARKETS=true
```

---

## Troubleshooting

### Bot not trading

1. Check `LIVE_TRADING=I_UNDERSTAND_THE_RISKS` is set
2. Ensure you have USDC balance
3. Verify RPC connection works

### Missing whale signals

1. Increase `WHALE_TRADE_USD` sensitivity: `WHALE_TRADE_USD=250`
2. Enable aggressive mode: `COPY_ANY_WHALE_BUY=true`
3. Check RPC is responsive

### Too many missed trades

1. Enable dynamic reserves: `DYNAMIC_RESERVES_ENABLED=true`
2. Increase missed opportunity weight: `MISSED_OPPORTUNITY_WEIGHT=0.7`
3. Lower max reserve: `MAX_RESERVE_FRACTION=0.35`

### Orders not filling

1. Increase slippage: `BUY_DEFAULT_SLIPPAGE_PCT=3`
2. Lower trade size: `MAX_TRADE_USD=15`
3. Try GTC orders: `ORDER_TYPE=GTC`

---

## Quick Reference

| Category | Key Variables |
|----------|--------------|
| **Getting Started** | `PRIVATE_KEY`, `LIVE_TRADING`, `MAX_TRADE_USD` |
| **Whale Tracking** | `WHALE_TRADE_USD`, `COPY_ANY_WHALE_BUY` |
| **Market Scanner** | `SCAN_ACTIVE_MARKETS`, `SCAN_MIN_VOLUME_USD` |
| **Reserves** | `DYNAMIC_RESERVES_ENABLED`, `MAX_RESERVE_FRACTION` |
| **Liquidation** | `FORCE_LIQUIDATION`, `LIQUIDATION_MAX_SLIPPAGE_PCT` |
| **Notifications** | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |

For questions or issues, check the README or open a GitHub issue.
