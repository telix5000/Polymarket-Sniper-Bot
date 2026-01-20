# Auth Diagnostics System - User Guide

## Quick Start

### Diagnose CLOB API Auth Failures

```bash
# Run the enhanced auth probe with full diagnostics
ENABLE_HMAC_DIAGNOSTICS=true LOG_LEVEL=debug npm run auth:probe
```

This will produce ONE Auth Story JSON block showing:
- ✅ All authentication attempts (with correlation IDs)
- ✅ HTTP status codes (200, 401, 403, 400)
- ✅ Credential fingerprints (apiKeySuffix, secretLen, secretEncodingGuess)
- ✅ HMAC signature diagnostic (signed path vs actual path)
- ✅ Root-cause analysis for failures

**Exit Codes:**
- `0` = Auth successful, ready to trade
- `1` = Auth failed, see diagnostic output

### Check for Secret Leakage

```bash
# Run lint check to ensure no secrets are being logged
npm run check:secrets
```

This enforces:
- ✅ No `console.log` in src/ (except in allowed files)
- ✅ No direct secret logging (privateKey, apiKey, secret, passphrase)
- ✅ No string interpolation with secrets
- ✅ Structured logger has `redactSecrets` function

## Common Issues & Solutions

### Issue 1: "401 Unauthorized"

**Symptoms:**
```
HTTP 401
Authentication failed
```

**Most Likely Causes:**
1. **HMAC signature mismatch** - Signed path != actual HTTP path
2. **Invalid credentials** - Cached credentials are stale
3. **Wrong signature type** - Browser wallet needs special config

**Solution:**
```bash
# Step 1: Enable HMAC diagnostics
ENABLE_HMAC_DIAGNOSTICS=true npm run auth:probe

# Step 2: Check for path mismatch in output
# Look for: "signedPath" vs "actualPath"

# Step 3: Delete stale cache
rm -f .polymarket-credentials-cache.json
npm run auth:probe

# Step 4: Detect correct wallet type
npm run wallet:detect
```

**If you used MetaMask/WalletConnect:**
```bash
# Add to .env
POLYMARKET_SIGNATURE_TYPE=2
POLYMARKET_PROXY_ADDRESS=<your-proxy-wallet-address>
```

### Issue 2: "403 Forbidden"

**Symptoms:**
```
HTTP 403
Account restricted
```

**Possible Causes:**
1. Account banned by Polymarket
2. Geographic restrictions (geoblock)
3. Rate limiting (too many failed attempts)

**Solution:**
```bash
# Try with VPN to different region
# Wait 10-15 minutes for rate limit to reset
# Contact Polymarket support if account is restricted
```

### Issue 3: "400 Bad Request - could not create"

**Symptoms:**
```
HTTP 400
Could not create API credentials
```

**Cause:**
Wallet has never traded on Polymarket yet.

**Solution:**
1. Visit https://polymarket.com
2. Make at least ONE trade (any amount)
3. This creates your CLOB API credentials on-chain
4. Re-run `npm run auth:probe`

### Issue 4: Noisy Logs / Spam

**Symptoms:**
```
Repeated log messages:
- "Identity resolved: signer=0x1234..."
- "Headers present: POLY_ADDRESS=true"
- Same message 50+ times
```

**Solution:**
The auth diagnostics system now has:
- ✅ Deduplication (60s window) - suppresses repeated messages
- ✅ State transition tracking - only prints Auth Story on state changes
- ✅ Structured logger with categories

**If you still see spam:**
```bash
# Check if old code is being used
npm run check:secrets

# Ensure LOG_LEVEL is not set to debug (unless debugging)
unset LOG_LEVEL
npm run auth:probe
```

### Issue 5: Secrets Appearing in Logs

**Symptoms:**
```
Logs showing:
- Full private key: "0x1234567890abcdef..."
- Full API secret: "abc123xyz..."
- Full passphrase
```

**Solution:**
This should NEVER happen. If it does:

```bash
# Run lint check
npm run check:secrets

# This will find and report any secret leakage
# Exit code 1 = violations found
# Exit code 0 = no violations
```

**Expected Output:**
- API Key: `***abc123` (only last 6 chars)
- Secret: `[REDACTED len=64]` (only length)
- Passphrase: `[REDACTED len=32]` (only length)

## Understanding Auth Story Output

### Example Success

```json
{
  "runId": "run_1234567890_abc123",
  "selectedMode": "EOA",
  "selectedSignatureType": 0,
  "signerAddress": "0x1234...",
  "attempts": [
    {
      "attemptId": "A",
      "mode": "EOA",
      "httpStatus": 200,
      "success": true
    }
  ],
  "finalResult": {
    "authOk": true,
    "readyToTrade": true,
    "reason": "Authentication successful"
  }
}
```

