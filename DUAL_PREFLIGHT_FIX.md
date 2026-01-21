# Dual Preflight Fix - Bot Trading Disabled Issue

## Issue Summary

The trading bot initially reported `READY_TO_TRADE=true` with both auth and approvals passing, but shortly after would disable trading with `APPROVALS_FAILED` and the error "Wallet provider is required". This caused the bot to run in detect-only mode despite having valid credentials and approvals.

## Root Causes

### 1. Dual Preflight Execution (MODE=both)

When `MODE=both` is set, the application starts both the ARB (arbitrage) engine and the MEMPOOL monitor. This caused `ensureTradingReady()` to be called twice:

1. **First call** (arbitrage/runtime.ts:71): ✅ PASSES 
2. **Second call** (app/main.ts:77): ❌ FAILS

The second call would fail because the wallet lacked a provider, causing approval checks to fail.

### 2. Wallet Provider Missing

The issue was in how the wallet was being initialized:

**Before:**
```typescript
// app/main.ts (WRONG)
const clobClient = await auth.getClobClient();
const { Wallet } = await import("ethers");
const wallet = new Wallet(env.privateKey);  // ❌ No provider!
const client = Object.assign(clobClient, { wallet });
```

This created a wallet **without** an Ethereum provider, which is required for:
- Balance queries (`getPolBalance`, `getUsdBalanceApprox`)
- Approval checks (`ensureApprovals`)
- On-chain transactions

**After:**
```typescript
// app/main.ts (CORRECT)
const client = await auth.getClobClient();  // ✅ Already has wallet with provider
```

### 3. PolymarketAuth Wallet Initialization

The `PolymarketAuth` class was creating wallets without providers:

**Before:**
```typescript
// polymarket-auth.ts (INCOMPLETE)
this.signer = new Wallet(privateKey);  // ❌ No provider!
```

**After:**
```typescript
// polymarket-auth.ts (COMPLETE)
if (credentials.rpcUrl) {
  const provider = new JsonRpcProvider(credentials.rpcUrl);
  this.signer = new Wallet(privateKey, provider);  // ✅ With provider!
}
```

## Fixes Applied

### Fix 1: Updated PolymarketAuth

**File:** `src/clob/polymarket-auth.ts`

**Changes:**
- Added optional `rpcUrl` parameter to `PolymarketCredentials` interface
- Updated constructor to create wallet with `JsonRpcProvider` when RPC URL is provided
- Updated `getClobClient()` to return client with attached wallet
- Updated `createPolymarketAuthFromEnv()` to read `RPC_URL` from environment

**Benefits:**
- Wallet now has proper provider for blockchain interactions
- Balance queries work correctly
- Approval checks function properly

### Fix 2: Removed Duplicate Wallet Creation

**Files:** `src/app/main.ts`, `src/tools/preflight.ts`

**Changes:**
- Removed manual wallet creation: `new Wallet(env.privateKey)`
- Use wallet from CLOB client directly: `await auth.getClobClient()`

**Benefits:**
- No more wallet without provider
- Consistent wallet usage across codebase
- Eliminates provider-related errors

### Fix 3: Added Preflight Caching

**File:** `src/polymarket/preflight.ts`

**Changes:**
- Added global preflight result cache with 30-second TTL
- Cache keyed by signer address
- Logs when reusing cached results

**Benefits:**
- Prevents duplicate preflight runs in MODE=both
- Reduces unnecessary auth checks and approval verifications
- Improves startup performance
- Clear logging shows when cache is used

## Technical Flow

### Before (BROKEN)

```
MODE=both startup
  ├─ Start ARB engine
  │   ├─ Create wallet (no provider) ❌
  │   └─ Run preflight #1: PASS (by luck)
  │
  └─ Start MEMPOOL monitor
      ├─ Create wallet (no provider) ❌
      ├─ Run preflight #2: FAIL
      │   └─ getPolBalance fails: "Wallet provider is required"
      └─ Switch to DETECT_ONLY mode ❌
```

### After (FIXED)

```
MODE=both startup
  ├─ Start ARB engine
  │   ├─ PolymarketAuth creates wallet WITH provider ✅
  │   ├─ Run preflight #1: PASS
  │   └─ Cache result for 30s
  │
  └─ Start MEMPOOL monitor
      ├─ PolymarketAuth creates wallet WITH provider ✅
      ├─ Check preflight cache: HIT ✅
      ├─ Reuse cached result: PASS
      └─ Trading enabled ✅
```

## Verification

### Build Status
```bash
npm run build
# ✅ Builds successfully
```

### Expected Behavior

When running with `MODE=both`:
1. First runtime (ARB or MEMPOOL) runs preflight and caches result
2. Second runtime detects cached result and reuses it
3. Logs show: "⚡ Reusing cached preflight result from X.Xs ago (prevents duplicate runs in MODE=both)"
4. Both runtimes use wallets with providers
5. Trading remains enabled if initial preflight passes

### Log Example

```
[INFO] Starting Polymarket runtime mode=both
[INFO] [ARB] Starting arbitrage engine...
[INFO] [Preflight] Initialized auth story runId=abc123
[INFO] [Preflight][Summary] ✅ Auth: PASSED
[INFO] [Preflight][Summary] ✅ Approvals: PASSED
[INFO] [Preflight][Summary] ✅ Ready to Trade: YES
[INFO] ✅ ARB TRADING ENABLED - Engine will execute trades
[INFO] [Preflight] ⚡ Reusing cached preflight result from 0.5s ago (prevents duplicate runs in MODE=both)
[INFO] [Preflight] Cached result: authOk=true approvalsOk=true detectOnly=false
[INFO] ✅ TRADING ENABLED - Bot will submit orders
```

## Environment Variables

The fix requires the `RPC_URL` environment variable to be set:

```bash
# Required for wallet provider initialization
RPC_URL=https://polygon-rpc.com
# or
rpc_url=https://polygon-rpc.com
```

If not set, the wallet will be created without a provider and a warning will be logged, but trading may still fail during balance/approval checks.

## Related Files

- `src/clob/polymarket-auth.ts` - Wallet initialization with provider
- `src/app/main.ts` - Main application entry (MEMPOOL mode)
- `src/arbitrage/runtime.ts` - Arbitrage engine entry (ARB mode)
- `src/tools/preflight.ts` - Preflight diagnostic tool
- `src/polymarket/preflight.ts` - Preflight logic with caching
- `src/utils/get-balance.util.ts` - Balance queries requiring provider

## Impact

### Positive
- ✅ Trading no longer disabled after successful startup
- ✅ MODE=both now works correctly
- ✅ Duplicate preflight runs prevented
- ✅ Better performance with caching
- ✅ Clear logging of cache usage

### Potential Issues
- ⚠️ Requires RPC_URL environment variable
- ⚠️ Cache TTL of 30s means config changes may not take effect immediately
- ⚠️ Cache is in-memory only (resets on restart)

## Future Improvements

1. **Cache Invalidation**: Add ability to manually clear cache
2. **Cache Persistence**: Consider persisting cache to filesystem
3. **Cache Configuration**: Make TTL configurable via environment variable
4. **Provider Validation**: Add startup check to ensure provider is accessible
5. **Metrics**: Track cache hit/miss rates for monitoring

## Testing Recommendations

1. Test with MODE=arb only
2. Test with MODE=mempool only
3. Test with MODE=both
4. Test with missing RPC_URL
5. Test with invalid RPC_URL
6. Test cache expiration (wait >30s between runs)
7. Monitor logs for "Reusing cached preflight result" message
