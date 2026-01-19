# Authentication Diagnostic Implementation Plan

## Problem Summary
401 authentication failures with insufficient diagnostic information to debug root cause.

## Root Cause Hypotheses (Priority Order)

### 1. Query Parameter Signing Mismatch (PRIMARY)
**Issue:** Signed path doesn't match actual HTTP request path
- Signature computed for: `/balance-allowance?asset_type=COLLATERAL&signature_type=0`
- Axios sends params separately, server receives different canonicalization
- **Impact:** HMAC signature fails validation

### 2. POLY_ADDRESS Header Mismatch (SECONDARY)
**Issue:** For Safe/Proxy mode, wrong address in POLY_ADDRESS header
- Should use: funderAddress
- Actually uses: signerAddress
- **Impact:** L1 auth headers rejected

### 3. Credential Derivation Order (TERTIARY)
**Issue:** createOrDeriveApiKey() calls wrong method first
- Current: create → derive (fails if key exists)
- Should: derive → create (preferred approach)
- **Impact:** Unnecessary failures during credential acquisition

## Minimal Changes Required

### File 1: `src/utils/auth-http-trace.util.ts` (NEW)
**Purpose:** Centralized HTTP request/response tracing for auth diagnostics

```typescript
/**
 * HTTP Request/Response Tracer for Auth Diagnostics
 * 
 * Captures exact signing inputs and HTTP wire format
 */

export interface AuthRequestTrace {
  reqId: string;
  timestamp: number;
  
  // Request details
  method: string;
  url: string;
  signedPath: string;        // What we signed
  actualPath: string;        // What axios sends
  queryParams: Record<string, unknown>;
  
  // Headers
  headers: Record<string, string>;
  
  // Signing details
  signatureInput: {
    timestamp: number;
    method: string;
    path: string;
    body?: string;
  };
  hmacSignature: string;
  
  // Response
  status?: number;
  errorMessage?: string;
}

export function traceAuthRequest(params: {
  method: string;
  endpoint: string;
  params?: Record<string, unknown>;
  signedPath: string;
  headers: Record<string, string>;
  signatureInput: { timestamp: number; method: string; path: string; body?: string };
}): AuthRequestTrace {
  const reqId = generateReqId();
  
  return {
    reqId,
    timestamp: Date.now(),
    method: params.method,
    url: `${POLYMARKET_API.BASE_URL}${params.endpoint}`,
    signedPath: params.signedPath,
    actualPath: params.endpoint,
    queryParams: params.params ?? {},
    headers: params.headers,
    signatureInput: params.signatureInput,
    hmacSignature: params.headers['POLY_SIGNATURE'] ?? 'missing',
  };
}

export function recordAuthResponse(trace: AuthRequestTrace, response: { status: number; error?: string }): void {
  trace.status = response.status;
  trace.errorMessage = response.error;
}

export function printAuthTrace(trace: AuthRequestTrace, logger: StructuredLogger): void {
  logger.debug("HTTP Auth Request Trace", {
    category: "HTTP",
    reqId: trace.reqId,
    method: trace.method,
    signedPath: trace.signedPath,
    actualPath: trace.actualPath,
    pathMismatch: trace.signedPath !== trace.actualPath,
    queryParams: trace.queryParams,
    signatureInput: trace.signatureInput,
    hmacSignature: trace.hmacSignature.slice(0, 12) + "...",
    status: trace.status,
    errorMessage: trace.errorMessage,
  });
  
  // Print signing message components
  const message = `${trace.signatureInput.timestamp}${trace.signatureInput.method}${trace.signatureInput.path}${trace.signatureInput.body ?? ''}`;
  logger.debug("HMAC Signature Input", {
    category: "SIGN",
    reqId: trace.reqId,
    messageLength: message.length,
    messageHash: crypto.createHash('sha256').update(message).digest('hex').slice(0, 16),
    timestamp: trace.signatureInput.timestamp,
    method: trace.signatureInput.method,
    path: trace.signatureInput.path,
    hasBody: !!trace.signatureInput.body,
  });
}
```

### File 2: `src/clob/auth-probe.ts` (NEW)
**Purpose:** Single command to run auth diagnostics

```typescript
/**
 * auth:probe - Standalone Authentication Diagnostic Tool
 * 
 * Usage: npm run auth:probe
 * 
 * Produces:
 * 1. One Auth Story JSON per run
 * 2. Minimal HTTP trace for each attempt
 * 3. Single-line summary
 */

import { deriveCredentialsWithFallback } from "./credential-derivation-v2";
import { getLogger, generateRunId } from "../utils/structured-logger";
import { AuthStoryBuilder } from "./auth-story";
import { POLYMARKET_API } from "../constants/polymarket.constants";

async function main() {
  const logger = getLogger();
  const runId = generateRunId();
  
  logger.info("🔍 Running auth:probe diagnostic", { category: "STARTUP", runId });
  
  // Read environment
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    logger.error("PRIVATE_KEY not set", { category: "STARTUP", runId });
    process.exit(1);
  }
  
  const wallet = new Wallet(privateKey);
  const signerAddress = wallet.address;
  
  // Initialize auth story
  const authStory = new AuthStoryBuilder({
    runId,
    signerAddress,
    clobHost: POLYMARKET_API.BASE_URL,
    chainId: 137,
  });
  
  // Run credential derivation
  const result = await deriveCredentialsWithFallback({
    privateKey,
    signatureType: undefined, // Auto-detect
    funderAddress: process.env.POLYMARKET_PROXY_ADDRESS,
    logger,
    structuredLogger: logger,
    authStoryBuilder: authStory,
  });
  
  // Set final result
  authStory.setFinalResult({
    authOk: result.success,
    readyToTrade: result.success,
    reason: result.success ? "Credentials derived and verified" : result.error ?? "Unknown error",
  });
  
  // Print summary
  authStory.printSummary();
  
  // Exit with appropriate code
  process.exit(result.success ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
```

