# 🔴 CRITICAL: Polymarket Bot Authentication & Gas Waste Analysis

## 🚨 Executive Summary

**CRITICAL BUG IDENTIFIED**: Bot sends approval transactions (~$40 each at 195 gwei) even after authentication fails with 401.

**Root Cause**: `ensureTradingReady()` in `src/polymarket/preflight.ts` does NOT block approvals when `authOk=false`.

**Impact**: 
- ❌ Wasted gas on failed approval transactions
- ❌ No gas price ceiling (accepts RPC fees up to 195+ gwei)
- ❌ Retry logic attempts 3x even after auth failure

---

## 📊 Analysis Results

### ✅ What's Working Well

1. **Wallet Type Auto-Detection** - Already implemented (EOA/Safe/Proxy)
2. **Auth Story Logging** - Comprehensive diagnostic output exists
3. **Credential Derivation** - Auto-derives from private key with fallback
4. **Structured Logging** - Has runId/reqId tracking infrastructure

### ❌ Critical Issues Found

#### 1. Auth Failure Does NOT Block Approvals ⚠️  HIGHEST PRIORITY

**File**: `src/polymarket/preflight.ts`  
**Lines**: 473-490  

```typescript
// CURRENT CODE (BUGGY):
if (!liveTradingEnabled) {
  return { detectOnly: true, authOk, approvalsOk: false, geoblockPassed };
}

// ❌ BUG: Approvals run even if authOk=false
let approvalResult;
try {
  approvalResult = await ensureApprovals({  // NO AUTH CHECK GUARD!
    wallet,
    owner: tradingAddress,
    relayer: relayer.enabled ? relayer : undefined,
    logger: params.logger,
    config: approvalsConfig,
  });
}
```

**Fix Required**:
```typescript
if (!liveTradingEnabled) {
  return { detectOnly: true, authOk, approvalsOk: false, geoblockPassed };
}

// ✅ ADD THIS GUARD:
if (!authOk) {
  params.logger.error("[Preflight] ⚠️  BLOCKING APPROVALS: Authentication failed");
  params.logger.error("[Preflight] Skipping on-chain approval transactions to prevent gas waste");
  
  authStory.setFinalResult({
    authOk: false,
    readyToTrade: false,
    reason: "AUTH_FAILED",
  });
  authStory.printSummary();
  
  return { detectOnly: true, authOk: false, approvalsOk: false, geoblockPassed };
}

// Now safe to run approvals...
let approvalResult;
```

---

#### 2. No Gas Price Cap ⚠️  HIGH PRIORITY

**File**: `src/utils/gas.ts`  
**Lines**: 31-109

**Problem**: Bot accepts any gas price from RPC (195 gwei = ~$40 per tx)

**Current Code**:
```typescript
export const estimateGasFees = async (params: GasEstimateParams) => {
  const multiplier = params.multiplier ?? 
    parseFloat(readEnv("POLY_GAS_MULTIPLIER") || "1.2");
  const minPriorityFeeGwei = params.maxPriorityFeeGwei ?? 
    parseFloat(readEnv("POLY_MAX_PRIORITY_FEE_GWEI") || "30");
  const minMaxFeeGwei = params.maxFeeGwei ?? 
    parseFloat(readEnv("POLY_MAX_FEE_GWEI") || "60");
  
  // ... calculation logic ...
  
  // ❌ NO MAX CAP!
  return { maxPriorityFeePerGas, maxFeePerGas };
};
```

**Fix Required**:
```typescript
export const estimateGasFees = async (params: GasEstimateParams) => {
  // ... existing code ...
  
  // ✅ ADD GAS CAP:
  const maxGasPriceCap = parseFloat(
    readEnv("POLY_MAX_FEE_GWEI_CAP") || "200"
  );
  
  if (maxFeePerGas > parseGwei(maxGasPriceCap)) {
    const currentGwei = formatUnits(maxFeePerGas, "gwei");
    params.logger?.error(
      `[Gas] REJECTING transaction: gas price ${currentGwei} gwei exceeds cap ${maxGasPriceCap} gwei`
    );
    throw new Error(
      `Gas price ${currentGwei} gwei exceeds safety cap ${maxGasPriceCap} gwei`
    );
  }
  
  params.logger?.info(
    `[Gas] Selected maxPriorityFeePerGas=${formatUnits(maxPriorityFeePerGas, "gwei")} gwei maxFeePerGas=${formatUnits(maxFeePerGas, "gwei")} gwei (cap=${maxGasPriceCap})`
  );
  
  return { maxPriorityFeePerGas, maxFeePerGas };
};
```

---

#### 3. Retry Logic Ignores Auth State ⚠️  MEDIUM PRIORITY

**File**: `src/polymarket/approvals.ts`  
**Lines**: 329-357

**Problem**: Approval transactions retry 3x even if original issue was auth failure

