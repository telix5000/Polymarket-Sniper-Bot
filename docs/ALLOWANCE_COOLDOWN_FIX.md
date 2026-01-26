# Allowance Cooldown Fix

## Problem

The user reported seeing this error:
```
[12:56:52] [CLOB] Allowance is 0; approvals needed. Skipping refresh until 2026-01-26T13:00:19.676Z
```

Despite having money in their wallet, the bot was blocking trades with a 5-minute cooldown.

## Root Cause

The bug was in `src/utils/funds-allowance.util.ts` in the `fetchBalanceAllowance()` function.

### The Issue

1. **CLOB API Bug**: The Polymarket CLOB API has a known bug where `getBalanceAllowance()` returns `allowance=0` even when on-chain ERC20 approvals are correctly set.
   - See: https://github.com/Polymarket/clob-client/issues/128
   - See: https://github.com/Polymarket/py-clob-client/issues/102
   - See: https://github.com/Polymarket/py-clob-client/issues/109

2. **Premature Cooldown**: When the CLOB API returned `allowance=0`, the code immediately set a **5-minute cooldown** that prevented any further allowance checks.

3. **Bypass Logic Blocked**: The code has a "trust mode" bypass that should allow trading when:
   - `TRUST_ONCHAIN_APPROVALS=true` (default)
   - On-chain approvals were verified during preflight
   - Balance is sufficient
   
   However, the cooldown was set **before** this bypass logic could run, preventing legitimate trades.

### Sequence Before Fix

```
1. Preflight runs → checks on-chain approvals → sets client.onchainApprovalsVerified=true
2. User tries to buy → fetchBalanceAllowance() called
3. CLOB API returns allowance=0 (bug)
4. Code immediately sets 5-minute cooldown ❌
5. All subsequent checks blocked by cooldown
6. Trust mode bypass never gets a chance to run
7. User sees: "Allowance is 0; approvals needed. Skipping refresh until..."
```

## Solution

Modified the cooldown logic to check if trust mode bypass conditions are met:

```typescript
// BUGFIX: Don't set zero-allowance cooldown if trust mode is enabled and on-chain approvals are verified
const trustOnchainApprovals =
  process.env.TRUST_ONCHAIN_APPROVALS?.toLowerCase() !== "false"; // Default: true
const onchainApprovalsVerified =
  (client as { onchainApprovalsVerified?: boolean })
    .onchainApprovalsVerified ?? false;
const shouldSkipCooldown =
  trustOnchainApprovals &&
  onchainApprovalsVerified &&
  assetType === AssetType.COLLATERAL;

if (snapshot.allowanceUsd <= 0 && assetType === AssetType.COLLATERAL) {
  if (!shouldSkipCooldown) {
    // Only set cooldown if trust mode is disabled or approvals not verified
    zeroAllowanceCooldown.set(cacheKey, {
      until: now + ZERO_ALLOWANCE_COOLDOWN_MS,
      lastLogged: now,
    });
  } else {
    // Skip cooldown when we know CLOB API is wrong
    logger.info(
      `[CLOB][TrustMode] Skipping zero-allowance cooldown (on-chain approvals verified, CLOB API bug workaround active)`,
    );
  }
}
```

### Sequence After Fix

```
1. Preflight runs → checks on-chain approvals → sets client.onchainApprovalsVerified=true
2. User tries to buy → fetchBalanceAllowance() called
3. CLOB API returns allowance=0 (bug)
4. Code checks: trust mode enabled? ✓ On-chain approvals verified? ✓
5. Code skips cooldown ✅
6. Trust mode bypass logic runs successfully
7. Trade proceeds normally
```

## Test Scenarios

### Scenario 1: Trust Mode Active + Verified Approvals (Fixed Case)
- `TRUST_ONCHAIN_APPROVALS=true`
- `onchainApprovalsVerified=true`
- CLOB API returns `allowance=0`
- **Result**: ✅ No cooldown set, trading allowed

### Scenario 2: Trust Mode Disabled
- `TRUST_ONCHAIN_APPROVALS=false`
- CLOB API returns `allowance=0`
- **Result**: ✅ Cooldown set (correct behavior)

### Scenario 3: Approvals Not Verified
- `TRUST_ONCHAIN_APPROVALS=true`
- `onchainApprovalsVerified=false`
- CLOB API returns `allowance=0`
- **Result**: ✅ Cooldown set (correct behavior)

### Scenario 4: Sufficient Allowance
- CLOB API returns `allowance > 0`
- **Result**: ✅ No cooldown (correct behavior)

## Configuration

The fix respects the `TRUST_ONCHAIN_APPROVALS` environment variable:
- `TRUST_ONCHAIN_APPROVALS=true` (default): Trust on-chain approvals over CLOB API
- `TRUST_ONCHAIN_APPROVALS=false`: Strictly follow CLOB API response

## Related Code

- `src/utils/funds-allowance.util.ts`: Main fix location
- `src/polymarket/preflight.ts`: Sets `onchainApprovalsVerified` flag
- `src/polymarket/approvals.ts`: Verifies on-chain approvals

## Summary

The fix ensures that when on-chain approvals are verified during preflight, the bot will not be blocked by the CLOB API's incorrect `allowance=0` response. The 5-minute cooldown is only set when:
1. Trust mode is disabled, OR
2. On-chain approvals were not verified, OR
3. The asset is not COLLATERAL (USDC)

This allows legitimate trading to proceed while still protecting against actual approval issues.