### File 3: Update `src/clob/credential-derivation-v2.ts`
**Changes:**
1. Add HTTP trace logging in `verifyCredentials()`
2. Ensure signed path includes query parameters

```typescript
// Around line 214 - in verifyCredentials function
async function verifyCredentials(params: {
  creds: ApiKeyCreds;
  wallet: Wallet;
  signatureType: number;
  funderAddress?: string;
  logger?: Logger;
  structuredLogger?: StructuredLogger;
  attemptId?: string;
}): Promise<boolean> {
  const rateLimiter = getAuthFailureRateLimiter();

  try {
    // Build query parameters
    const queryParams = {
      asset_type: AssetType.COLLATERAL,
      signature_type: params.signatureType,
    };
    
    // Build signed path with canonical query string
    const { signedPath } = buildSignedPath("/balance-allowance", queryParams);
    
    const client = new ClobClient(
      POLYMARKET_API.BASE_URL,
      Chain.POLYGON,
      asClobSigner(params.wallet),
      params.creds,
      params.signatureType,
      params.funderAddress,
    );

    // Trace: capture what we're about to send
    if (params.structuredLogger) {
      params.structuredLogger.debug("Verifying credentials", {
        category: "HTTP",
        attemptId: params.attemptId,
        endpoint: "/balance-allowance",
        signedPath,
        queryParams,
        signatureType: params.signatureType,
        funderAddress: params.funderAddress,
      });
    }

    const response = await client.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });

    // ... rest of existing code
  }
}
```

### File 4: Update `src/clob/identity-resolver.ts`
**Change:** Suppress repeated "Auto-detected wallet mode" logs

```typescript
// Line 154 - Add deduplication flag
let walletModeLogged = false;

export function detectWalletMode(params: {
  // ... existing params
}): WalletMode {
  // ... existing logic
  
  // Only log once
  if (!walletModeLogged) {
    log("debug", `Auto-detected wallet mode: ${mode}`, {
      logger: params.logger,
      structuredLogger: params.structuredLogger,
      context: { walletMode: mode, signatureType: params.signatureType ?? 0 },
    });
    walletModeLogged = true;
  }
  
  return mode;
}

// Export reset for testing
export function resetWalletModeLogging(): void {
  walletModeLogged = false;
}
```

### File 5: Update `package.json`
**Add script:**

```json
{
  "scripts": {
    "auth:probe": "tsx src/clob/auth-probe.ts"
  }
}
```

### File 6: Create `.env.example` update
**Add:**

```bash
# Logging configuration
LOG_FORMAT=json    # or "pretty" for human-readable
LOG_LEVEL=debug    # error, warn, info, debug

# Suppress noisy logs (optional)
SUPPRESS_IDENTITY_LOGS=true
```

## Expected Output Format

### Success Case:
```json
{
  "timestamp": "2026-01-19T19:00:00.000Z",
  "level": "info",
  "message": "AUTH_STORY_JSON",
  "context": {
    "category": "SUMMARY",
    "runId": "run_1768848951813_8886dbb7",
    "authStory": {
      "runId": "run_1768848951813_8886dbb7",
      "selectedMode": "EOA",
      "selectedSignatureType": 0,
      "signerAddress": "0x9B9883152BfFeFB1cBE2A96FC0391537012ee5D1",
      "clobHost": "https://clob.polymarket.com",
      "chainId": 137,
      "attempts": [
        {
          "attemptId": "A",
          "mode": "EOA",
          "sigType": 0,
          "l1Auth": "0x9B9883152BfFeFB1cBE2A96FC0391537012ee5D1",
          "maker": "0x9B9883152BfFeFB1cBE2A96FC0391537012ee5D1",
          "verifyEndpoint": "/balance-allowance",
          "signedPath": "/balance-allowance?asset_type=COLLATERAL&signature_type=0",
          "usedAxiosParams": false,
          "httpStatus": 200,
          "success": true
        }
      ],
      "finalResult": {
        "authOk": true,
        "readyToTrade": true,
        "reason": "Credentials derived and verified"
      }
    }
  }
}
```

### Failure Case with Diagnostic:
```json
{
  "timestamp": "2026-01-19T19:00:00.000Z",
  "level": "debug",
  "message": "HTTP Auth Request Trace",
  "context": {
    "category": "HTTP",
    "reqId": "req_1768849123_a1b2c3",
    "method": "GET",
    "signedPath": "/balance-allowance?asset_type=COLLATERAL&signature_type=0",
    "actualPath": "/balance-allowance",
    "pathMismatch": true,
    "queryParams": {"asset_type": "COLLATERAL", "signature_type": 0},
    "status": 401,
    "errorMessage": "Unauthorized/Invalid api key"
  }
}
```

## Validation Checklist

- [ ] One runId per execution
- [ ] No duplicate "Auto-detected wallet mode" logs
- [ ] Auth Story JSON contains signedPath
- [ ] HTTP trace shows pathMismatch when it occurs
- [ ] Suppressed logs show "(suppressed N repeats)"
- [ ] auth:probe exits 0 on success, 1 on failure
- [ ] No secrets in logs (only suffixes/hashes)

## Rollback Plan

All changes are additive (new files) or isolated (logging only). To rollback:
1. Remove new files: `auth-http-trace.util.ts`, `auth-probe.ts`
2. Revert identity-resolver.ts deduplication
3. Remove auth:probe script from package.json
