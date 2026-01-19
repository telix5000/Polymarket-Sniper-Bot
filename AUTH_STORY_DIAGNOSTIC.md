# Auth Story Diagnostic - Comprehensive Authentication Analysis

## Overview

This document describes the **Auth Story Diagnostic** system, which produces a single high-signal diagnostic summary that eliminates log spam and makes authentication failures immediately clear.

## Problem Statement

The bot was experiencing persistent 401 "Unauthorized/Invalid api key" errors with:
- Noisy logs with repeated identity dumps
- Duplicate error messages (rate-limited but still spammy)
- No clear root cause identification
- Mixed signal-to-noise ratio

## Solution: Auth Story

The Auth Story diagnostic tool produces **ONE structured summary per run** that includes:

1. **Configuration Check** - Verifies correct CLOB endpoint URL
2. **Identity Resolution** - Shows wallet/maker/funder addresses once
3. **Credential Derivation** - Documents derive/create attempts
4. **HTTP Request Trace** - Exact request made (sanitized)
5. **HTTP Response** - Exact response received
6. **Root Cause Analysis** - Top 3 hypotheses with evidence
7. **Recommended Fix** - Actionable next steps

## Usage

### Run the Diagnostic

```bash
# Standard diagnostic
npm run auth:diag

# With debug output
npm run auth:diag:debug

# Direct execution
ts-node scripts/auth_diagnostic.ts
```

### Environment Variables

```bash
# Required
PRIVATE_KEY=your_private_key_here

# Optional
CLOB_HOST=https://clob.polymarket.com  # Override CLOB endpoint
LOG_FORMAT=json                         # "json" or "pretty"
LOG_LEVEL=info                          # "debug", "info", "warn", "error"
```

## Output Format

### Auth Story JSON

The diagnostic produces a single JSON block with all authentication details:

```json
{
  "runId": "run_1705623743672_a1b2c3d4",
  "timestamp": "2025-01-19T23:55:43.900Z",
  "config": {
    "expectedClobUrl": "https://clob.polymarket.com",
    "actualClobUrl": "https://clob.polymarket.com",
    "isCorrectUrl": true,
    "envOverride": null,
    "constantsMatch": true
  },
  "derivation": {
    "success": true,
    "method": "createOrDeriveApiKey",
    "creds": {
      "apiKeySuffix": "abc123",
      "secretLen": 64,
      "passphraseLen": 32
    }
  },
  "request": {
    "method": "GET",
    "fullUrl": "https://clob.polymarket.com/balance-allowance?asset_type=COLLATERAL&signature_type=0",
    "signedPath": "/balance-allowance?asset_type=COLLATERAL&signature_type=0",
    "hasQueryParams": true,
    "headerNames": ["POLY_ADDRESS", "POLY_SIGNATURE", "POLY_TIMESTAMP", "POLY_API_KEY", "POLY_PASSPHRASE"],
    "timestamp": 1705623743
  },
  "response": {
    "status": 401,
    "statusText": "Unauthorized",
    "errorMessage": "Unauthorized/Invalid api key",
    "errorType": "AUTH_FAILED",
    "success": false
  },
  "rootCauseHypothesis": [
    "401 during verification: HMAC signature mismatch, invalid credentials, or wallet address mismatch",
    "Possible causes: Secret encoding wrong, message format incorrect, or credentials expired",
    "Query parameters present in signed path - verify they match exactly in HTTP request"
  ],
  "recommendedFix": "HMAC signature issue: This is likely a bug in request signing. Verify query parameters are included in signed path and not duplicated by axios params"
}
```

### Structured Logs

All logs include correlation IDs:

```json
{
  "timestamp": "2025-01-19T23:55:43.900Z",
  "level": "info",
  "message": "Starting credential derivation",
  "context": {
    "runId": "run_1705623743672_a1b2c3d4",
    "category": "CRED_DERIVE",
    "clobHost": "https://clob.polymarket.com",
    "method": "createOrDeriveApiKey"
  }
}
```

## Key Features

### 1. **No Secret Leakage**

- API keys: Show last 6 characters only (`***abc123`)
- Secrets: Show length and encoding guess only (`len=64, encoding=base64url`)
- Passphrases: Show length only (`len=32`)
- Private keys: Never logged

### 2. **Deduplication**

- Identity information logged once per run
- Repeated errors suppressed within 5-second window
- Suppression counter shows how many logs were skipped

### 3. **Correlation IDs**

- `runId`: Unique ID for each diagnostic run
- `reqId`: Unique ID for each HTTP request
- `attemptId`: Letter (A, B, C, D, E) for each auth attempt

