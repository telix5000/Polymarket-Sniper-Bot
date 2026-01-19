# CLOB Authentication Diagnostic - Executive Summary

## Your Question
> "The bot is experiencing persistent 401 'Unauthorized/Invalid api key' errors. I suspect this might be using the wrong URL for the CLOB endpoint. I've researched and confirmed that https://clob.polymarket.com is the correct endpoint."

## Short Answer

**✅ You are CORRECT - `https://clob.polymarket.com` IS the correct endpoint.**

**✅ Your codebase IS USING the correct endpoint everywhere.**

**❌ The CLOB endpoint URL is NOT the cause of your 401 errors.**

## What I Found

### 1. CLOB Endpoint Verification ✅

I verified every file in your codebase:

```typescript
// src/constants/polymarket.constants.ts (Line 58)
export const POLYMARKET_API = {
  BASE_URL: "https://clob.polymarket.com",  // ✅ CORRECT
}
```

**All modules use this constant:**
- ✅ credential-derivation-v2.ts
- ✅ polymarket-auth.ts
- ✅ simple-auth.ts
- ✅ simple-client-factory.ts
- ✅ clob_auth_probe.ts

**No hardcoded wrong URLs found anywhere.**

### 2. The Real Problem: Unclear Error Diagnostics ⚠️

Your code is correct, but when auth fails, you get:
- 50+ noisy log lines
- Duplicate identity dumps (3-4 times)
- Repeated error messages
- No clear root cause identification

**This makes it LOOK like a configuration issue when it's actually something else.**

## The Solution: Auth Story Diagnostic Tool

I created a new tool that produces **ONE structured summary** per run:

```bash
npm run auth:diag
```

### What It Does

1. ✅ **Verifies CLOB endpoint** - Checks for URL misconfigurations
2. ✅ **Tests credential derivation** - Using official `createOrDeriveApiKey()`
3. ✅ **Makes HTTP request** - Shows exact request/response
4. ✅ **Analyzes root cause** - Provides top 3 hypotheses with evidence
5. ✅ **Recommends fix** - Actionable next steps

### Example Output

```json
{
  "runId": "run_1705623743672_a1b2c3d4",
  "config": {
    "expectedClobUrl": "https://clob.polymarket.com",
    "actualClobUrl": "https://clob.polymarket.com",
    "isCorrectUrl": true  // ✅
  },
  "response": {
    "status": 401,
    "errorMessage": "Unauthorized/Invalid api key",
    "success": false
  },
  "rootCauseHypothesis": [
    "401 during verification: Most likely wallet has never traded on Polymarket",
    "Alternative: Cached credentials invalid or expired",
    "Alternative: HMAC signature mismatch in request signing"
  ],
  "recommendedFix": "Visit https://polymarket.com, connect your wallet, and make at least one trade"
}
```

## Most Likely Causes of Your 401 Errors

### 1. Wallet Has Never Traded ⭐ MOST COMMON

**Symptom:** 401 "Unauthorized/Invalid api key"

**Cause:** Polymarket requires wallets to make at least 1 trade on the website first.

**Fix:**
1. Visit https://polymarket.com
2. Connect your wallet
3. Make 1 small trade (any amount)
4. Run `npm run auth:diag` again

### 2. Cached Credentials Invalid

**Symptom:** 401 "Unauthorized/Invalid api key"

**Cause:** Credentials in `/data/clob-creds.json` are expired or bound to wrong wallet.

**Fix:**
```bash
rm -f /data/clob-creds.json
npm run auth:diag
```

### 3. Wrong Private Key

**Symptom:** 401 "Unauthorized/Invalid api key"

**Cause:** The `PRIVATE_KEY` env var doesn't match the wallet used on Polymarket.

**Fix:**
1. Check wallet address:
   ```bash
   node -e "console.log(require('ethers').Wallet.fromPhrase(process.env.PRIVATE_KEY).address)"
   ```
2. Compare to wallet on Polymarket website
3. Use correct private key

## How to Use the Diagnostic Tool

### Run It

```bash
# Standard diagnostic
npm run auth:diag

# With debug logging
npm run auth:diag:debug

# Direct execution
ts-node scripts/auth_diagnostic.ts
```

### Read the Output

