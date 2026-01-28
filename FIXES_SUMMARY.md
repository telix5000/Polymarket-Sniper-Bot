# Trading Bot Fixes - Implementation Summary

## Overview
Fixed 6 critical issues causing the bot to accept bad trades (1¢/99¢ spreads, tiny $24 flow signals). All changes are surgical and deterministic.

---

## ✅ TASK 1: FIX BIAS THRESHOLDS - Make bias eligibility strict

### Changes Made:
1. **Updated `getBias()` method** (lines ~1411-1457)
   - Now enforces **ALL** criteria in conservative mode:
     * `abs(flow_usd) >= BIAS_MIN_NET_USD` (default 300)
     * `trade_count >= BIAS_MIN_TRADES` (default 3)
     * `last_trade_age_seconds <= BIAS_STALE_SECONDS` (default 900)
   - `copyAnyWhaleBuy` mode still works with 1 trade minimum

2. **Updated `getActiveBiases()` method** (lines ~1462-1510)
   - Conservative mode now only returns biases with direction === "LONG"
   - This means ALL thresholds passed (not just some)

3. **Enhanced `canEnter()` method** (lines ~1493-1535)
   - Added detailed rejection logging:
     * "BIAS_STALE (last: Xs ago)"
     * "BIAS_BELOW_MIN_TRADES (X < Y)"
     * "BIAS_BELOW_MIN_FLOW ($X < $Y)"
   - Clear diagnostic output for debugging

4. **Added ENV support** (lines ~350-357)
   - `BIAS_MIN_NET_USD=300`
   - `BIAS_MIN_TRADES=3`
   - `BIAS_STALE_SECONDS=900`

### Result:
- Bot will **reject** signals with flow < $300
- Bot will **reject** signals with < 3 trades
- Bot will **reject** stale signals (>15min old)
- Clear logs explain WHY each signal was rejected

---

## ✅ TASK 2: UNIFY SPREAD THRESHOLD - Fix the "max 4¢" conflict

### Changes Made:
1. **Updated `checkLiquidity()` method** (lines ~2718-2764)
   - **REMOVED** the `min(minSpreadCents, 2*churnCostCentsEstimate)` logic
   - Now uses **ONLY** `config.minSpreadCents` for the gate
   - Added log: "Spread check: X¢ vs max Y¢"

2. **Updated ENV support** (lines ~337-343)
   - `MIN_SPREAD_CENTS=6` (from ENV)
   - `MIN_DEPTH_USD_AT_EXIT=25` (from ENV)

### Result:
- Liquidity gate now uses **consistent 6¢ max spread** from ENV
- No more "4¢ max when config is 6¢" conflict
- Dynamic slippage affects ORDER PRICING, not gate thresholds

---

## ✅ TASK 3: ADD ORDERBOOK SANITY GATE - Reject dust books immediately

### Changes Made:
1. **Added sanity checks in `fetchTokenMarketDataWithReason()`**

   **For MarketDataFacade path** (lines ~6108-6147):
   - Check for dust book: `bid <= 2¢ AND ask >= 98¢` → reject as "DUST_BOOK"
   - Check for invalid prices: `bid <= 0 OR ask <= 0 OR isNaN` → reject as "INVALID_PRICES"
   - Check spread: `spread > MIN_SPREAD_CENTS` → reject as "INVALID_LIQUIDITY"

   **For direct API path** (lines ~6191-6237):
   - Same checks after parsing bestBid/bestAsk
   - Fail-fast before computing depth

2. **Added new failure reason types** (lines ~3111-3119)
   - `"INVALID_LIQUIDITY"` - Spread too wide (permanent)
   - `"DUST_BOOK"` - 1¢/99¢ spreads (permanent)
   - `"INVALID_PRICES"` - Missing/zero/NaN prices (permanent)

### Result:
- Bot **immediately rejects** 1¢/99¢ dust books
- Bot **immediately rejects** spreads > 6¢
- Bot **immediately rejects** invalid/missing prices
- NO cooldown for these (not transient errors)

---

## ✅ TASK 4: VALIDATE TOKEN ID MAPPING - Add diagnostics

### Changes Made:
1. **Enhanced whale trade processing** (lines ~1288-1320)
   - Added logging for:
     * `conditionId`
     * `outcome` (YES/NO)
     * `tokenId`
     * Trade size
   - **Reject immediately** if tokenId is empty/invalid
   - Debug logs show: "Candidate: tokenId=... | conditionId=... | outcome=... | size=$X"

2. **Validation logic**:
   ```typescript
   if (!tokenId || tokenId.trim() === "") {
     debug(`[Whale Trade] Rejected: empty tokenId | conditionId: ${conditionId} ...`);
     continue; // Skip this trade
   }
   ```

### Result:
- Invalid tokenIds are **rejected immediately**
- No entry attempts on malformed whale trades
- Clear diagnostic output for debugging mapping issues

---

## ✅ TASK 5: FIX COOLDOWN POLICY - Only cooldown transient errors

### Changes Made:
1. **Rewrote `shouldCooldownOnFailure()` function** (lines ~138-156)
   
   **COOLDOWN (transient errors):**
   - `rate_limit` / `rate limit`
   - `network_error` / `network error`
   - `order placement` / `order failed`
   - `timeout`

   **NO COOLDOWN (permanent market conditions):**
   - `invalid liquidity`
   - `dust book`
   - `spread > X`
   - `depth`
   - `price outside bounds`

