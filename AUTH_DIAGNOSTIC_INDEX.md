# 🔍 Polymarket CLOB Authentication/Wallet Diagnostic Report

**Issue:** Balance shows $0.00, INSUFFICIENT_BALANCE_OR_ALLOWANCE errors  
**User Report:** "it isn't looking at the wallet in the right spot"  
**Date:** 2026-01-26T17:27:45Z  
**Status:** ✅ Root cause identified, fix ready to implement

---

## 📄 Diagnostic Documents Created

This investigation has produced several diagnostic documents:

### 1. **AUTH_STORY_SUMMARY.md** (RECOMMENDED - READ THIS FIRST)
- **Format:** Human-readable markdown with clear sections
- **Length:** Comprehensive but accessible
- **Best For:** Developers who need to understand and fix the issue
- **Contains:**
  - Root cause explanation
  - Code before/after comparisons
  - Step-by-step fix instructions
  - Verification steps
  - Workarounds

### 2. **AUTH_STORY_DIAGNOSTIC.json**
- **Format:** Structured JSON for programmatic parsing
- **Length:** Detailed technical analysis
- **Best For:** Automated systems, detailed investigation
- **Contains:**
  - Complete address derivation chain
  - Evidence from logs
  - Configuration modes comparison
  - Related files references
  - Prevention measures

### 3. **AUTH_STORY_ONE_LINE.txt**
- **Format:** Compact text with ASCII formatting
- **Length:** Condensed one-page summary
- **Best For:** Quick reference, terminal viewing
- **Contains:**
  - Address chain visualization
  - Bug locations with line numbers
  - 4-step fix summary
  - Verification checklist

### 4. **AUTH_STORY_DIAGRAM.txt**
- **Format:** ASCII diagrams and visual flow
- **Length:** Visual representation
- **Best For:** Understanding the flow visually
- **Contains:**
  - Step-by-step address flow diagrams
  - Before/after comparison
  - Visual problem illustration
  - Summary box

### 5. **AUTH_DIAGNOSTIC_INDEX.md** (THIS FILE)
- **Format:** Index and quick reference
- **Best For:** Navigation and overview

---

## 🎯 Quick Summary

### The Problem
```
User has funds in:     FUNDER address (0xFUNDER...) = $XXX.XX ✅
Bot checks balance at: SIGNER address (0x9B9883...) = $0.00   ❌
```

### Why It Happens
- **Proxy/Safe Mode:** Uses two addresses (signer + funder)
- **Signer:** Derived from PRIVATE_KEY → signs transactions
- **Funder:** Set in POLYMARKET_PROXY_ADDRESS → holds USDC
- **Bug:** Balance functions check `wallet.address` (signer) not `effectiveAddress` (funder)

### The Fix (4 edits)
1. `src/lib/balance.ts:11` - Add `address?: string` parameter to `getUsdcBalance()`
2. `src/lib/balance.ts:24` - Add `address?: string` parameter to `getPolBalance()`
3. `src/start.ts:429-430` - Pass `state.address` to both balance calls
4. `src/start.ts:365` - Pass `state.address` to balance refresh call

---

## 🔧 Files to Modify

| File | Lines | Change |
|------|-------|--------|
| `src/lib/balance.ts` | 11-18 | Add `address?: string` param, use `checkAddress = address \|\| wallet.address` |
| `src/lib/balance.ts` | 24-30 | Add `address?: string` param, use `checkAddress = address \|\| wallet.address` |
| `src/start.ts` | 429 | Change to `getUsdcBalance(state.wallet, state.address)` |
| `src/start.ts` | 430 | Change to `getPolBalance(state.wallet, state.address)` |
| `src/start.ts` | 365 | Change to `getUsdcBalance(state.wallet, state.address)` |

---

## 🧪 Verification Script

```bash
# Check if you're in proxy mode (where bug manifests)
echo "Signature Type: $POLYMARKET_SIGNATURE_TYPE"
echo "Proxy Address: $POLYMARKET_PROXY_ADDRESS"

# If both are set, you're affected by this bug

# Check on-chain balances to confirm
# Replace [FUNDER] with your POLYMARKET_PROXY_ADDRESS value
echo "Signer: https://polygonscan.com/token/0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174?a=0x9B9883152BfFeFB1cBE2A96FC0391537012ee5D1"
echo "Funder: https://polygonscan.com/token/0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174?a=[FUNDER]"
```

---

## 📊 Impact Analysis

### Affected Users
- ✅ **Proxy Mode (signatureType=1):** CRITICAL - bug manifests
- ✅ **Safe Mode (signatureType=2):** CRITICAL - bug manifests
- ✅ **EOA Mode (signatureType=0):** No impact - works correctly

### Symptoms
- Balance shows $0.00 even when funds exist
- Orders fail with `INSUFFICIENT_BALANCE_OR_ALLOWANCE`
- Logs show `signer=0x9B9883152BfFeFB1cBE2A96FC0391537012ee5D1`
- User reports "not looking at the wallet in the right spot"

### Root Cause
Balance checking functions use `wallet.address` (signer) instead of querying the address passed explicitly, causing them to always check the EOA signer address rather than the configured funder address in proxy/Safe modes.

---

## 🚀 Next Steps

1. **Choose a diagnostic document** to review based on your needs:
   - Quick fix? → `AUTH_STORY_ONE_LINE.txt`
   - Full understanding? → `AUTH_STORY_SUMMARY.md`
   - Visual learner? → `AUTH_STORY_DIAGRAM.txt`
   - Automated tooling? → `AUTH_STORY_DIAGNOSTIC.json`

2. **Verify you're affected:**
   - Check if `POLYMARKET_SIGNATURE_TYPE` is 1 or 2
   - Check if `POLYMARKET_PROXY_ADDRESS` is set
   - Check on-chain balance at signer vs funder address

3. **Apply the fix:**
   - Modify 2 functions in `src/lib/balance.ts`
   - Update 3 call sites in `src/start.ts`
   - Test in both EOA and proxy modes

4. **Verify the fix:**
   - Run bot and check balance logs
   - Should now show actual USDC balance from funder address
   - Orders should process without INSUFFICIENT_BALANCE_OR_ALLOWANCE

---

## 📚 Related Documentation

- **`legacy/AUTH_BALANCE_FIX.md`** - Previous auth/balance issue (different root cause)
- **`src/lib/auth.ts`** - Authentication and address determination logic
- **`src/clob/polymarket-auth.ts`** - Alternative auth implementation (not used in v2)
- **`scripts/check_wallet_status.ts`** - Wallet balance checking utility

---

## 🎓 Key Learnings

1. **Proxy/Safe Pattern:** Polymarket supports proxy wallets where signing and funding are separate
2. **Address Confusion:** Always distinguish between `signerAddress` and `effectiveAddress`
3. **Balance Checks:** Must query the address that holds funds, not just the signing address
4. **Type Safety:** Making parameters explicit prevents implicit assumptions

---

## ✅ Confidence Level

**99% - Root cause definitively identified**

Evidence:
- ✅ Code analysis shows balance functions always use `wallet.address`
- ✅ Auth code correctly sets `state.address` to funder in proxy mode
- ✅ Mismatch between what auth sets (funder) and what balance checks (signer)
- ✅ User report aligns perfectly with diagnosis ("not looking at right spot")
- ✅ Fix is straightforward and maintains backward compatibility

---

**Status:** Ready to implement fix. All diagnostic documents complete.

