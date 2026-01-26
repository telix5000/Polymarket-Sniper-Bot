# Polymarket Bot: Trading Address & Auth Diagnostic Report

**Date:** 2026-01-26  
**Version:** V2 System Analysis  
**Scope:** Address handling, LIVE_TRADING gating, order failures, strategy filters

---

## Table of Contents

1. [Address Derivation Chain](#1-address-derivation-chain)
2. [Runtime Address Usage](#2-runtime-address-usage)
3. [LIVE_TRADING Gating Logic](#3-live_trading-gating-logic)
4. [Order/Balance Failure Causes](#4-orderbalance-failure-causes)
5. [Strategy/Risk Filters](#5-strategyrisk-filters)
6. [Production Debugging Checklist](#6-production-debugging-checklist)
7. [Root Cause Summary](#7-root-cause-summary)
8. [Proposed Fixes](#8-proposed-fixes)

---

## 1. Address Derivation Chain

### 1.1 Environment Variables Involved

| Variable | Purpose | File Location |
|----------|---------|---------------|
| `PRIVATE_KEY` | Wallet private key for signing | `src/lib/auth.ts:37-55` |
| `POLYMARKET_SIGNATURE_TYPE` | 0=EOA, 1=Proxy, 2=Safe | `src/lib/auth.ts:66-70` |
| `CLOB_SIGNATURE_TYPE` | Fallback for signature type | `src/lib/auth.ts:67` |
| `POLYMARKET_PROXY_ADDRESS` | Funder/proxy address for modes 1,2 | `src/lib/auth.ts:73-75` |
| `CLOB_FUNDER_ADDRESS` | Fallback for proxy address | `src/lib/auth.ts:74` |

### 1.2 Address Determination Logic (`src/lib/auth.ts:37-143`)

```typescript
// Step 1: Create wallet from PRIVATE_KEY
const wallet = new Wallet(normalizedKey, provider);
const address = wallet.address;  // This is the SIGNER address (EOA)

// Step 2: Read signature type (default to 0 = EOA mode)
const signatureTypeStr = process.env.POLYMARKET_SIGNATURE_TYPE ?? process.env.CLOB_SIGNATURE_TYPE;
const signatureType = signatureTypeStr ? parseInt(signatureTypeStr, 10) || 0 : 0;

// Step 3: Read funder address (normalized to lowercase)
const funderAddressRaw = process.env.POLYMARKET_PROXY_ADDRESS ?? process.env.CLOB_FUNDER_ADDRESS;
const funderAddress = funderAddressRaw?.toLowerCase();

// Step 4: Determine effective signature type
// Falls back to EOA if proxy mode requested but no funder address set
const effectiveSignatureType = signatureType > 0 && funderAddress ? signatureType : 0;

// Step 5: Determine effective address
const effectiveAddress = effectiveSignatureType > 0 && funderAddress ? funderAddress : address;
```

**Key Lines:**
- `src/lib/auth.ts:61-62` - Wallet creation from private key
- `src/lib/auth.ts:79-80` - Effective signature type determination
- `src/lib/auth.ts:83-84` - Effective address determination
- `src/lib/auth.ts:129-136` - Return value (effectiveAddress as `address`)

### 1.3 Which Address is Used For What

| Operation | Address Used | Source Code |
|-----------|--------------|-------------|
| **CLOB Signing** | Signer (wallet.address) | `src/lib/auth.ts:98-105` - ClobClient gets wallet for signing |
| **CLOB Funder Parameter** | effectiveAddress (funder in proxy mode) | `src/lib/auth.ts:104,123-124` - Passed to ClobClient |
| **Balance Checks** | effectiveAddress (via `state.address`) | `src/start.ts:474-475`, `src/lib/balance.ts:11-18` |
| **Allowance Checks** | N/A (not explicitly checked in V2) | Balance.ts only checks balanceOf |
| **Order Placement** | effectiveAddress (via client's funder) | `src/lib/order.ts:193-200` - client.createMarketOrder() |
| **Logging** | effectiveAddress (via `state.address`) | `src/start.ts:471` |
| **Position Fetches** | effectiveAddress (via `state.address`) | `src/start.ts:390`, `src/lib/positions.ts:15` |

---

## 2. Runtime Address Usage

### 2.1 Startup Sequence (`src/start.ts`)

```typescript
// Line 456-469: Authentication
const auth = await createClobClient(
  process.env.PRIVATE_KEY ?? "",
  rpcUrl,
  logger,
);

if (!auth.success || !auth.client || !auth.wallet) {
  logger.error(`Auth failed: ${auth.error}`);
  process.exit(1);
}

state.client = auth.client;
state.wallet = auth.wallet;
state.address = auth.address ?? "";  // <-- LINE 469: state.address is set to effectiveAddress
```

**✅ CORRECT:** `state.address` is set to `auth.address`, which is the `effectiveAddress` (funder in proxy mode).

### 2.2 Balance Fetching (`src/start.ts:474-478`)

```typescript
// Balances - check the effective address (funder), not just signer
const usdc = await getUsdcBalance(state.wallet, state.address);  // Line 474
const pol = await getPolBalance(state.wallet, state.address);    // Line 475
logger.info(`USDC: ${$(usdc)}`);
logger.info(`POL: ${pol.toFixed(4)}`);
state.startBalance = usdc;
```

**✅ CORRECT:** Balance checks use `state.address` (effectiveAddress).

### 2.3 Balance Function Implementation (`src/lib/balance.ts:11-18`)

```typescript
export async function getUsdcBalance(wallet: Wallet, address: string): Promise<number> {
  try {
    const contract = new Contract(POLYGON.USDC_ADDRESS, ERC20_ABI, wallet.provider);
    const balance = await contract.balanceOf(address);  // <-- Uses passed address
    return Number(balance) / 10 ** POLYGON.USDC_DECIMALS;
  } catch {
    return 0;
  }
}
```

**✅ CORRECT:** The function accepts an `address` parameter and uses it for the balance check.

### 2.4 Runtime Balance Refreshes

| Location | Code | Status |
|----------|------|--------|
| `src/start.ts:408` (printSummary) | `getUsdcBalance(state.wallet, state.address)` | ✅ Correct |
| `src/start.ts:365-366` (runPolReserveCheck) | `getPolBalance(state.wallet, state.address)` and `getUsdcBalance(state.wallet, state.address)` | ✅ Correct |
| `src/start.ts:474-475` (startup) | `getUsdcBalance(state.wallet, state.address)` and `getPolBalance(state.wallet, state.address)` | ✅ Correct |

### 2.5 Signer vs Effective Address Summary

| Scenario | Signer Address | Effective Address | Which is Used for Trading |
|----------|----------------|-------------------|---------------------------|
| **EOA Mode** (signatureType=0) | 0xABC... | 0xABC... | Same address |
| **Proxy Mode** (signatureType=1) | 0xABC... (signs) | 0xDEF... (holds funds) | 0xDEF... |
| **Safe Mode** (signatureType=2) | 0xABC... (signs) | 0xDEF... (holds funds) | 0xDEF... |

---

## 3. LIVE_TRADING Gating Logic

### 3.1 LIVE_TRADING Check (`src/lib/auth.ts:148-151`)

```typescript
export function isLiveTradingEnabled(): boolean {
  const flag = process.env.LIVE_TRADING ?? process.env.ARB_LIVE_TRADING ?? "";
  return flag === "I_UNDERSTAND_THE_RISKS";  // Exact string match required
}
```

### 3.2 Where LIVE_TRADING is Checked

#### 3.2.1 Startup (`src/start.ts:438,442`)

```typescript
state.liveTrading = isLiveTradingEnabled();  // Line 438
// ...
logger.info(`Live Trading: ${state.liveTrading ? "ENABLED" : "DISABLED"}`);  // Line 442
```

#### 3.2.2 Buy Function (`src/start.ts:137-141`)

```typescript
if (!state.liveTrading) {
  logger.info(`🔸 [SIM] BUY ${outcome} ${$(size)} | ${reason}`);
  await sendTelegram("[SIM] BUY", `${reason}\n${outcome} ${$(size)}`);
  return true;  // <-- SHORT-CIRCUITS, no real order placed
}
```

#### 3.2.3 Sell Function (`src/start.ts:177-181`)

```typescript
if (!state.liveTrading) {
  logger.info(`🔸 [SIM] SELL ${outcome} ${$(sizeUsd)} | ${reason}`);
  await sendTelegram("[SIM] SELL", `${reason}\n${outcome} ${$(sizeUsd)}`);
  return true;  // <-- SHORT-CIRCUITS, no real order placed
}
```

#### 3.2.4 postOrder Function (`src/lib/order.ts:50-54`)

```typescript
// Check live trading
if (!isLiveTradingEnabled()) {
  logger?.warn?.(`[SIM] ${side} ${sizeUsd.toFixed(2)} USD - live trading disabled`);
  return { success: true, reason: "SIMULATED" };  // <-- Simulated order, no real execution
}
```

### 3.3 Simulation Mode Detection

**How to tell if bot is in simulation mode:**
1. Log messages contain `[SIM]` prefix
2. `postOrder()` returns `{ success: true, reason: "SIMULATED" }`
3. `LIVE_TRADING` env var is not set to `"I_UNDERSTAND_THE_RISKS"`

**This explains "no trades" when:**
- User expects live trades but LIVE_TRADING is not set correctly
- Bot appears "live" but all orders are simulated

---

## 4. Order/Balance Failure Causes

### 4.1 postOrder() Failure Reasons (`src/lib/order.ts`)

| Reason | Condition | Line |
|--------|-----------|------|
| `SIMULATED` | Live trading disabled | 51-54 |
| `ORDER_TOO_SMALL` | `sizeUsd < ORDER.MIN_ORDER_USD` (0.01) | 57-59 |
| `IN_FLIGHT` | Duplicate BUY within cooldown | 67-69 |
| `MARKET_COOLDOWN` | Same market order too soon | 74-76 |
| `MARKET_NOT_FOUND` | Market doesn't exist | 88-90 |
| `MARKET_CLOSED` | Orderbook fetch returns 404/closed | 102-104, 237-239 |
| `NO_ORDERBOOK` | Orderbook is null | 108-110 |
| `NO_ASKS` | BUY order, no asks available | 115-117 |
| `NO_BIDS` | SELL order, no bids available | 115-117 |
| `ZERO_PRICE` | Price ≤ 0.001 | 122-124 |
| `LOSER_POSITION` | BUY price < 0.10 (10¢) | 127-129 |
| `PRICE_TOO_HIGH` | BUY price > maxAcceptablePrice | 133-135 |
| `PRICE_TOO_LOW` | SELL price < maxAcceptablePrice | 136-138 |
| `NO_FILLS` | Order execution returned no fills | 234 |
| Error message | Unexpected error | 240 |

### 4.2 INSUFFICIENT_BALANCE_OR_ALLOWANCE Analysis

**Note:** The V2 codebase does NOT explicitly check balance/allowance before placing orders. This error would come from the CLOB API response.

If you see `INSUFFICIENT_BALANCE_OR_ALLOWANCE`:
1. The CLOB API is rejecting the order
2. The API is checking the **funder address** specified in the ClobClient
3. The funder address may have insufficient USDC or allowance

**Potential Root Cause:**
- If `POLYMARKET_PROXY_ADDRESS` is set incorrectly
- If the proxy address has no funds but signer has funds
- If allowance is not set for the CTF Exchange contract

### 4.3 Address-Related Order Failures

The V2 code correctly passes the effective address to ClobClient:

```typescript
// src/lib/auth.ts:117-124
const client = new ClobClient(
  POLYMARKET_API.CLOB,
  POLYGON.CHAIN_ID,
  wallet as any,
  creds,
  effectiveSignatureType,
  effectiveSignatureType > 0 ? funderAddress : undefined,  // <-- Funder passed here
);
```

**If orders fail with balance issues:**
1. The funder address is being used correctly by the SDK
2. Check on-chain if funder address has USDC balance
3. Check on-chain if funder address has allowance for CTF Exchange

---

## 5. Strategy/Risk Filters

### 5.1 Preset Configuration (`src/lib/presets.ts`)

Each preset has filters that can prevent orders:

#### Copy Trading Filters (`src/start.ts:316-319`)

```typescript
if (t.side !== "BUY") continue;  // Only copies BUY trades
if (t.price < cfg.minBuyPrice) continue;  // Default: 0.50 (50¢ minimum)
```

**Minimum buy prices by preset:**
- Conservative: 0.50 (50¢)
- Balanced: 0.50 (50¢)
- Aggressive: 0.50 (50¢)

#### Stack Strategy Filter (`src/start.ts:277-279`)

```typescript
if (p.gainCents < cfg.minGainCents || p.curPrice > cfg.maxPrice) continue;
if (p.curPrice < ORDER.GLOBAL_MIN_BUY_PRICE) continue;  // 0.10 (10¢)
```

#### Endgame Strategy Filter (`src/start.ts:296-298`)

```typescript
if (p.curPrice < cfg.minPrice || p.curPrice > cfg.maxPrice) continue;
if (p.pnlPct <= 0) continue;  // Must be profitable
```

### 5.2 Global Minimum Buy Price (`src/lib/constants.ts:30`)

```typescript
GLOBAL_MIN_BUY_PRICE: 0.10,  // 10¢ - prevents buying "loser" positions
```

This is enforced in:
- `src/lib/order.ts:127-129` (LOSER_POSITION check)
- `src/start.ts:279` (Stack strategy)

### 5.3 Risk Controls (`src/lib/presets.ts:61-68`)

```typescript
risk: {
  maxDrawdownPct: 20,        // Max portfolio drawdown
  maxDailyLossUsd: 100,      // Max daily loss
  maxOpenPositions: 100,     // Position limit
  hedgeBuffer: 10,           // Hedge buffer
  orderCooldownMs: 1000,     // Cooldown between orders
  maxOrdersPerHour: 200,     // Rate limit
}
```

**Note:** These risk controls are defined in presets but not all are enforced in V2. The `orderCooldownMs` maps to `ORDER.COOLDOWN_MS` in order.ts.

---

## 6. Production Debugging Checklist

### 6.1 Environment Variables to Print at Startup

Add this diagnostic output at startup:

```bash
# In your shell or .env validation script:
echo "=== Auth Diagnostics ==="
echo "PRIVATE_KEY length: ${#PRIVATE_KEY}"
echo "POLYMARKET_SIGNATURE_TYPE: ${POLYMARKET_SIGNATURE_TYPE:-0 (default EOA)}"
echo "POLYMARKET_PROXY_ADDRESS: ${POLYMARKET_PROXY_ADDRESS:-not set}"
echo "CLOB_FUNDER_ADDRESS: ${CLOB_FUNDER_ADDRESS:-not set}"
echo "LIVE_TRADING: ${LIVE_TRADING:-not set}"
echo "========================"
```

### 6.2 What to Log at Startup

The bot should log (and already does in most cases):

```
[AUTH] Signer Address (EOA): 0xABC...
[AUTH] Effective Address (for trading): 0xDEF...
[AUTH] Signature Type: 0|1|2
[AUTH] Mode: EOA|Proxy|Safe

[BALANCE] Checking address: 0xDEF...
[BALANCE] USDC: $XXX.XX
[BALANCE] POL: X.XXXX

[TRADING] Live Trading: ENABLED|DISABLED
```

### 6.3 On-Chain Verification

**For the EFFECTIVE address (state.address), verify:**

1. **USDC Balance:**
   ```
   https://polygonscan.com/token/0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174?a=YOUR_EFFECTIVE_ADDRESS
   ```

2. **USDC Allowance for CTF Exchange:**
   ```
   Contract: 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
   Method: allowance(owner, spender)
   owner: YOUR_EFFECTIVE_ADDRESS
   spender: 0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E (CTF Exchange)
   ```

3. **POL Balance (for gas):**
   ```
   https://polygonscan.com/address/YOUR_EFFECTIVE_ADDRESS
   ```

### 6.4 Validate Funder Address Usage

**Quick diagnostic code to add:**

```typescript
// In src/start.ts after auth (around line 470)
logger.info(`=== Address Diagnostic ===`);
logger.info(`Signer (wallet.address): ${state.wallet?.address}`);
logger.info(`Effective (state.address): ${state.address}`);
logger.info(`Same address: ${state.wallet?.address.toLowerCase() === state.address.toLowerCase()}`);
if (process.env.POLYMARKET_PROXY_ADDRESS) {
  logger.info(`Configured Proxy: ${process.env.POLYMARKET_PROXY_ADDRESS}`);
  logger.info(`Proxy matches effective: ${process.env.POLYMARKET_PROXY_ADDRESS.toLowerCase() === state.address.toLowerCase()}`);
}
logger.info(`==========================`);
```

### 6.5 Diagnostic Checklist

| Check | Expected | If Mismatch |
|-------|----------|-------------|
| `state.address` matches configured `POLYMARKET_PROXY_ADDRESS` | Yes (in proxy mode) | Auth not using proxy correctly |
| USDC balance at `state.address` > 0 | Yes | Funds in wrong address |
| USDC allowance at `state.address` for CTF Exchange > 0 | Yes | Need to approve spending |
| POL balance at signer address > 0 | Yes | Need gas for signing |
| `LIVE_TRADING === "I_UNDERSTAND_THE_RISKS"` | Yes (for live) | Orders are simulated |
| No `[SIM]` prefix in logs | Yes (for live) | Simulation mode active |

---

## 7. Root Cause Summary

### 7.1 Current State (V2 Codebase Analysis)

Based on code review, the V2 codebase **appears correctly implemented**:

1. ✅ `createClobClient()` correctly determines `effectiveAddress`
2. ✅ `state.address` is set to `effectiveAddress` (line 469)
3. ✅ Balance functions accept and use the passed address
4. ✅ Balance calls pass `state.address` (lines 408, 365-366, 474-475)
5. ✅ ClobClient receives funder address for proxy mode (lines 104, 123-124)

### 7.2 Potential Issues

#### Issue A: LIVE_TRADING Not Enabled
If `LIVE_TRADING !== "I_UNDERSTAND_THE_RISKS"`:
- All orders are simulated
- Logs show `[SIM]` prefix
- No actual trades executed

#### Issue B: Proxy Address Misconfiguration
If using proxy mode but `POLYMARKET_PROXY_ADDRESS` is wrong:
- Auth succeeds but points to wrong funder
- Balance shows $0 if wrong address has no funds
- CLOB API rejects orders (INSUFFICIENT_BALANCE)

#### Issue C: Missing Allowance
Even with correct address and balance:
- CTF Exchange needs USDC spending approval
- Error: INSUFFICIENT_BALANCE_OR_ALLOWANCE
- Fix: Call `USDC.approve(CTF_EXCHANGE, amount)` from funder

#### Issue D: Strategy Filters Blocking Orders
Copy trading filters may block orders:
- Price < 50¢ (`minBuyPrice: 0.50`)
- Not a BUY trade
- No recent trades from targets

### 7.3 Most Likely Cause of "No Trades"

**In order of likelihood:**

1. **LIVE_TRADING not set** → All orders simulated, look for `[SIM]` in logs
2. **No copy targets or no recent trades** → Check `TARGET_ADDRESSES` and target activity
3. **Price filters** → Target trades at <50¢ are ignored
4. **Allowance not set** → CLOB rejects orders even with balance

---

## 8. Implemented Fixes

The following fixes have been implemented in this codebase:

### 8.1 Enhanced Startup Diagnostics ✅ IMPLEMENTED

The startup sequence now includes comprehensive auth diagnostics using `getAuthDiagnostics()`:

```typescript
// In src/start.ts after authentication
const diag = getAuthDiagnostics(signerAddress, effectiveAddress);

logger.info(`\n=== Auth Diagnostics ===`);
logger.info(`Signature Type: ${diag.signatureType} (${diag.signatureTypeLabel})`);
logger.info(`Signer Address: ${signerAddress.slice(0, 10)}...${signerAddress.slice(-4)}`);
logger.info(`Effective Address: ${effectiveAddress.slice(0, 10)}...${effectiveAddress.slice(-4)}`);
if (diag.proxyAddress) {
  logger.info(`Configured Proxy: ${diag.proxyAddress.slice(0, 10)}...${diag.proxyAddress.slice(-4)}`);
}
logger.info(`Mode: ${diag.isProxyMode ? "Proxy/Safe (signer ≠ funder)" : "EOA (signer = funder)"}`);
logger.info(`========================\n`);
```

### 8.2 Allowance Check at Startup ✅ IMPLEMENTED

Added `getUsdcAllowance()` function in `src/lib/balance.ts`:

```typescript
/**
 * Get USDC allowance for CTF Exchange
 * This checks if the address has approved USDC spending for trading
 */
export async function getUsdcAllowance(wallet: Wallet, ownerAddress: string): Promise<number> {
  try {
    const contract = new Contract(POLYGON.USDC_ADDRESS, ERC20_ABI, wallet.provider);
    const allowance = await contract.allowance(ownerAddress, POLYGON.CTF_EXCHANGE);
    return Number(allowance) / 10 ** POLYGON.USDC_DECIMALS;
  } catch {
    return 0;
  }
}
```

Startup now checks and warns about insufficient allowance:

```typescript
const allowance = await getUsdcAllowance(state.wallet, state.address);
logger.info(`USDC Allowance: ${$(allowance)}`);

// Warn if allowance might cause issues
if (allowance === 0 && usdc > 0) {
  logger.warn(`⚠️ No USDC allowance set. Orders will fail. Approve CTF Exchange first.`);
} else if (allowance < usdc && usdc > 0) {
  logger.warn(`⚠️ Allowance (${$(allowance)}) < Balance (${$(usdc)}). Large orders may fail.`);
}
```

### 8.3 Auth Diagnostics Utility ✅ IMPLEMENTED

Added `getAuthDiagnostics()` function in `src/lib/auth.ts` to centralize diagnostic logic:

```typescript
export interface AuthDiagnostics {
  signatureType: string;
  signatureTypeLabel: string;
  proxyAddress: string | undefined;
  isProxyMode: boolean;
}

export function getAuthDiagnostics(
  signerAddress: string,
  effectiveAddress: string,
): AuthDiagnostics {
  // Reads env vars and computes mode info
  // ...
}
```

### 8.4 Verbose Order Logging (Optional)

In `src/lib/order.ts`, you can add after line 47 for more verbose order tracking:

```typescript
logger?.info?.(`[ORDER] ${side} ${sizeUsd.toFixed(2)} USD for token ${tokenId.slice(0, 10)}...`);
```

### 8.5 Copy Trading Diagnostics (Optional)

In `src/start.ts` `runCopyTrading()`, add logging:

```typescript
async function runCopyTrading(): Promise<void> {
  if (state.targets.length === 0) {
    logger.info(`[COPY] No targets configured`);
    return;
  }

  const trades = await fetchRecentTrades(state.targets);
  logger.info(`[COPY] Found ${trades.length} recent trades from ${state.targets.length} targets`);
  
  const cfg = state.config.copy;

  for (const t of trades) {
    if (t.side !== "BUY") {
      logger.info(`[COPY] Skipped SELL trade from ${t.trader.slice(0, 8)}`);
      continue;
    }
    if (t.price < cfg.minBuyPrice) {
      logger.info(`[COPY] Skipped: price ${(t.price * 100).toFixed(0)}¢ < min ${(cfg.minBuyPrice * 100).toFixed(0)}¢`);
      continue;
    }
    // ... rest of function
  }
}
```

---

## Summary

The V2 codebase **correctly handles** the signer vs effective address distinction. The most likely causes of "no trades" are:

1. **LIVE_TRADING not enabled** - Check for `[SIM]` in logs
2. **No copy targets or inactive targets** - Check TARGET_ADDRESSES
3. **Strategy filters** - Price < 50¢ or not a BUY
4. **Missing allowance** - Approve USDC for CTF Exchange

Use the diagnostic checklist in Section 6 to systematically verify each component.