2. **Added ENV var** (lines ~222-226)
   - `ENTRY_COOLDOWN_SECONDS_TRANSIENT=30` (default)

3. **Updated cooldown logic** (lines ~4350-4357)
   - Changed from fixed 60s to configurable value
   - Getter: `get FAILED_ENTRY_COOLDOWN_MS(): number { return this.config.entryCooldownSecondsTransient * 1000; }`

4. **Updated log messages** (lines ~5414-5422, ~5583-5591)
   - "Token on cooldown for Xs (transient error)"

### Result:
- Bot **does NOT cooldown** for dust books, bad spreads, depth issues
- Bot **DOES cooldown** for rate limits, network errors, order failures
- Configurable cooldown duration (default 30s)

---

## ✅ TASK 6: ADD DIAGNOSTICS COUNTERS - Track the funnel

### Changes Made:
1. **Added counters to diagnostics** (lines ~4366-4369)
   ```typescript
   candidatesSeen: 0,              // Total candidates processed
   candidatesRejectedLiquidity: 0, // Rejected: spread/depth/dust book
   ```
   Note: Bias rejections are already tracked via entryFailureReasons

2. **Added tracking in processing logic**:
   - **candidatesSeen**: Incremented for each bias processed (line ~5375)
   - **candidatesRejectedLiquidity**: Incremented when market data fails with INVALID_LIQUIDITY/DUST_BOOK/INVALID_PRICES (lines ~5477-5481)

3. **Display in status output** (lines ~5839-5842)
   ```
   🔬 Funnel: Candidates seen: X | Rejected liquidity: Y
   ```

### Result:
- Bot tracks entry funnel at key points
- Status output shows where candidates are filtered
- Bias rejections tracked via existing entryFailureReasons logging
- Easy to diagnose if funnel is broken

---

## ENV Variables Added/Updated

### New ENV Variables:
```bash
BIAS_MIN_NET_USD=300                      # Minimum net flow for bias (default: $300)
BIAS_MIN_TRADES=3                         # Minimum trades for bias (default: 3)
BIAS_STALE_SECONDS=900                    # Bias staleness threshold (default: 15min)
MIN_SPREAD_CENTS=6                        # Max acceptable spread (default: 6¢)
MIN_DEPTH_USD_AT_EXIT=25                  # Min depth to exit (default: $25)
PREFERRED_ENTRY_LOW_CENTS=35              # Preferred entry low (default: 35¢)
PREFERRED_ENTRY_HIGH_CENTS=65             # Preferred entry high (default: 65¢)
MIN_ENTRY_PRICE_CENTS=30                  # Min entry price (default: 30¢)
MAX_ENTRY_PRICE_CENTS=82                  # Max entry price (default: 82¢)
ENTRY_COOLDOWN_SECONDS_TRANSIENT=30       # Cooldown for transient errors (default: 30s)
```

All have sensible defaults and can be overridden via environment variables.

---

## Testing Recommendations

### 1. Test Bias Thresholds
```bash
# Should reject signals with < $300 flow
# Should reject signals with < 3 trades  
# Should reject stale signals (>15min)
# Logs should explain WHY rejected
# Entry failure reasons will track rejections
```

### 2. Test Spread Gate
```bash
# Should reject spreads > 6¢
# Should accept spreads <= 6¢
# No more "4¢ max" conflict
```

### 3. Test Dust Book Rejection
```bash
# Should immediately reject: bid=1¢, ask=99¢
# Should immediately reject: bid=0, ask=0
# Should NOT cooldown these tokens
```

### 4. Test Cooldown Policy
```bash
# Rate limit → cooldown for 30s
# Network error → cooldown for 30s
# Dust book → NO cooldown
# Wide spread → NO cooldown
```

### 5. Test Funnel Counters
```bash
# Status output should show:
# - candidatesSeen (increments per entry attempt)
# - candidatesRejectedLiquidity (dust book, wide spread, etc.)
# Bias rejections tracked via entryFailureReasons
```

---

## Files Modified

1. **src/start.ts** (main file)
   - Updated `shouldCooldownOnFailure()` function
   - Updated `getBias()`, `getActiveBiases()`, `canEnter()` methods in BiasAccumulator
   - Updated `checkLiquidity()` method in DecisionEngine
   - Enhanced `fetchTokenMarketDataWithReason()` with sanity gates
   - Added diagnostics counters and funnel tracking
   - Added `getRejectedBiasCount()` method
   - Updated config loading with ENV support
   - Updated cooldown logic and messaging

---

## Summary

All 6 tasks completed successfully:
1. ✅ Strict bias thresholds with logging
2. ✅ Unified spread threshold (6¢ from ENV)
3. ✅ Orderbook sanity gates (reject dust books)
4. ✅ Token ID validation with diagnostics
5. ✅ Fixed cooldown policy (transient only)
6. ✅ Added funnel tracking counters

**Build Status:** ✅ Compiles successfully
**Code Style:** Surgical changes only, no redesign
**Determinism:** All checks are explicit and logged
**Testing:** Ready for testing with default ENV values

The bot will now:
- Only accept signals with ≥$300 flow and ≥3 trades
- Reject 1¢/99¢ dust books immediately
- Use consistent 6¢ spread threshold
- Only cooldown for transient errors (30s)
- Track full entry funnel for diagnostics