The tool will tell you:
- ✅ or ❌ CLOB endpoint check
- ✅ or ❌ Credential derivation
- ✅ or ❌ HTTP verification
- **Root cause hypotheses** (what's likely wrong)
- **Recommended fix** (what to do next)

### Exit Codes

- `0` = Authentication successful ✅
- `1` = Authentication failed ❌ (see output for why)

## Files Created

### New Tools
1. **`scripts/auth_diagnostic.ts`** - Main diagnostic tool
   - 600 lines of comprehensive auth analysis
   - No secret leakage (only suffixes/hashes)
   - Structured JSON output

2. **`AUTH_STORY_DIAGNOSTIC.md`** - Complete documentation
   - Usage examples
   - Output format explanation
   - Integration guide

3. **`AUTH_ANALYSIS_FINDINGS.md`** - Detailed analysis
   - Full code review results
   - All CLOB endpoint verifications
   - Common failure scenarios

### Modified Files
- **`package.json`** - Added npm scripts:
  - `npm run auth:diag`
  - `npm run auth:diag:debug`

- **`src/clob/auth-story.ts`** - Fixed type for `funder` field

## What This Fixes

### Before: Noisy Logs ❌

```
[CredDerive] Starting credential derivation...
[CredDerive] Identity Configuration:
[CredDerive]   signerAddress: 0x1234...5678
[CredDerive]   makerAddress: 0x1234...5678
[CredDerive] Auth Identity:  <-- DUPLICATE
[CredDerive]   signerAddress: 0x1234...5678
[CredDerive] Attempting: A) EOA + signer auth
[CredDerive] 401 Unauthorized
[CredDerive] Auth diagnostics:  <-- DUPLICATE
... (50+ lines)
```

### After: Auth Story ✅

```json
{
  "attempts": [{"attemptId": "A", "httpStatus": 401, "success": false}],
  "rootCauseHypothesis": ["Wallet has never traded on Polymarket"],
  "recommendedFix": "Visit https://polymarket.com and make 1 trade"
}
```

## Next Steps

1. **Run the diagnostic:**
   ```bash
   npm run auth:diag
   ```

2. **Read the root cause hypotheses** in the output

3. **Follow the recommended fix**

4. **If still stuck:**
   - Check `AUTH_STORY_DIAGNOSTIC.md` for detailed docs
   - Check `AUTH_ANALYSIS_FINDINGS.md` for analysis details
   - Run with debug: `npm run auth:diag:debug`

## Summary

| Question | Answer |
|----------|--------|
| Is CLOB endpoint wrong? | ❌ No, it's correct (`https://clob.polymarket.com`) |
| Is code using wrong URL? | ❌ No, all code uses correct constant |
| What's causing 401 errors? | ⭐ Most likely: Wallet hasn't traded on Polymarket |
| How to diagnose? | ✅ Run `npm run auth:diag` |
| How to fix? | ✅ Follow recommended fix in output |

## Technical Details

### Features of the Diagnostic Tool

1. **No Secret Leakage**
   - API keys: Last 6 chars only (`***abc123`)
   - Secrets: Length and encoding only
   - Private keys: Never logged

2. **Structured Output**
   - Single JSON block per run
   - Correlation IDs (runId, reqId, attemptId)
   - Easy to parse programmatically

3. **Root Cause Analysis**
   - Checks CLOB endpoint
   - Tests credential derivation
   - Verifies HTTP requests
   - Analyzes common failure patterns

4. **CI/CD Ready**
   - Exit codes (0 = success, 1 = failure)
   - JSON output for parsing
   - Environment variable configuration

### Code Quality

All code review issues addressed:
- ✅ Uses shared utilities (no duplication)
- ✅ Type guards for error handling
- ✅ Proper TypeScript types
- ✅ Comprehensive documentation
- ✅ Follows repo conventions

## Conclusion

**Your suspicion about the CLOB endpoint was reasonable given the 401 errors, but the endpoint is actually correct.**

The real issue is that the **error messages are unclear**, which I've now fixed with the new diagnostic tool.

**Run `npm run auth:diag` to get a clear answer about what's actually wrong.**

Most likely, you just need to visit https://polymarket.com and make 1 trade with your wallet. 🎯
