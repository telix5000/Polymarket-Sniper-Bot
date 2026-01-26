# 🔴 CRITICAL: Wallet Address Mismatch in Balance Checking

**Diagnostic Date:** 2026-01-26T17:27:45Z  
**Issue Type:** WALLET_ADDRESS_MISMATCH  
**Severity:** CRITICAL  
**Confidence:** 99%

---

## 🎯 Root Cause

**Your bot is checking the WRONG address for balance.**

- **Signer Address (EOA):** `0x9B9883152BfFeFB1cBE2A96FC0391537012ee5D1` - derived from `PRIVATE_KEY`
- **Funder/Proxy Address:** Set in `POLYMARKET_PROXY_ADDRESS` environment variable
- **Bug:** Balance checking code queries the **signer address** (which has $0.00)
- **Reality:** Your USDC is in the **funder/proxy address** (which is never checked)

---

## 📊 The Problem Explained

### How It Should Work (Proxy/Safe Mode)

```
1. User sets: POLYMARKET_SIGNATURE_TYPE=1 or 2
2. User sets: POLYMARKET_PROXY_ADDRESS=0xFUNDER_ADDRESS
3. Auth code correctly identifies:
   - signer address = 0x9B9883152BfFeFB1cBE2A96FC0391537012ee5D1
   - effective address = 0xFUNDER_ADDRESS
4. state.address = 0xFUNDER_ADDRESS ✅
5. Balance check should query: 0xFUNDER_ADDRESS
```

### What Actually Happens (BUG)

```
1. state.wallet = Wallet object for signer (0x9B9883152...)
2. start.ts line 429: getUsdcBalance(state.wallet)
3. balance.ts line 14: contract.balanceOf(wallet.address)
4. Queries: 0x9B9883152... (WRONG!) ❌
5. Returns: $0.00 (signer has no USDC)
6. USDC in funder address is NEVER checked
```

---

## 🔍 Evidence from Logs

```
[17:26:49] [CLOB] Order skipped (INSUFFICIENT_BALANCE_OR_ALLOWANCE): 
  need=10.00 have=0.00 allowance=0.00 
  asset=COLLATERAL 
  signer=0x9B9883152BfFeFB1cBE2A96FC0391537012ee5D1
```

- ✅ `signer=0x9B9883152...` is the **EOA derived from your private key**
- ❌ Balance check returned `$0.00` at this signer address
- 🎯 Your USDC is in the **funder/proxy address** (not checked)
- 💬 User complaint: _"it isn't looking at the wallet in the right spot"_ (100% accurate!)

---

## 🛠️ The Fix

### Files to Modify

#### 1. `src/lib/balance.ts` (lines 11-18)

**Before:**
```typescript
export async function getUsdcBalance(wallet: Wallet): Promise<number> {
  try {
    const contract = new Contract(POLYGON.USDC_ADDRESS, ERC20_ABI, wallet.provider);
    const balance = await contract.balanceOf(wallet.address); // ❌ WRONG
    return Number(balance) / 10 ** POLYGON.USDC_DECIMALS;
  } catch {
    return 0;
  }
}
```

**After:**
```typescript
export async function getUsdcBalance(wallet: Wallet, address?: string): Promise<number> {
  try {
    const checkAddress = address || wallet.address; // ✅ Use explicit address if provided
    const contract = new Contract(POLYGON.USDC_ADDRESS, ERC20_ABI, wallet.provider);
    const balance = await contract.balanceOf(checkAddress); // ✅ CORRECT
    return Number(balance) / 10 ** POLYGON.USDC_DECIMALS;
  } catch {
    return 0;
  }
}
```

#### 2. `src/lib/balance.ts` (lines 24-30)

**Before:**
```typescript
export async function getPolBalance(wallet: Wallet): Promise<number> {
  try {
    const balance = await wallet.provider?.getBalance(wallet.address); // ❌ WRONG
    return balance ? Number(balance) / 1e18 : 0;
  } catch {
    return 0;
  }
}
```

**After:**
```typescript
export async function getPolBalance(wallet: Wallet, address?: string): Promise<number> {
  try {
    const checkAddress = address || wallet.address; // ✅ Use explicit address if provided
    const balance = await wallet.provider?.getBalance(checkAddress); // ✅ CORRECT
    return balance ? Number(balance) / 1e18 : 0;
  } catch {
    return 0;
  }
}
```

#### 3. `src/start.ts` (lines 429-430)