### 4. **Root Cause Analysis**

The tool automatically identifies likely causes:

#### CLOB Endpoint Mismatch
```
Hypothesis: CLOB endpoint mismatch: Using 'https://wrong.url' instead of 'https://clob.polymarket.com'
Fix: Ensure CLOB_HOST environment variable is unset or set to 'https://clob.polymarket.com'
```

#### Wallet Not Traded
```
Hypothesis: 400 during credential derivation: Wallet has never traded on Polymarket
Fix: Visit https://polymarket.com, connect your wallet, and make at least one trade
```

#### Invalid L1 Headers
```
Hypothesis: 401 during credential derivation: Invalid L1 auth headers or signature mismatch
Fix: Verify private key is correct and wallet address matches. Try clearing credential cache
```

#### HMAC Signature Mismatch
```
Hypothesis: 401 during verification: HMAC signature mismatch, invalid credentials, or wallet address mismatch
Fix: This is likely a bug in request signing. Verify query parameters are included in signed path
```

## Diagnostic Checks

### 1. CLOB Endpoint Configuration

✅ **Pass**: Using `https://clob.polymarket.com`
❌ **Fail**: Using different URL or env override

**What it checks:**
- `POLYMARKET_API.BASE_URL` constant value
- `CLOB_HOST` environment variable override
- Match against expected URL

### 2. Credential Derivation

✅ **Pass**: `createOrDeriveApiKey()` returns valid credentials
❌ **Fail**: 400 (wallet not traded), 401 (invalid L1 headers), or other error

**What it checks:**
- Using official `createOrDeriveApiKey()` method (not separate derive + create)
- Credentials contain `key`, `secret`, and `passphrase`
- No 400/401 errors during derivation

### 3. HTTP Request Construction

✅ **Pass**: Signed path includes query parameters
❌ **Fail**: Query parameters missing or axios params object interferes

**What it checks:**
- Query string present in signed path
- `signatureType=0` for EOA mode
- Headers present: `POLY_ADDRESS`, `POLY_SIGNATURE`, `POLY_TIMESTAMP`, `POLY_API_KEY`, `POLY_PASSPHRASE`

### 4. Credential Verification

✅ **Pass**: `/balance-allowance` returns 200 OK
❌ **Fail**: 401 (unauthorized), 403 (forbidden), or other error

**What it checks:**
- HMAC signature validation
- API credentials validity
- Wallet address match

## Integration with Existing Code

### Use in credential-derivation-v2.ts

```typescript
import { initAuthStory } from "../clob/auth-story";
import { generateRunId } from "../utils/structured-logger";

// Initialize auth story
const runId = generateRunId();
const authStory = initAuthStory({
  runId,
  signerAddress: wallet.address,
  clobHost: POLYMARKET_API.BASE_URL,
  chainId: 137,
});

// Set identity
authStory.setIdentity({ orderIdentity, l1AuthIdentity });

// Add attempts
for (const attempt of fallbackLadder) {
  const result = await attemptDerive(attempt);
  authStory.addAttempt({
    attemptId: generateAttemptId(i),
    mode: "EOA",
    sigType: SignatureType.EOA,
    l1Auth: signerAddress,
    maker: makerAddress,
    funder: funderAddress,
    verifyEndpoint: "/balance-allowance",
    signedPath: "/balance-allowance?asset_type=COLLATERAL&signature_type=0",
    usedAxiosParams: false,
    httpStatus: result.status,
    errorTextShort: result.error?.slice(0, 100),
    success: result.success,
  });
}

// Set final result
authStory.setFinalResult({
  authOk: allAttempts.some(a => a.success),
  readyToTrade: allAttempts.some(a => a.success),
  reason: finalReason,
});

// Print summary
authStory.printSummary();
```

### Use in polymarket-auth.ts

```typescript
import { getLogger } from "../utils/structured-logger";

const logger = getLogger();

// Log with correlation IDs
logger.info("Deriving API credentials", {
  category: "CRED_DERIVE",
  runId: this.runId,
  method: "createOrDeriveApiKey",
});

// Log errors with context
logger.error("Authentication failed", {
  category: "HTTP",
  runId: this.runId,
  status: 401,
  error: "Unauthorized/Invalid api key",
});
```

## Comparison: Before vs After

### Before: Noisy Logs

