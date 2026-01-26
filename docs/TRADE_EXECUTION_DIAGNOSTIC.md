# Trade Execution Diagnostic Guide

This document provides a comprehensive analysis of why trades may not execute (0 buys / 0 sells) even when the bot authenticates successfully and can see balances/positions.

## Table of Contents

1. [Address Path Analysis](#1-address-path-analysis)
2. [State Address Usage](#2-state-address-usage)
3. [Live Trading Gate](#3-live-trading-gate)
4. [Order Rejection Reasons](#4-order-rejection-reasons)
5. [Strategy Gating for Buys/Sells](#5-strategy-gating-for-buyssells)
6. [Debugging Checklist](#6-debugging-checklist)
7. [Code Fixes](#7-code-fixes)

---

## 1. Address Path Analysis

### `createClobClient()` in `src/lib/auth.ts`

The `createClobClient()` function is the primary authentication entry point. It determines which address is used for trading based on signature type:

#### Signature Types
- **Type 0 (EOA - default)**: Uses the wallet address directly from `PRIVATE_KEY`
- **Type 1 (Proxy)**: Uses `POLYMARKET_PROXY_ADDRESS` as the trading address
- **Type 2 (Safe)**: Uses `POLYMARKET_PROXY_ADDRESS` as the trading address (Gnosis Safe)

#### Address Resolution Logic (auth.ts:64-84)

```typescript
// Lines 64-70: Read signature type - default to 0 (EOA)
const signatureTypeStr = process.env.POLYMARKET_SIGNATURE_TYPE ?? process.env.CLOB_SIGNATURE_TYPE;
const signatureType = signatureTypeStr ? parseInt(signatureTypeStr, 10) || 0 : 0;

// Lines 72-75: Read funder/proxy address
const funderAddressRaw = process.env.POLYMARKET_PROXY_ADDRESS ?? process.env.CLOB_FUNDER_ADDRESS;
const funderAddress = funderAddressRaw?.toLowerCase();

// Lines 77-84: Determine effective addresses
const effectiveSignatureType = signatureType > 0 && funderAddress ? signatureType : 0;
const effectiveAddress = effectiveSignatureType > 0 && funderAddress ? funderAddress : address;
```

#### What Each Address Is Used For

| Operation | Address Used | Code Location |
|-----------|--------------|---------------|
| Balance checks (USDC) | `state.address` (effectiveAddress) | `start.ts:474` |
| Balance checks (POL) | `state.address` (effectiveAddress) | `start.ts:475` |
| Position queries | `state.address` (effectiveAddress) | `start.ts:390` via `getPositions()` |
| Order placement | `ClobClient` (uses signatureType + funder internally) | `order.ts:193-200` |
| Redeem positions | `address` parameter + `wallet` for signing | `redeem.ts:79-96` |
| Logs | `state.address` (effectiveAddress) | `start.ts:471` |

#### Critical Insight: Address Mismatch Scenario

**If `signatureType > 0` (Proxy/Safe mode) but `POLYMARKET_PROXY_ADDRESS` is not set:**

1. **Warning is logged** (auth.ts:91-95):
   ```typescript
   if (signatureType > 0 && !funderAddress) {
     logger?.warn?.(`signatureType=${signatureType} but no POLYMARKET_PROXY_ADDRESS set. Falling back to EOA mode`);
   }
   ```

2. **Behavior**: Falls back to EOA mode (`effectiveSignatureType = 0`)

3. **Result**: The bot uses the signer address, which is **correct** for balance queries but the CLOB client may fail orders if the API credentials were derived with a different signature configuration.

### `createPolymarketAuthFromEnv()` in `src/clob/polymarket-auth.ts`

This alternative auth module follows the same pattern but includes additional validation (lines 278-283):

```typescript
if (signatureType > 0 && !funderAddress) {
  logger?.warn?.(`signatureType=${signatureType} but no POLYMARKET_PROXY_ADDRESS set. ` +
    `This may cause issues. Set POLYMARKET_PROXY_ADDRESS or use signatureType=0 for EOA mode.`);
}
```

---

## 2. State Address Usage

### What `state.address` Represents

In `src/start.ts`, `state.address` is set at line 469:

```typescript
state.address = auth.address ?? "";
```

Where `auth.address` comes from `createClobClient()` and is the **effective trading address** (lowercased):

- **EOA mode**: The wallet address from `PRIVATE_KEY`
- **Proxy/Safe mode**: The `POLYMARKET_PROXY_ADDRESS`

### Where `state.address` Is Used

| Location | Usage | Code |
|----------|-------|------|
| `start.ts:390` | Get positions | `getPositions(state.address)` |
| `start.ts:407-408` | Print summary | `getPositions(state.address, true)`, `getUsdcBalance(state.wallet, state.address)` |
| `start.ts:346` | Redeem | `redeemAll(state.wallet, state.address, ...)` |
| `start.ts:365-367` | POL reserve | `getPolBalance(state.wallet, state.address)`, `getUsdcBalance(state.wallet, state.address)` |
| `start.ts:471,487,489` | Logs | Display address in logs |

### Potential Mismatch Issues

1. **Proxy mode with credentials derived in EOA mode**: If API credentials (`POLYMARKET_API_KEY`, etc.) were generated with signatureType=0 but you're now using signatureType=1, orders will fail with 401/403 errors.

2. **Signer doesn't match funder**: The wallet (signer) must be authorized to trade on behalf of the funder address. If not properly configured on Polymarket, orders will be rejected.

---

## 3. Live Trading Gate

### How `LIVE_TRADING` Controls Real Orders

The live trading check is defined in `src/lib/auth.ts:148-151`:

```typescript
export function isLiveTradingEnabled(): boolean {
  const flag = process.env.LIVE_TRADING ?? process.env.ARB_LIVE_TRADING ?? "";
  return flag === "I_UNDERSTAND_THE_RISKS";
}
```

**Key Points:**
- The magic string is `"I_UNDERSTAND_THE_RISKS"` (case-sensitive, exact match)
- Both `LIVE_TRADING` and `ARB_LIVE_TRADING` are checked
- Any other value (including `true`, `yes`, `1`) will result in simulation mode

### Where Live Trading Is Checked

#### 1. At Startup (start.ts:438)
```typescript
state.liveTrading = isLiveTradingEnabled();
```

#### 2. In Order Execution (order.ts:51-54)
```typescript
if (!isLiveTradingEnabled()) {
  logger?.warn?.(`[SIM] ${side} ${sizeUsd.toFixed(2)} USD - live trading disabled`);
  return { success: true, reason: "SIMULATED" };
}
```

#### 3. In Buy/Sell Functions (start.ts:137-140, 177-180)
```typescript
if (!state.liveTrading) {
  logger.info(`🔸 [SIM] BUY ${outcome} ${$(size)} | ${reason}`);
  await sendTelegram("[SIM] BUY", `${reason}\n${outcome} ${$(size)}`);
  return true;
}
```

### Simulation Mode Behavior

When `LIVE_TRADING` is not set to `"I_UNDERSTAND_THE_RISKS"`:

1. `postOrder()` returns `{ success: true, reason: "SIMULATED" }`
2. No actual orders are submitted to the CLOB
3. Logs show `[SIM]` prefix
4. Trade counter is NOT incremented (only real trades increment `state.tradesExecuted`)

**This is the most common reason for "0 buys / 0 sells" even when the bot is working correctly!**

---

## 4. Order Rejection Reasons

### Complete List from `postOrder()` (src/lib/order.ts)

| Reason | Condition | Log Behavior | Line |
|--------|-----------|--------------|------|
| `SIMULATED` | `!isLiveTradingEnabled()` | `[SIM] {side} {sizeUsd} USD - live trading disabled` | 51-54 |
| `ORDER_TOO_SMALL` | `sizeUsd < ORDER.MIN_ORDER_USD` (0.01) | No explicit log | 57-59 |
| `IN_FLIGHT` | Same token order within `COOLDOWN_MS` (1000ms) | No explicit log | 66-69 |
| `MARKET_COOLDOWN` | Same market order within `MARKET_COOLDOWN_MS` (5000ms) | No explicit log | 73-76 |
| `MARKET_NOT_FOUND` | Market doesn't exist (if marketId provided) | No explicit log | 88-89 |
| `MARKET_CLOSED` | Orderbook fetch returns 404 or "No orderbook exists" | No explicit log | 101-105 |
| `NO_ORDERBOOK` | `orderBook` is null/undefined | No explicit log | 108-110 |
| `NO_ASKS` | No asks in orderbook (for BUY) | No explicit log | 115-117 |
| `NO_BIDS` | No bids in orderbook (for SELL) | No explicit log | 115-117 |
| `ZERO_PRICE` | `bestPrice <= ORDER.MIN_TRADEABLE_PRICE` (0.001) | No explicit log | 122-124 |
| `LOSER_POSITION` | BUY at price < `GLOBAL_MIN_BUY_PRICE` (0.10) | No explicit log | 127-129 |
| `PRICE_TOO_HIGH` | BUY price > `maxAcceptablePrice` | No explicit log | 132-135 |
| `PRICE_TOO_LOW` | SELL price < `maxAcceptablePrice` | No explicit log | 136-138 |
| `NO_FILLS` | Order executed but no fills after retries | No explicit log | 234 |
| `MARKET_CLOSED` (catch) | Error contains "closed", "resolved", "404", "No orderbook" | No explicit log | 236-240 |
| Custom error message | Any other exception | `warn: Order execution error: {msg}` | 216-223 |

### How Rejections Appear in Logs

In `buy()` and `sell()` functions (start.ts:162-165, 201-205):

```typescript
if (result.reason !== "SIMULATED") {
  logger.warn(`BUY failed: ${result.reason} | ${reason}`);
}
```

**Note:** `SIMULATED` results are logged separately with `[SIM]` prefix.

---

## 5. Strategy Gating for Buys/Sells

### Copy Trading Filters (start.ts:310-336)

```typescript
async function runCopyTrading(): Promise<void> {
  if (state.targets.length === 0) return;  // No targets configured

  const trades = await fetchRecentTrades(state.targets);
  const cfg = state.config.copy;

  for (const t of trades) {
    if (t.side !== "BUY") continue;           // Only BUY signals copied
    if (t.price < cfg.minBuyPrice) continue;  // Default 0.50 (50¢)
    
    const size = Math.min(
      Math.max(t.sizeUsd * cfg.multiplier, cfg.minUsd),  // minUsd default: 5
      cfg.maxUsd,           // maxUsd default: 100 (balanced preset)
      state.maxPositionUsd, // From preset or env
    );

    if (size < cfg.minUsd) continue;  // Skip if calculated size too small
    // ... buy execution
  }
}
```

**Copy Trading Filtering:**
1. Only trades from last 60 seconds (copy.ts:30-31)
2. Only BUY signals (SELLs ignored)
3. Price must be >= `cfg.minBuyPrice` (default 0.50)
4. Size must be >= `cfg.minUsd` (default 5)

### Auto-Sell Conditions (start.ts:210-219)

```typescript
async function runAutoSell(positions: Position[]): Promise<void> {
  const cfg = state.config.autoSell;
  if (!cfg.enabled) return;

  for (const p of positions) {
    if (p.curPrice >= cfg.threshold) {  // Default: 0.99 (99¢)
      await sell(p.tokenId, p.outcome, p.value, `AutoSell (${(p.curPrice * 100).toFixed(0)}¢)`, p.size);
    }
  }
}
```

### Scalp Conditions (start.ts:256-269)

```typescript
async function runScalp(positions: Position[]): Promise<void> {
  const cfg = state.config.scalp;
  if (!cfg.enabled) return;

  for (const p of positions) {
    if (
      p.pnlPct >= cfg.minProfitPct &&      // Default: 10%
      p.gainCents >= cfg.minGainCents &&   // Default: 5¢
      p.pnlUsd >= cfg.minProfitUsd         // Default: $1.0
    ) {
      await sell(...);
    }
  }
}
```

### Stop-Loss Conditions (start.ts:245-254)

```typescript
async function runStopLoss(positions: Position[]): Promise<void> {
  const cfg = state.config.stopLoss;
  if (!cfg.enabled || state.config.hedge.enabled) return;  // Disabled if hedging on

  for (const p of positions) {
    if (p.pnlPct < 0 && Math.abs(p.pnlPct) >= cfg.maxLossPct) {  // Default: 25%
      await sell(...);
    }
  }
}
```

### Hedge Conditions (start.ts:221-243)

```typescript
async function runHedge(positions: Position[]): Promise<void> {
  const cfg = state.config.hedge;
  if (!cfg.enabled) return;

  for (const p of positions) {
    if (state.hedgedTokens.has(p.tokenId)) continue;  // Already hedged
    if (p.pnlPct >= 0 || Math.abs(p.pnlPct) < cfg.triggerPct) continue;  // Default: 20%

    // Hedges only once per token
    const success = await buy(/* opposite outcome */);
    if (success) state.hedgedTokens.add(p.tokenId);
  }
}
```

### Stack Conditions (start.ts:271-290)

```typescript
async function runStack(positions: Position[]): Promise<void> {
  const cfg = state.config.stack;
  if (!cfg.enabled) return;

  for (const p of positions) {
    if (state.stackedTokens.has(p.tokenId)) continue;   // Already stacked
    if (p.gainCents < cfg.minGainCents) continue;       // Default: 20¢
    if (p.curPrice > cfg.maxPrice) continue;            // Default: 0.95 (95¢)
    if (p.curPrice < ORDER.GLOBAL_MIN_BUY_PRICE) continue;  // 0.10 (10¢)

    // Stacks only once per token
    if (success) state.stackedTokens.add(p.tokenId);
  }
}
```

### Why Strategies May Result in Zero Trades

1. **Copy Trading**: No targets configured, or all trades filtered out (SELLs, old trades, low prices)
2. **Auto-Sell**: Positions not at 99¢+ threshold
3. **Scalp**: Positions don't meet all three criteria (profit %, gain cents, profit USD)
4. **Stop-Loss**: Disabled when hedging is enabled; positions not losing enough
5. **Hedge**: Only triggers on significant losses; only hedges once per token
6. **Stack**: Only stacks winning positions once; price constraints

---

## 6. Debugging Checklist

### Environment Variables to Print at Startup

Add this check to verify configuration:

```typescript
console.log("=== Debug Configuration ===");
console.log(`LIVE_TRADING: "${process.env.LIVE_TRADING}"`);
console.log(`Expected: "I_UNDERSTAND_THE_RISKS"`);
console.log(`Live trading enabled: ${isLiveTradingEnabled()}`);
console.log(`POLYMARKET_SIGNATURE_TYPE: ${process.env.POLYMARKET_SIGNATURE_TYPE ?? "not set (default: 0)"}`);
console.log(`POLYMARKET_PROXY_ADDRESS: ${process.env.POLYMARKET_PROXY_ADDRESS ?? "not set"}`);
console.log(`TARGET_ADDRESSES: ${process.env.TARGET_ADDRESSES ?? "not set"}`);
console.log(`PRESET: ${process.env.PRESET ?? "balanced"}`);
console.log("===========================");
```

### Addresses to Log at Startup

The bot already logs (start.ts:471):
```typescript
logger.info(`Wallet: ${state.address.slice(0, 10)}...`);
```

Add more explicit logging:

```typescript
logger.info(`Signer address: ${auth.wallet?.address}`);
logger.info(`Effective/trading address: ${auth.effectiveAddress}`);
logger.info(`Address used for positions/balances: ${state.address}`);
```

### How to Validate On-Chain Balances

Use the `onchain:status` script:
```bash
npm run onchain:status
```

Or manually verify:
1. Check USDC balance: `ethers.Contract(USDC_ADDRESS).balanceOf(effectiveAddress)`
2. Check POL balance: `provider.getBalance(effectiveAddress)`
3. Verify allowances: `ethers.Contract(USDC_ADDRESS).allowance(effectiveAddress, CTF_EXCHANGE)`

### How to Differentiate Failure Modes

| Symptom | Likely Cause | How to Confirm |
|---------|--------------|----------------|
| Logs show `[SIM] BUY/SELL` | Live trading disabled | Check `LIVE_TRADING` env var |
| Logs show `BUY failed: SIMULATED` | Won't appear (simulated is handled separately) | - |
| Logs show `BUY failed: {reason}` | Order rejected | Check reason code table above |
| No logs about trades at all | Strategy filtering | Add debug logs to strategies |
| Trade count stays at 0 | Either simulated or all rejected | Check both patterns above |

### Quick Diagnostic Commands

```bash
# 1. Check if LIVE_TRADING is set correctly
echo $LIVE_TRADING

# 2. Verify the exact string (watch for hidden chars)
echo "$LIVE_TRADING" | od -c

# 3. Run preflight check
npm run preflight

# 4. Check auth configuration
npm run auth:probe
```

---

## 7. Code Fixes

### Issue 1: Missing Startup Debug Logging

**Problem**: Hard to diagnose configuration issues without explicit logging of critical settings.

**File**: `src/start.ts`
**Location**: After line 442, add:

```typescript
// Add after line 442 (after logger.info(`Live Trading: ${state.liveTrading ? "ENABLED" : "DISABLED"}`);)

// Debug: Log exact LIVE_TRADING value to catch typos/whitespace
if (!state.liveTrading) {
  const rawValue = process.env.LIVE_TRADING ?? process.env.ARB_LIVE_TRADING ?? "";
  if (rawValue && rawValue !== "I_UNDERSTAND_THE_RISKS") {
    logger.warn(`LIVE_TRADING value "${rawValue}" is not valid. Expected: "I_UNDERSTAND_THE_RISKS"`);
  }
}
```

### Issue 2: Missing Order Rejection Logging in postOrder()

**Problem**: Many rejection reasons in `postOrder()` don't log anything, making debugging difficult.

**File**: `src/lib/order.ts`
**Suggested Enhancement**: Add debug logging for all rejections. This is addressed in the code change below.

### Issue 3: Address Mismatch Warning Not Logged for Critical Case

**Problem**: When the bot sees positions/balances but orders fail, there's no warning about potential address mismatch.

**File**: `src/start.ts`
**Location**: After authentication (around line 469), add validation:

```typescript
// Add after line 469 (state.address = auth.address ?? "";)

// Validate address consistency
if (auth.address && auth.effectiveAddress && auth.address !== auth.effectiveAddress) {
  logger.warn(`⚠️ Address mismatch: signer=${auth.wallet?.address?.slice(0, 10)}... effective=${auth.effectiveAddress?.slice(0, 10)}...`);
  logger.warn(`Ensure API credentials were derived with the same signature type configuration.`);
}
```

---

## Summary

The most common reasons for 0 buys / 0 sells:

1. **`LIVE_TRADING` not set to exact string `"I_UNDERSTAND_THE_RISKS"`** - Most common
2. **No copy trading targets** configured and no positions to trigger other strategies
3. **All signals filtered** by price/timing constraints
4. **Positions don't meet strategy thresholds** (profit %, cents gain, etc.)
5. **Cooldowns blocking orders** (same token/market within timeout)
6. **Address mismatch** between where credentials were derived and current config

Use the debugging checklist above to systematically identify which case applies.