**Fix**: Pass `authOk` context to `ensureApprovals()` and skip retry if auth failed

---

## 🗺️ Authentication Flow Map

```
┌─────────────────────────────────────────────────────────────┐
│ Entry: src/app/main.ts::main()                             │
└────────────┬────────────────────────────────────────────────┘
             │
             ├─ VPN Setup (openvpn/wireguard)
             │
             v
┌─────────────────────────────────────────────────────────────┐
│ STEP 1: Create CLOB Client                                 │
│ src/infrastructure/clob-client.factory.ts                  │
│   createPolymarketClient()                                  │
│                                                             │
│   ├─ Derive/Load Credentials                                │
│   │   ├─ Try user-provided keys                             │
│   │   └─ Or derive from PRIVATE_KEY                         │
│   │                                                          │
│   ├─ Auto-Detect Signature Type                             │
│   │   ├─ Try: SignatureType.EOA (0)                         │
│   │   ├─ Try: SignatureType.POLY_GNOSIS_SAFE (2)            │
│   │   └─ Try: SignatureType.POLY_PROXY (1)                  │
│   │                                                          │
│   └─ Verify Credentials                                     │
│       └─ verifyCredsWithAutoSignatureType()                 │
│           └─ GET /balance-allowance for each type           │
│               ├─ 200 OK → valid=true                        │
│               └─ 401/403 → try next type                    │
│                                                             │
└────────────┬────────────────────────────────────────────────┘
             │
             v
┌─────────────────────────────────────────────────────────────┐
│ STEP 2: Preflight & Approvals                              │
│ src/polymarket/preflight.ts                                │
│   ensureTradingReady()                                      │
│                                                             │
│   Phase 1: Auth Verification                                │
│   ├─ runClobAuthPreflight()                                 │
│   │   └─ GET /balance-allowance                             │
│   │       ├─ 200 OK → authOk=true ✅                        │
│   │       └─ 401/403 → authOk=false, detectOnly=true ❌     │
│   │                                                          │
│   Phase 2: Geoblock Check                                   │
│   ├─ isGeoblocked()                                         │
│   │   └─ blocked → geoblockPassed=false                     │
│   │                                                          │
│   Phase 3: Live Trading Gate                                │
│   └─ if (!liveTradingEnabled)                               │
│       └─ return early (skip approvals) ✅                   │
│                                                             │
│   ❌ BUG: Phase 4 Missing Auth Gate                         │
│   Phase 4: Approvals (RUNS EVEN IF authOk=false!)          │
│   └─ ensureApprovals()                                      │
│       ├─ fetchApprovalSnapshot()                            │
│       │   └─ Read USDC/ERC1155 allowances                   │
│       │                                                      │
│       ├─ getApprovalDecision()                              │
│       │   └─ Decide which approvals needed                  │
│       │                                                      │
│       └─ if APPROVALS_AUTO=true:                            │
│           └─ For each approval:                             │
│               ├─ buildTxOverrides() [estimateGasFees]       │
│               │   └─ 195 gwei (NO CAP!) ❌                  │
│               │                                              │
│               └─ contract.approve() ← ~$40 GAS WASTED       │
│                   └─ retryTxWithBackoff (3 attempts)        │
│                                                             │
└────────────┬────────────────────────────────────────────────┘
             │
             v
┌─────────────────────────────────────────────────────────────┐
│ STEP 3: Auth Story Summary                                 │
│ src/clob/auth-story.ts                                     │
│                                                             │
│   authStory.printSummary()                                  │
│   ├─ Identity: mode, sigType, addresses                     │
│   ├─ Attempts: [A] ❌ FAILED (401)                          │
│   └─ Result: authOk=false, readyToTrade=false              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
             │
             v
┌─────────────────────────────────────────────────────────────┐
│ STEP 4: Runtime                                            │
│                                                             │
│   if detectOnly:                                            │
│     └─ Monitor only (no order submissions)                  │
│   else:                                                     │
│     └─ Active trading                                       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 🔧 Recommended Fixes (Priority Order)

### Priority 1: Block Approvals on Auth Failure

**File**: `src/polymarket/preflight.ts`  
**Location**: After line 471, before line 473

```typescript
if (!authOk) {
  params.logger.error(
    "[Preflight] ⚠️  BLOCKING APPROVALS: Authentication failed"
  );
  params.logger.error(
    "[Preflight] Skipping on-chain approval transactions to prevent gas waste"
  );
  params.logger.error(
    "[Preflight] Run 'npm run auth:diag' for detailed diagnostics"
  );
  
  authStory.setFinalResult({
    authOk: false,
    readyToTrade: false,
    reason: "AUTH_FAILED",
  });
  authStory.printSummary();
  
  (
    params.client as ClobClient & {
      relayerContext?: ReturnType<typeof createRelayerContext>;
    }
  ).relayerContext = relayer;
  
  return { 
    detectOnly: true, 
    authOk: false, 
    approvalsOk: false, 
    geoblockPassed 
  };
}
```

### Priority 2: Add Gas Price Cap

**File**: `src/utils/gas.ts`  
**Location**: After line 77, before return statement

```typescript
// Add gas price cap safety check
const maxGasPriceCap = parseFloat(
  readEnv("POLY_MAX_FEE_GWEI_CAP") || "200"
);