```
[CredDerive] Starting credential derivation with fallback system
[CredDerive] ========================================================
[CredDerive] Identity Configuration:
[CredDerive]   signerAddress: 0x1234...5678
[CredDerive]   makerAddress: 0x1234...5678
[CredDerive]   funderAddress: undefined
[CredDerive]   effectiveAddress: 0x1234...5678
[CredDerive] Auth Identity:
[CredDerive]   signerAddress: 0x1234...5678
[CredDerive]   signingAddress: 0x1234...5678
[CredDerive] Auth Identity:  <-- DUPLICATE!
[CredDerive]   signerAddress: 0x1234...5678
[CredDerive]   signingAddress: 0x1234...5678
[CredDerive] Attempting: A) EOA + signer auth
[CredDerive] createOrDeriveApiKey failed: 401 - Invalid L1 Request headers
[CredDerive] Auth diagnostics:  <-- DUPLICATE!
[CredDerive]   signatureType: 0
[CredDerive]   walletAddress: 0x1234...5678
[CredDerive] Verification failed: 401 Unauthorized  <-- DUPLICATE!
[CredDerive] Attempting: B) EOA + effective auth
[CredDerive] createOrDeriveApiKey failed: 401 - Invalid L1 Request headers
... (repeated 5 times)
```

**Issues:**
- 50+ log lines per run
- Duplicate identity dumps (3-4 times)
- Repeated error messages
- No clear root cause
- Hard to extract signal from noise

### After: Auth Story

```json
{
  "timestamp": "2025-01-19T23:55:43.900Z",
  "level": "info",
  "message": "AUTH_STORY_JSON",
  "context": {
    "runId": "run_1705623743672_a1b2c3d4",
    "category": "SUMMARY",
    "authStory": {
      "runId": "run_1705623743672_a1b2c3d4",
      "signerAddress": "0x1234...5678",
      "makerAddress": "0x1234...5678",
      "funderAddress": "undefined",
      "clobHost": "https://clob.polymarket.com",
      "chainId": 137,
      "attempts": [
        {
          "attemptId": "A",
          "mode": "EOA",
          "sigType": 0,
          "l1Auth": "0x1234...5678",
          "httpStatus": 401,
          "errorTextShort": "Unauthorized/Invalid api key",
          "success": false
        }
      ],
      "finalResult": {
        "authOk": false,
        "readyToTrade": false,
        "reason": "401 during verification: HMAC signature mismatch"
      },
      "rootCauseHypothesis": [
        "Query parameters present in signed path - verify they match exactly in HTTP request"
      ],
      "recommendedFix": "HMAC signature issue: Verify query parameters are included in signed path and not duplicated by axios params"
    }
  }
}
```

**Benefits:**
- 1 summary block per run
- All information in one place
- Clear root cause with evidence
- Actionable recommended fix
- Easy to parse programmatically

## Exit Codes

- `0`: Authentication successful
- `1`: Authentication failed (see Auth Story for details)

## CI/CD Integration

### GitHub Actions Example

```yaml
- name: Test Authentication
  run: npm run auth:diag
  env:
    PRIVATE_KEY: ${{ secrets.PRIVATE_KEY }}
    LOG_FORMAT: json
  continue-on-error: true

- name: Parse Auth Story
  if: failure()
  run: |
    # Extract Auth Story JSON and analyze
    cat logs.json | jq '.context.authStory.rootCauseHypothesis'
    cat logs.json | jq '.context.authStory.recommendedFix'
```

## Troubleshooting

### Authentication Still Failing?

1. **Run the diagnostic:**
   ```bash
   npm run auth:diag
   ```

2. **Check the Root Cause Hypotheses** in the output

3. **Follow the Recommended Fix** if provided

4. **Common Issues:**

   - **CLOB endpoint wrong**: Unset `CLOB_HOST` or set to `https://clob.polymarket.com`
   - **Wallet not traded**: Visit https://polymarket.com and make 1 trade
   - **Invalid credentials**: Clear `/data/clob-creds.json` and restart
   - **HMAC mismatch**: This is a code bug - check query parameter handling

## Related Files

- `scripts/auth_diagnostic.ts` - Main diagnostic tool
- `src/clob/auth-story.ts` - Auth Story builder
- `src/utils/structured-logger.ts` - Structured logging system
- `src/clob/credential-derivation-v2.ts` - Credential derivation with Auth Story
- `src/clob/polymarket-auth.ts` - Authentication module with Auth Story

## References

- [Polymarket CLOB API Documentation](https://docs.polymarket.com/)
- [CLOB Client GitHub](https://github.com/Polymarket/clob-client)
- [Structured Logging Documentation](./docs/STRUCTURED_LOGGING.md)