**What this means:**
- ✅ Auth succeeded with EOA mode (signature type 0)
- ✅ HTTP 200 response from CLOB API
- ✅ Ready to trade

### Example Failure (401)

```json
{
  "runId": "run_1234567890_abc123",
  "selectedMode": "EOA",
  "selectedSignatureType": 0,
  "signerAddress": "0x1234...",
  "attempts": [
    {
      "attemptId": "A",
      "mode": "EOA",
      "httpStatus": 401,
      "errorTextShort": "Unauthorized",
      "success": false,
      "signedPath": "/balance-allowance",
      "usedAxiosParams": false
    }
  ],
  "finalResult": {
    "authOk": false,
    "readyToTrade": false,
    "reason": "Authentication failed - see attempts above"
  },
  "onchainBlocked": true
}
```

**What this means:**
- ❌ Auth failed with HTTP 401
- ⛔ On-chain transactions blocked (prevents gas waste)
- 🔍 Need to enable HMAC diagnostics to trace root cause

## Environment Variables

### Required

- `PRIVATE_KEY` - Your EOA private key (starts with 0x)

### Optional (for browser wallets)

- `POLYMARKET_SIGNATURE_TYPE` - Signature type (0=EOA, 1=Proxy, 2=Safe)
- `POLYMARKET_PROXY_ADDRESS` - Your proxy/Safe wallet address

### Optional (for diagnostics)

- `ENABLE_HMAC_DIAGNOSTICS=true` - Enable HMAC signature tracing
- `DEBUG_HMAC_SIGNING=true` - Log exact HMAC signing inputs
- `LOG_LEVEL=debug` - Enable debug logging
- `LOG_FORMAT=pretty` - Human-readable logs (default: json)

## Advanced Diagnostics

### Trace HMAC Signature Mismatch

If you're getting 401 errors but credentials look correct:

```bash
# Enable HMAC diagnostics
ENABLE_HMAC_DIAGNOSTICS=true DEBUG_HMAC_SIGNING=true npm run auth:probe
```

**What to look for:**
```json
{
  "signedPath": "/balance-allowance",
  "actualPath": "/balance-allowance?address=0x1234...",
  "pathMatch": false,
  "signedMethod": "GET",
  "actualMethod": "GET",
  "methodMatch": true
}
```

If `pathMatch: false`, this is the problem! The HMAC signature was computed on one path but sent with a different path.

**Common causes:**
1. Axios added query params AFTER signing
2. URL encoding differences
3. Trailing slash differences

### Check Credential Encoding

```bash
# Run auth probe, look for credential fingerprint
npm run auth:probe
```

**What to look for:**
```json
{
  "apiKeySuffix": "abc123",
  "secretLen": 64,
  "passphraseLen": 32,
  "secretEncodingGuess": "base64"
}
```

**Expected values:**
- `secretLen`: 64 (base64) or 32 (raw)
- `secretEncodingGuess`: "base64" or "base64url"

If `secretEncodingGuess: "unknown"`, the secret may be corrupted.

## Integration with CI/CD

### GitHub Actions Example

```yaml
- name: Verify CLOB Auth
  run: |
    npm run auth:probe
  env:
    PRIVATE_KEY: ${{ secrets.PRIVATE_KEY }}
    POLYMARKET_SIGNATURE_TYPE: ${{ secrets.POLYMARKET_SIGNATURE_TYPE }}
    POLYMARKET_PROXY_ADDRESS: ${{ secrets.POLYMARKET_PROXY_ADDRESS }}
```

**Exit codes:**
- `0` = Auth successful, CI passes
- `1` = Auth failed, CI fails

### Pre-commit Hook

```bash
# .git/hooks/pre-commit
#!/bin/bash
npm run check:secrets || exit 1
```

This blocks commits that:
- Leak secrets in logs
- Use console.log instead of structured logger
- Log full private keys or API credentials

## Further Reading

- **AUTH_DIAGNOSTICS_README.md** - Complete architecture overview
- **AUTH_DIAGNOSTICS_IMPLEMENTATION.md** - Implementation details
- **RUNBOOK.md** - Full operational runbook
- **GAS_WASTE_PREVENTION_README.md** - How auth blocks on-chain txs

## Getting Help

If auth probe still fails after following this guide:

1. **Share Auth Story JSON** (redact addresses if needed)
2. **Share HMAC diagnostic output** (if enabled)
3. **Share environment** (wallet type, signature type, proxy address)
4. **DO NOT share:** Private keys, API secrets, passphrases

## Definition of Done

When auth:probe succeeds, you'll see:

```json
{
  "finalResult": {
    "authOk": true,
    "readyToTrade": true,
    "reason": "Authentication successful"
  }
}
```

✅ Exit code: 0
✅ On-chain transactions: Allowed
✅ Order submissions: Enabled
✅ Ready to trade!
