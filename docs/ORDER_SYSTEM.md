# Polymarket Sniper Bot - Order System Documentation

This document provides a comprehensive reference for understanding how the order system works, including whale tracking, position management, copy trading, and all the protective mechanisms in place.

## Table of Contents

1. [Overview](#overview)
2. [Whale Tracking (Bias/Flow Detection)](#whale-tracking-biasflow-detection)
3. [Copy Trading System](#copy-trading-system)
4. [Position Management](#position-management)
5. [Order Execution Flow](#order-execution-flow)
6. [Price Protection & Deviance Checks](#price-protection--deviance-checks)
7. [Smart Sell System](#smart-sell-system)
8. [Hedging Logic](#hedging-logic)
9. [Scavenger Mode](#scavenger-mode)
10. [Auto-Redemption](#auto-redemption)
11. [Configuration Parameters](#configuration-parameters)

---

## Overview

The Polymarket Sniper Bot is a copy-trading system that tracks whale wallets (top traders from the Polymarket leaderboard) and executes trades based on their activity. The system uses a deterministic, math-driven approach with fixed parameters based on Expected Value (EV) calculations.

### Core EV Equation

```
EV = p(win) × avg_win - p(loss) × avg_loss - churn_cost
```

Fixed values:
- `avg_win` = 14¢ (take profit target)
- `avg_loss` = 9¢ (after hedging caps losses)
- `churn_cost` = 2¢ (spread + slippage)

**Break-even point**: p > (9 + 2) / (14 + 9) = **47.8% win rate**

---

## Whale Tracking (Bias/Flow Detection)

### How Whales Are Identified

The bot identifies "whales" by fetching the **top 100 traders** from the Polymarket leaderboard API. These are wallets with proven profitable trading histories.

```typescript
// From targets.ts
const url = `${POLYMARKET_API.DATA}/v1/leaderboard?category=OVERALL&timePeriod=WEEK&orderBy=PNL&limit=100`;
```

**Key points:**
- Fetches `proxyWallet` addresses (where trades actually happen)
- Can be overridden via environment variables:
  - `TARGET_ADDRESSES`
  - `COPY_ADDRESSES`
  - `MONITOR_ADDRESSES`

### Bias Mode (Leaderboard Flow)

The bot doesn't blindly copy every whale trade. Instead, it tracks **aggregate flow** from multiple whales to establish "bias" - a directional signal.

**Bias configuration:**
| Parameter | Default | Description |
|-----------|---------|-------------|
| `biasMode` | `leaderboard_flow` | Uses aggregate whale activity |
| `leaderboardTopN` | 100 | Track top 100 wallets |
| `biasWindowSeconds` | 3600 | 1-hour window for flow analysis |
| `biasMinNetUsd` | $300 | Minimum net flow to establish bias |
| `biasMinTrades` | 3 | At least 3 trades required |
| `biasStaleSeconds` | 900 | Bias expires after 15 minutes |
| `allowEntriesOnlyWithBias` | true | Only enter when bias is established |

### Bias Actions

- **`onBiasFlip: "MANAGE_EXITS_ONLY"`** - When bias flips direction, only manage existing positions (no new entries)
- **`onBiasNone: "PAUSE_ENTRIES"`** - When no clear bias, pause new entries

---

## Copy Trading System

### Trade Signal Structure

When a whale trades, the system captures the following signal:

```typescript
interface TradeSignal {
  tokenId: string;      // The outcome token (YES/NO)
  conditionId: string;  // Unique market condition
  marketId?: string;    // Market identifier (optional - some data sources may not provide it)
  outcome: string;      // "YES" or "NO"
  side: OrderSide;      // "BUY" or "SELL"
  sizeUsd: number;      // Trade size in USD
  price: number;        // Execution price
  trader: string;       // Whale wallet address
  timestamp: number;    // When trade occurred
}
```

### How Copy Trading Works

1. **Poll for whale trades** - Check recent trades from tracked wallets
2. **Filter seen trades** - Prevent duplicate signals
3. **Only recent trades** - Only trades from the last 60 seconds
4. **Generate copy signal** - Create a trade signal for the bot to execute

```typescript
// From copy.ts
// Only last 60 seconds
if (now - ts > 60000) continue;
```

### What "Copies" Are

When you buy on Polymarket, you're buying **shares** of an outcome token. 

**Example:**
- Market: "Will Event X happen?"
- YES token at $0.65 means the market thinks there's a 65% chance
- Buying 10 shares at $0.65 costs $6.50
- If YES wins, you get $10.00 (10 shares × $1.00)
- Profit: $3.50 (10 shares × $0.35)

The `size` field in positions represents **number of shares**, not USD value.

---

## Position Management

### Position Structure

```typescript
interface Position {
  tokenId: string;      // The outcome token
  conditionId: string;  // Market condition
  marketId?: string;    // Market identifier
  outcome: string;      // "YES" or "NO"
  size: number;         // Number of shares held
  avgPrice: number;     // Average entry price per share
  curPrice: number;     // Current market price
  pnlPct: number;       // Profit/Loss percentage
  pnlUsd: number;       // Profit/Loss in USD
  gainCents: number;    // (curPrice - avgPrice) × 100
  value: number;        // size × curPrice
}
```

### Position P&L Calculation

```typescript
const value = size * curPrice;      // Current value
const cost = size * avgPrice;       // Cost basis
const pnlUsd = value - cost;        // Absolute P&L
const pnlPct = (pnlUsd / cost) * 100; // Percentage P&L
```

### Position Limits

| Parameter | Default | Description |
|-----------|---------|-------------|
| `maxOpenPositionsTotal` | 12 | Max concurrent positions |
| `maxOpenPositionsPerMarket` | 2 | Max per market |
| `maxDeployedFractionTotal` | 30% | Max capital exposure |
| `cooldownSecondsPerToken` | 180 | 3-min cooldown per token |

---

## Order Execution Flow

### BUY Order Flow

1. **Check live trading** - Is `LIVE_TRADING=I_UNDERSTAND_THE_RISKS` set?
2. **Validate minimum size** - Must be ≥ $0.01 (`MIN_ORDER_USD`)
3. **Duplicate prevention** - Token cooldown (1s) and market cooldown (5s)
4. **Get orderbook** - Fetch current asks (for buys)
5. **Price validation**:
   - Best ask must be > 0.001 (`MIN_TRADEABLE_PRICE`)
   - Best ask must be ≥ 0.10 (`GLOBAL_MIN_BUY_PRICE`) - rejects "loser" positions
   - If `maxAcceptablePrice` set, best ask must be ≤ max price
6. **Calculate shares** - `shares = sizeUsd / price`
7. **Execute FOK order** - Fill-Or-Kill for immediate execution
8. **Retry logic** - Up to 3 retries with refreshed orderbook

### SELL Order Flow

1. Same checks as BUY
2. **Get orderbook** - Fetch current bids (for sells)
3. **Price validation**:
   - If `maxAcceptablePrice` set, best bid must be ≥ min price
4. **Track remaining shares** - For partial fills
5. **Execute FOK order**

### Order Types

- **FOK (Fill-Or-Kill)**: Order must fill completely and immediately, or it's cancelled
- **GTC (Good-Til-Cancelled)**: Order sits on the book until filled or cancelled

---

## Price Protection & Deviance Checks

### Global Price Protections

| Check | Value | Description |
|-------|-------|-------------|
| `MIN_TRADEABLE_PRICE` | 0.001 | Rejects zero/dust prices |
| `GLOBAL_MIN_BUY_PRICE` | 0.10 | Won't buy tokens < 10¢ (likely losers) |
| `MIN_ORDER_USD` | 0.01 | Minimum order size |

### Price Slippage Protection (`maxAcceptablePrice`)

The `maxAcceptablePrice` parameter provides **price protection across retries**:

**For BUY orders:**
- Rejects if `ask price > maxAcceptablePrice`
- Prevents buying at worse prices than expected

**For SELL orders:**
- Rejects if `bid price < maxAcceptablePrice`
- Prevents selling at worse prices than expected

**If `maxAcceptablePrice` is undefined:** NO price protection (emergency "NUCLEAR" mode for forced liquidations)

### Per-Iteration Price Enforcement

On **each retry iteration**, the bot:
1. Refreshes the orderbook
2. Re-checks price against `maxAcceptablePrice`
3. Exits if price has moved unfavorably

```typescript
// From order.ts
if (maxAcceptablePrice !== undefined) {
  if (isBuy && levelPrice > maxAcceptablePrice) {
    return { success: false, reason: "PRICE_TOO_HIGH" };
  }
  if (!isBuy && levelPrice < maxAcceptablePrice) {
    return { success: false, reason: "PRICE_TOO_LOW" };
  }
}
```

### Entry Price Bounds

The main bot enforces strict entry zones:

| Parameter | Value | Description |
|-----------|-------|-------------|
| `minEntryPriceCents` | 30¢ | Below this, one bad tick kills you |
| `maxEntryPriceCents` | 82¢ | Above this, no room for take-profit |
| `preferredEntryLowCents` | 35¢ | Ideal zone starts |
| `preferredEntryHighCents` | 65¢ | Ideal zone ends |
| `entryBufferCents` | 4¢ | Safety buffer |

### "Loser Position" Check

Positions trading at very low prices (< 10¢) are likely losing outcomes. The bot rejects buys on these:

```typescript
if (isBuy && bestPrice < ORDER.GLOBAL_MIN_BUY_PRICE) {
  return { success: false, reason: "LOSER_POSITION" };
}
```

---

## Smart Sell System

The `smartSell` module implements sophisticated sell logic to avoid bad fills.

### Orderbook Analysis

Before selling, the system analyzes:

```typescript
interface LiquidityAnalysis {
  bestBid: number;              // Best available bid price
  liquidityAtSlippage: number;  // USD available within slippage tolerance
  liquidityAtBestBid: number;   // USD at best bid only
  expectedAvgPrice: number;     // Expected weighted average fill price
  expectedSlippagePct: number;  // Expected slippage as percentage
  canFill: boolean;             // Can we fill at acceptable price?
  levelsNeeded: number;         // How many orderbook levels needed
}
```

### Slippage Protection

**Slippage settings:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `DEFAULT_SLIPPAGE_PCT` | 2% | Normal slippage tolerance |
| `MAX_SLIPPAGE_PCT` | 5% | Maximum ever allowed |
| `MIN_SLIPPAGE_PCT` | 0.5% | Minimum for liquid markets |
| `MIN_LIQUIDITY_USD` | $10 | Minimum bid liquidity required |
| `MIN_FILL_RATIO` | 80% | Must fill at least 80% of order |

### Dynamic Slippage Calculation

Slippage tolerance adjusts based on position state:

1. **High price positions (≥ 95¢)**: Use tight 0.5% slippage (likely winners)
2. **Significant loss (≥ -20%)**: Allow higher 5% slippage (exit priority)
3. **Forced sells**: Use maximum slippage

```typescript
// From smart-sell.ts
if (position.curPrice >= SELL.HIGH_PRICE_THRESHOLD) {
  return SELL.HIGH_PRICE_SLIPPAGE_PCT;  // 0.5%
}
if (position.pnlPct <= -SELL.LOSS_THRESHOLD_PCT) {
  return SELL.LOSS_SLIPPAGE_PCT;  // 5%
}
return SELL.DEFAULT_SLIPPAGE_PCT;  // 2%
```

### Sell Recommendations

The system provides recommendations:
- **SELL_NOW**: Good liquidity, use FOK
- **PLACE_LIMIT**: Moderate liquidity, use GTC limit order
- **WAIT**: Thin liquidity, wait for better conditions
- **HOLD_TO_RESOLUTION**: Near resolution or no bids

---

## Hedging Logic

### How Hedging Works

When a position moves against you, hedging reduces exposure by selling a portion:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `hedgeTriggerCents` | 16¢ | Trigger hedge at 16¢ adverse move |
| `hedgeRatio` | 40% | Sell 40% on first hedge trigger |
| `maxHedgeRatio` | 70% | Never hedge more than 70% |
| `maxAdverseCents` | 30¢ | HARD STOP - forced liquidation |

### Hedge Example

1. Buy at 50¢, position moves to 34¢ (16¢ adverse)
2. First hedge: Sell 40% of position
3. Price continues down...
4. Can hedge up to 70% total
5. At 30¢ adverse (price = 20¢): HARD STOP - liquidate everything

**Why hedge instead of stop-loss?**
- Caps average loss to ~9¢ instead of 30¢
- Maintains some upside if price recovers
- Reduces variance while staying in the game

---

## Scavenger Mode

### What Is Scavenger Mode?

During **low liquidity periods**, the bot enters "Scavenger Mode" - a capital preservation strategy.

### Detection Triggers

Scavenger mode activates when multiple conditions are met:

| Condition | Threshold | Description |
|-----------|-----------|-------------|
| Low volume | < $1,000 in 5 min | Market volume dropped |
| Thin orderbook | < $500 depth | Not enough liquidity |
| Stagnant book | No changes in 2 min | No price movement |
| Few active whales | < 1 active | Whales aren't trading |

### Scavenger Actions

1. **Exit green positions** - Take profits on winning positions
2. **Monitor red positions** - Wait for recovery to exit
3. **No new entries** - Preserve capital

### Recovery Detection

Exit scavenger mode when:
- Volume recovers to > $5,000
- Depth recovers to > $2,000
- Active whales ≥ 2
- Sustained for 2+ minutes

---

## Auto-Redemption

### What Is Redemption?

When a Polymarket market **resolves** (outcome determined), winning positions become "redeemable". Redemption converts your winning shares to USDC.

### How It Works

1. **Fetch redeemable positions** from Polymarket API
2. **Call CTF contract** `redeemPositions()` function
3. **Receive USDC** for winning positions

### Redemption Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| Redemption interval | ~10 min | Check for redeemable positions approximately every 10 minutes (hard-coded) |
| Minimum size filter | N/A | No minimum-size filter applied; all eligible positions are redeemed |

### Proxy Wallet Support

If using a Polymarket proxy wallet, redemption routes through the proxy contract.

---

## Configuration Parameters

### User Configurable

#### Core Settings
| Parameter | Default | Description |
|-----------|---------|-------------|
| `MAX_TRADE_USD` | $25 | Your bet size per trade |
| `LIVE_TRADING` | - | Set to `I_UNDERSTAND_THE_RISKS` to enable |
| `PRIVATE_KEY` | - | Your wallet private key |
| `RPC_URL` | polygon-rpc.com | Polygon RPC endpoint |

#### Telegram Notifications (Optional)
| Parameter | Default | Description |
|-----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | - | Telegram bot token for notifications |
| `TELEGRAM_CHAT_ID` | - | Telegram chat ID for notifications |

#### On-Chain Monitoring
| Parameter | Default | Description |
|-----------|---------|-------------|
| `ONCHAIN_MONITOR_ENABLED` | true | Watch CTF Exchange contract via Infura WebSocket |
| `ONCHAIN_MIN_WHALE_TRADE_USD` | $500 | Minimum trade size to track on-chain |
| `INFURA_TIER` | core | Infura plan: "core" (free), "developer", "team", "growth" |

#### Liquidation Mode
| Parameter | Default | Description |
|-----------|---------|-------------|
| `FORCE_LIQUIDATION` | false | Force sell existing positions when balance is too low |
| `LIQUIDATION_MAX_SLIPPAGE_PCT` | 10% | Max slippage for liquidation sells |
| `LIQUIDATION_POLL_INTERVAL_MS` | 1000 | Poll interval in liquidation mode (ms) |

#### POL Reserve (Auto Gas Fill)
| Parameter | Default | Description |
|-----------|---------|-------------|
| `POL_RESERVE_TARGET` | 50 | Target POL when refilling |
| `POL_RESERVE_MIN` | 0.5 | Trigger threshold (refill when below this) |
| `POL_RESERVE_MAX_SWAP_USD` | $10 | Max USDC per swap |
| `POL_RESERVE_CHECK_INTERVAL_MIN` | 5 | Check every N minutes |

### Fixed Parameters (Do Not Change)

These are fixed by the EV math:

#### Capital Sizing
| Parameter | Value | Description |
|-----------|-------|-------------|
| `tradeFraction` | 1% | Per trade as fraction of bankroll |
| `maxDeployedFractionTotal` | 30% | Max total exposure |
| `reserveFraction` | 25% | Always keep 25% reserved |
| `minReserveUsd` | $100 | Minimum reserve |

#### Entry/Exit
| Parameter | Value | Description |
|-----------|-------|-------------|
| `tpCents` | 14¢ | Take profit target |
| `hedgeTriggerCents` | 16¢ | First hedge trigger |
| `maxAdverseCents` | 30¢ | Hard stop loss |
| `maxHoldSeconds` | 3600 | 1-hour max hold time |

#### Liquidity Gates
| Parameter | Value | Description |
|-----------|-------|-------------|
| `minSpreadCents` | 6¢ | Maximum acceptable spread |
| `minDepthUsdAtExit` | $25 | Need liquidity to exit |
| `minTradesLastX` | 10 | Market must be active |

---

## Order Rejection Reasons

| Reason | Meaning |
|--------|---------|
| `SIMULATED` | Order simulated (live trading disabled) |
| `ORDER_TOO_SMALL` | Below minimum $0.01 |
| `IN_FLIGHT` | Token on cooldown |
| `MARKET_COOLDOWN` | Market on cooldown |
| `MARKET_NOT_FOUND` | Market doesn't exist |
| `MARKET_CLOSED` | Market resolved/closed |
| `NO_ORDERBOOK` | Orderbook unavailable |
| `NO_ASKS` / `NO_BIDS` | Empty orderbook side |
| `ZERO_PRICE` | Price too low |
| `LOSER_POSITION` | Price < 10¢ (likely loser) |
| `PRICE_TOO_HIGH` | Exceeded max buy price |
| `PRICE_TOO_LOW` | Below min sell price |
| `INSUFFICIENT_BALANCE` | Not enough USDC |
| `INSUFFICIENT_ALLOWANCE` | Need to approve USDC |
| `PRICE_SLIPPAGE` | Price moved too much |
| `CLOUDFLARE_BLOCKED` | IP blocked (need VPN) |
| `NO_FILLS` | Order couldn't fill |
| `FOK_NOT_FILLED` | Fill-or-kill order did not fully fill |
| `ORDER_FAILED` | Generic order placement or execution failure |
| `INSUFFICIENT_LIQUIDITY` | Not enough orderbook depth |
| `SLIPPAGE_TOO_HIGH` | Expected slippage exceeds limit |
| `POSITION_TOO_SMALL` | Position has no shares |

---

## Further Reading

- [Polymarket Documentation](https://docs.polymarket.com)
- [CLOB API Reference](https://docs.polymarket.com/developers/clob-api)
- [Data API Reference](https://docs.polymarket.com/developers/misc-endpoints/data-api-overview)