**Before:**
```typescript
const usdc = await getUsdcBalance(state.wallet); // ❌ WRONG
const pol = await getPolBalance(state.wallet);   // ❌ WRONG
```

**After:**
```typescript
const usdc = await getUsdcBalance(state.wallet, state.address); // ✅ CORRECT
const pol = await getPolBalance(state.wallet, state.address);   // ✅ CORRECT
```

#### 4. `src/start.ts` (line 365)

**Before:**
```typescript
const balance = state.wallet ? await getUsdcBalance(state.wallet) : 0; // ❌ WRONG
```

**After:**
```typescript
const balance = state.wallet ? await getUsdcBalance(state.wallet, state.address) : 0; // ✅ CORRECT
```

---

## ✅ Why This Fix Works

1. **EOA Mode (signatureType=0):**
   - `state.address` = signer address
   - Funds are in signer address
   - `getUsdcBalance(wallet, state.address)` checks signer ✅
   - **Works correctly, no change in behavior**

2. **Proxy/Safe Mode (signatureType=1 or 2):**
   - `state.address` = funder address
   - Funds are in funder address
   - `getUsdcBalance(wallet, state.address)` checks funder ✅
   - **NOW WORKS CORRECTLY** (was broken before)

---

## 🧪 Verification Steps

### Step 1: Check Your Configuration
```bash
echo "Signature Type: $POLYMARKET_SIGNATURE_TYPE"
echo "Proxy Address: $POLYMARKET_PROXY_ADDRESS"
```

If both are set, you're in **proxy mode** (where the bug manifests).

### Step 2: Check On-Chain Balances

**Signer Address:**
```
https://polygonscan.com/token/0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174?a=0x9B9883152BfFeFB1cBE2A96FC0391537012ee5D1
```
Expected: **$0.00** or very low

**Funder Address (from POLYMARKET_PROXY_ADDRESS):**
```
https://polygonscan.com/token/0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174?a=YOUR_FUNDER_ADDRESS
```
Expected: **Significant USDC balance** (this is what the bot should check!)

### Step 3: Apply Fix and Test

After applying the code changes:
```bash
npm run build
npm run start
```

Look for logs showing correct balance:
```
✅ Balance: $XXX.XX | 🔒 Allowance: $XXX.XX
```

---

## 🚨 Immediate Workarounds (Before Fix)

### Option 1: Move Funds to Signer
Transfer USDC from funder address → `0x9B9883152BfFeFB1cBE2A96FC0391537012ee5D1`
- ✅ Works immediately
- ❌ Requires on-chain transaction
- ❌ May not align with your security model

### Option 2: Switch to EOA Mode
```bash
# Remove proxy configuration
unset POLYMARKET_SIGNATURE_TYPE
unset POLYMARKET_PROXY_ADDRESS
```
- ✅ Works immediately
- ❌ Changes security model
- ❌ Requires moving funds to signer

### Option 3: Apply the Code Fix (RECOMMENDED)
Follow the fix steps above
- ✅ Fixes root cause
- ✅ Maintains security model
- ✅ Works for both EOA and proxy modes
- ❌ Requires code changes

---

## 📚 Related Documentation

- **Similar Issue Fixed Previously:** `legacy/AUTH_BALANCE_FIX.md`
  - Different root cause (missing collateral token address)
  - Shows pattern of balance checking issues in this codebase
  
- **Authentication Logic:** `src/lib/auth.ts`
  - Lines 82-84: Where `effectiveAddress` is determined
  - Lines 135: Where `state.address` is set correctly

---

## 🎯 Summary for Developers

**What:** Balance checking functions use `wallet.address` (signer) instead of `effectiveAddress` (funder in proxy mode)

**Why:** Functions only accept `Wallet` parameter, which always resolves to signer address

**Fix:** Add optional `address` parameter to balance functions, pass `state.address` from callers

**Impact:** Critical for proxy/Safe mode users; no impact for EOA mode users

**Testing:** Test both EOA mode (should still work) and proxy mode (should now work)

---

## 📝 Next Steps

1. ✅ **Apply the fix** to `src/lib/balance.ts` and `src/start.ts`
2. ✅ **Add logging** to show which address is being checked
3. ✅ **Add tests** for both EOA and proxy modes
4. ✅ **Document** the proxy mode configuration in README
5. ✅ **Verify** with on-chain balance checker script

---

**Status:** Fix identified and documented. Ready to implement.