if (maxFeePerGas > parseGwei(maxGasPriceCap)) {
  const currentGwei = formatUnits(maxFeePerGas, "gwei");
  const errorMsg = `Gas price ${currentGwei} gwei exceeds safety cap ${maxGasPriceCap} gwei`;
  params.logger?.error(`[Gas] REJECTING transaction: ${errorMsg}`);
  throw new Error(errorMsg);
}

params.logger?.info(
  `[Gas] Selected maxPriorityFeePerGas=${formatUnits(maxPriorityFeePerGas, "gwei")} gwei maxFeePerGas=${formatUnits(maxFeePerGas, "gwei")} gwei (cap=${maxGasPriceCap} gwei) multiplier=${multiplier}`,
);
```

### Priority 3: Enhanced Logging

Add gas cost estimation to auth story:

```typescript
// src/clob/auth-story.ts - add interface
export interface GasSnapshot {
  maxFeePerGasGwei: string;
  maxPriorityFeePerGasGwei: string;
  estimatedCostUsd?: string;
  timestamp: number;
}

// Update AuthAttempt interface to include gas info
export interface AuthAttempt {
  // ... existing fields ...
  gasSnapshot?: GasSnapshot;
}
```

---

## 📝 Environment Variables

### Required New Variables

Add to `.env`:

```bash
# ============================================================================
# Gas Safety Controls
# ============================================================================

# Maximum gas price cap (rejects transactions above this)
# Default: 200 gwei
# Recommended: 150-200 for normal operations, 300 for urgent
POLY_MAX_FEE_GWEI_CAP=200

# Gas price multiplier (applied to RPC estimates)
# Default: 1.2 (20% bump)
POLY_GAS_MULTIPLIER=1.2

# Minimum priority fee (floor)
# Default: 30 gwei
POLY_MAX_PRIORITY_FEE_GWEI=30

# Minimum max fee (floor)
# Default: 60 gwei  
POLY_MAX_FEE_GWEI=60

# ============================================================================
# Approval Safety Controls
# ============================================================================

# Block approvals if authentication fails
# Default: true
BLOCK_APPROVALS_ON_AUTH_FAILURE=true

# Auto-approve tokens (true/false/dryrun)
# Default: true
APPROVALS_AUTO=true

# Use relayer for gasless approvals (if available)
# Default: true
USE_RELAYER_FOR_APPROVALS=true

# Max retry attempts for failed approval transactions
# Default: 3
APPROVALS_MAX_RETRY_ATTEMPTS=3
```

---

## 🧪 Diagnostic Commands

```bash
# Check authentication status
npm run auth:diag

# Detailed debug logs
LOG_LEVEL=debug npm run auth:diag

# Check wallet type and current approvals
npm run wallet:detect
npm run check-allowance

# Dry-run approvals (simulation, no gas)
APPROVALS_AUTO=dryrun npm start

# Test with auth blocking enabled
BLOCK_APPROVALS_ON_AUTH_FAILURE=true npm start
```

---

## 📈 Success Metrics

After fixes are implemented:

✅ **Zero gas waste** - No approval transactions sent when auth fails  
✅ **Gas price safety** - Transactions rejected above configured cap  
✅ **Clear diagnostics** - Auth story shows why trading is blocked  
✅ **Fast failure** - Early exit prevents unnecessary on-chain operations  

---

## 📚 Key Files Reference

| File | Purpose | Lines |
|------|---------|-------|
| `src/app/main.ts` | Main entry point | 1-180 |
| `src/infrastructure/clob-client.factory.ts` | CLOB client creation & auth | 431-812 |
| `src/polymarket/preflight.ts` | Preflight checks & approvals | 88-616 |
| `src/polymarket/approvals.ts` | Approval transaction logic | 179-401 |
| `src/utils/gas.ts` | Gas estimation & pricing | 31-152 |
| `src/clob/auth-story.ts` | Auth diagnostic logging | 1-422 |
| `src/clob/diagnostics.ts` | Auth verification helpers | 1-100+ |

---

## 🎯 Definition of Done

- [ ] Auth failure blocks approval transactions (no gas waste)
- [ ] Gas price cap prevents excessive fees (configurable ceiling)
- [ ] Auth story includes gas cost estimates
- [ ] Environment variables documented
- [ ] Diagnostic commands tested
- [ ] CI/CD lint passes (no console.log, no secrets in logs)
- [ ] Integration test: auth fails → approvals skipped → zero gas spent

