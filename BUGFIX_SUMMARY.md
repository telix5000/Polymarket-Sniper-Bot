# Bug Fix Summary: Allowance Cooldown Issue

## Issue
User reported that the bot was blocking trades with the message:
```
[CLOB] Allowance is 0; approvals needed. Skipping refresh until 2026-01-26T13:00:19.676Z
```

Despite having funds in their wallet, the bot refused to trade for 5 minutes.

## Root Cause Analysis

### The CLOB API Bug
The Polymarket CLOB API has a documented bug where `getBalanceAllowance()` returns `allowance=0` even when on-chain ERC20 approvals are correctly set. This is a known issue tracked in multiple GitHub issues:
- https://github.com/Polymarket/clob-client/issues/128
- https://github.com/Polymarket/py-clob-client/issues/102
- https://github.com/Polymarket/py-clob-client/issues/109

### The Code Bug
In `src/utils/funds-allowance.util.ts`, the `fetchBalanceAllowance()` function had this logic:

```typescript
if (snapshot.allowanceUsd <= 0 && assetType === AssetType.COLLATERAL) {
  // PROBLEM: Unconditionally set 5-minute cooldown
  zeroAllowanceCooldown.set(cacheKey, {
    until: now + ZERO_ALLOWANCE_COOLDOWN_MS,  // 5 minutes
    lastLogged: now,
  });
}
```

When the CLOB API returned `allowance=0`, this code immediately set a 5-minute cooldown that prevented any further checks. This blocked the trust mode bypass logic (which was designed to handle this exact CLOB bug) from ever running.

### The Sequence of Events

**Before the fix:**
1. Preflight runs → verifies on-chain approvals → sets `client.onchainApprovalsVerified = true`
2. User tries to buy → `fetchBalanceAllowance()` called
3. CLOB API returns `allowance=0` (bug)
4. Code sets 5-minute cooldown ❌
5. All subsequent checks blocked by cooldown for 5 minutes
6. Trust mode bypass never gets to run
7. User sees: "Allowance is 0; approvals needed. Skipping refresh until..."

**After the fix:**
1. Preflight runs → verifies on-chain approvals → sets `client.onchainApprovalsVerified = true`
2. User tries to buy → `fetchBalanceAllowance()` called
3. CLOB API returns `allowance=0` (bug)
4. Code checks: trust mode enabled? ✓ On-chain approvals verified? ✓
5. Code **skips** cooldown ✅
6. Trust mode bypass logic runs successfully
7. Trade proceeds normally

## The Fix

Modified `fetchBalanceAllowance()` to check three conditions before setting the cooldown:

```typescript
// Check if we should skip the cooldown
const trustOnchainApprovals =
  process.env.TRUST_ONCHAIN_APPROVALS?.toLowerCase() !== "false";
const onchainApprovalsVerified =
  "onchainApprovalsVerified" in client &&
  (client as { onchainApprovalsVerified?: boolean })
    .onchainApprovalsVerified === true;
const shouldSkipCooldown =
  trustOnchainApprovals &&
  onchainApprovalsVerified &&
  assetType === AssetType.COLLATERAL;

if (snapshot.allowanceUsd <= 0 && assetType === AssetType.COLLATERAL) {
  if (!shouldSkipCooldown) {
    // Only set cooldown if conditions aren't met
    zeroAllowanceCooldown.set(cacheKey, {
      until: now + ZERO_ALLOWANCE_COOLDOWN_MS,
      lastLogged: now,
    });
  } else {
    // Log that we're skipping the cooldown
    logger.info(
      `[CLOB][TrustMode] Skipping zero-allowance cooldown (on-chain approvals verified, CLOB API bug workaround active)`,
    );
  }
}
```

## Conditions for Cooldown Skip

The cooldown is skipped ONLY when ALL three conditions are true:

1. **Trust mode enabled**: `TRUST_ONCHAIN_APPROVALS` is not explicitly set to "false" (enabled by default)
2. **On-chain approvals verified**: Preflight successfully verified on-chain approvals
3. **Asset is COLLATERAL**: Only applies to USDC collateral (not conditional tokens)

If any condition is false, the cooldown is set as before (protecting against real approval issues).

## Testing

Added comprehensive test cases in `tests/arbitrage/funds-allowance.test.ts`:

### Test 1: Trust Mode Active + Verified Approvals ✅
```typescript
// CLOB API returns allowance=0
// onchainApprovalsVerified=true
// TRUST_ONCHAIN_APPROVALS=true
// Result: Trading allowed (no cooldown)
```

### Test 2: Trust Mode Disabled ✅
```typescript
// CLOB API returns allowance=0
// TRUST_ONCHAIN_APPROVALS=false
// Result: Trading blocked (cooldown set correctly)
```

### Test 3: Approvals Not Verified ✅
```typescript
// CLOB API returns allowance=0
// onchainApprovalsVerified=false
// Result: Trading blocked (cooldown set correctly)
```

All tests pass, confirming the fix works as intended.

## Files Changed

1. **src/utils/funds-allowance.util.ts**: Core fix (added conditional cooldown logic)
2. **tests/arbitrage/funds-allowance.test.ts**: Added comprehensive test coverage
3. **docs/ALLOWANCE_COOLDOWN_FIX.md**: Detailed technical documentation
4. **verify-fix.js**: Verification script with error handling

## Configuration

The behavior is controlled by the `TRUST_ONCHAIN_APPROVALS` environment variable:
- **`undefined` or `true`** (default): Trust on-chain approvals over CLOB API response
- **`false`**: Strictly follow CLOB API response (disables bypass)

## Security Review

✅ No security vulnerabilities detected (CodeQL scan passed)
✅ Type safety improved with proper checks
✅ No secrets exposed in logs
✅ All test cases pass

## Impact

This fix allows legitimate trading to proceed when:
- The user has sufficient balance in their wallet
- On-chain ERC20 approvals are correctly set and verified
- The CLOB API incorrectly returns `allowance=0`

The 5-minute cooldown is still properly set when:
- Trust mode is explicitly disabled
- On-chain approvals were not verified during preflight
- There's an actual approval issue (not just CLOB bug)

This maintains protection against real approval issues while fixing the false positive that was blocking legitimate trades.
