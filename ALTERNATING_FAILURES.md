# Understanding Alternating Authentication Failures

## Problem Description

Users report that the Polymarket CLOB bot alternates between two distinct failure modes:

1. **L2 Verify Fails**: `401 Unauthorized/Invalid api key` when calling `/balance-allowance`
2. **L1 Auth Fails**: `401 Unauthorized - Invalid L1 Request headers` when calling `/auth/derive-api-key` or `/auth/api-key`

This document explains why this happens and how the bot now handles it correctly.

## Root Cause: Complex Wallet Identity Model

Polymarket supports multiple wallet types with different authentication requirements:

### Wallet Types

1. **EOA (Externally Owned Account)**: Standard wallet (signature_type=0)
   - Single address for everything
   - Simplest case

2. **Gnosis Safe**: Browser wallet created via polymarket.com (signature_type=2)
   - **Signer EOA**: The private key that controls the Safe
   - **Safe Contract**: The actual Safe contract address
   - Split identity: signer signs, Safe is the maker/funder

3. **Polymarket Proxy**: Legacy proxy wallet (signature_type=1)
   - Similar to Gnosis Safe
   - Split identity: signer signs, proxy is the maker/funder

### The Authentication Split

**L1 Authentication** (Getting API Credentials):
- Endpoints: `/auth/derive-api-key`, `/auth/api-key`
- Headers: `POLY_ADDRESS`, `POLY_SIGNATURE` (EIP-712), `POLY_TIMESTAMP`, `POLY_NONCE`
- Purpose: Prove wallet ownership to get API credentials
- **Key Question**: Which address to use in `POLY_ADDRESS`?
  - For EOA: Use signer address (obvious)
  - For Safe/Proxy: Use signer or effective address? (BOTH can be valid depending on setup!)

**L2 Authentication** (Trading Requests):
- Endpoints: `/balance-allowance`, `/orders`, etc.
- Headers: `POLY_ADDRESS`, `POLY_SIGNATURE` (HMAC), `POLY_TIMESTAMP`, `POLY_API_KEY`, `POLY_PASSPHRASE`
- Purpose: Authenticate trading requests with API credentials
- Uses: API credentials + correct signature type

## Why Alternating Failures Occur

### Scenario 1: Auto-Detection Gone Wrong

**Initial State**: User has Gnosis Safe wallet but doesn't know exact configuration.

**Attempt 1**: Bot tries `signature_type=0` (EOA) with signer address for L1 auth
- **L1 Result**: ✅ SUCCESS - Server accepts signer EOA for L1 auth
- **L2 Result**: ❌ FAIL - `401 Invalid api key` because signature_type should be 2, not 0

**Attempt 2**: Bot tries `signature_type=2` (Safe) with effective address for L1 auth
- **L1 Result**: ❌ FAIL - `401 Invalid L1 Request headers` because L1 needs signer, not effective
- **L2 Result**: Never reached

**Attempt 3**: Bot tries `signature_type=2` (Safe) with signer address for L1 auth
- **L1 Result**: ✅ SUCCESS - Server accepts signer EOA for L1 auth
- **L2 Result**: ✅ SUCCESS - Correct signature type for trading

### Scenario 2: Wrong Key Type

**Problem**: User accidentally uses Builder API keys as CLOB keys.
- Builder keys: For gasless transactions and leaderboard attribution
- CLOB keys: For order book trading

**Symptoms**:
- L1 auth might succeed (if deriving fresh keys)
- L2 auth fails with `401 Invalid api key` (wrong key type)

### Scenario 3: Query Parameter Pollution (Fixed)

**Problem**: Early versions had a bug where query parameters were added to L1 auth requests.
- L1 auth URL: `/auth/derive-api-key?geo_block_token=undefined`
- Server rejects because EIP-712 signature doesn't include query params

**Result**: `401 Invalid L1 Request headers`

**Fix**: Patch ensures clean URLs for L1 auth endpoints.

## How the Current Implementation Fixes This

### 1. Deterministic Wallet Mode Selection

The bot now uses a **deterministic** mode selection instead of constantly auto-detecting:

```javascript
// Determine mode ONCE at startup based on config
function detectWalletMode(params) {
  // If forced, use forced mode
  if (params.forceWalletMode && params.forceWalletMode !== "auto") {
    return params.forceWalletMode;
  }

  // Auto-detect based on signature type
  if (params.signatureType === SignatureType.POLY_GNOSIS_SAFE) {
    if (!params.funderAddress) {
      logger.warn("signatureType=2 but no funderAddress; defaulting to EOA");
      return "eoa";
    }
    return "safe";
  }

  if (params.signatureType === SignatureType.POLY_PROXY) {
    if (!params.funderAddress) {
      logger.warn("signatureType=1 but no funderAddress; defaulting to EOA");
      return "eoa";
    }
    return "proxy";
  }

  // Default to EOA
  return "eoa";
}
```

### 2. Fallback Ladder System

Instead of randomly trying configurations, the bot uses a **hard-coded fallback ladder**:

```javascript
const FALLBACK_LADDER = [
  {
    signatureType: SignatureType.EOA,
    useEffectiveForL1: false,
    label: "A) EOA + signer auth",
  },
  {
    signatureType: SignatureType.POLY_GNOSIS_SAFE,
    useEffectiveForL1: false,
    label: "B) Safe + signer auth",
  },
  {
    signatureType: SignatureType.POLY_GNOSIS_SAFE,
    useEffectiveForL1: true,
    label: "C) Safe + effective auth",
  },
  {
    signatureType: SignatureType.POLY_PROXY,
    useEffectiveForL1: false,
    label: "D) Proxy + signer auth",
  },
  {
    signatureType: SignatureType.POLY_PROXY,
    useEffectiveForL1: true,
    label: "E) Proxy + effective auth",
  },
];
```

Each attempt is tried **sequentially** until one succeeds. The working configuration is **cached** in `/data/clob-creds.json` for reuse.

### 3. Smart Error Detection

The bot distinguishes between different failure types:

```javascript
// L1 auth failure - try different L1 address
if (isInvalidL1HeadersError(error)) {
  // Immediately swap L1 auth address and retry
  return attemptWithSwappedL1Auth();
}

// L2 auth failure - credentials may be wrong
if (status === 401 && message.includes("Invalid api key")) {
  // Continue to next signature type
  continue;
}

// Wallet never traded - stop trying
if (isCouldNotCreateKeyError(error)) {
  return {
    success: false,
    error: "Wallet needs to trade on polymarket.com first",
  };
}
```

### 4. Credential Caching with Metadata

When a configuration succeeds, it's cached with full metadata:

```json
{
  "key": "...",
  "secret": "...",
  "passphrase": "...",
  "createdAt": 1737187338000,
  "signerAddress": "0x9B9883...",
  "signatureType": 2,
  "funderAddress": "0xb40336...",
  "usedEffectiveForL1": false
}
```

On next boot, the bot:
1. Loads cached credentials
2. Verifies they match current configuration
3. Tests them with `/balance-allowance`
4. If valid, uses them immediately
5. If invalid, clears cache and re-derives

### 5. Explicit Diagnostics

The bot now logs exactly what it's trying:

```
[CredDerive] Attempt 1/5: A) EOA + signer auth
[CredDerive]   sigType=0 (EOA) l1Auth=0x9B9883... signer=0x9B9883...
[CredDerive] ✅ Success: A) EOA + signer auth
```

Or if it fails:

```
[CredDerive] Attempt 1/5: B) Safe + signer auth
[CredDerive]   sigType=2 (Safe) l1Auth=0x9B9883... signer=0x9B9883...
[CredDerive] ❌ Failed: B) Safe + signer auth (401) - Invalid L1 Request headers
[CredDerive] Attempt 2/5: B) Safe + signer auth (swapped)
[CredDerive]   sigType=2 (Safe) l1Auth=0xb40336... signer=0x9B9883...
[CredDerive] ✅ Success: B) Safe + signer auth (swapped)
```

## Configuration Best Practices

### For EOA Wallets (Simplest)

```bash
PRIVATE_KEY=your_private_key
CLOB_DERIVE_CREDS=true
# No signature type needed - defaults to 0 (EOA)
```

### For Gnosis Safe / Browser Wallets

```bash
PRIVATE_KEY=your_signer_eoa_private_key  # The EOA that controls the Safe
POLYMARKET_SIGNATURE_TYPE=2              # Gnosis Safe
POLYMARKET_PROXY_ADDRESS=0xYourSafeAddress  # The Safe contract address
CLOB_DERIVE_CREDS=true
```

### For Legacy Proxy Wallets

```bash
PRIVATE_KEY=your_signer_eoa_private_key
POLYMARKET_SIGNATURE_TYPE=1              # Polymarket Proxy
POLYMARKET_PROXY_ADDRESS=0xYourProxyAddress
CLOB_DERIVE_CREDS=true
```

### Override Auto-Detection (Advanced)

```bash
# Force specific wallet mode
CLOB_FORCE_WALLET_MODE=safe  # or: auto, eoa, safe, proxy

# Force specific L1 auth address
CLOB_FORCE_L1_AUTH=signer  # or: auto, signer, effective
```

## Testing Your Configuration

Use the new authentication test harness:

```bash
# Basic test
npm run test-auth

# Test with funder address
npm run test-auth -- --funder 0xYourSafeAddress --signature-type 2

# Test with verbose logging
npm run test-auth -- --verbose

# Test with on-chain history check
npm run test-auth -- --check-history --verbose
```

The harness will show exactly which stage fails (L1 or L2) and provide actionable guidance.

## Summary

**Why alternating failures happened**:
1. Complex wallet identity model (signer vs effective address)
2. Multiple valid signature types (EOA, Proxy, Safe)
3. No deterministic selection logic
4. Auto-detection that kept flip-flopping

**How it's fixed now**:
1. ✅ Deterministic wallet mode selection
2. ✅ Systematic fallback ladder with caching
3. ✅ Smart error detection and immediate retries
4. ✅ Comprehensive diagnostics at each stage
5. ✅ Test harness for validation

**Result**: The bot will systematically try all valid combinations, cache the working one, and never alternate randomly between L1 and L2 failures.
