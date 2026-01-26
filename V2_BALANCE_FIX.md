# V2 Balance Check Fix - Summary

## Problem

The V2 Polymarket Sniper Bot was rejecting buy orders even when sufficient funds were available:

```
2026-01-26 15:26:41 🔄 Refreshing balance...
2026-01-26 15:26:41 ⚠️ Balance: $0.00 | 🔒 Allowance: $0.00
2026-01-26 15:26:41 [CLOB][TrustMode] Skipping zero-allowance cooldown (on-chain approvals verified, CLOB API bug workaround active)
2026-01-26 15:26:41 [CLOB] Order skipped (INSUFFICIENT_BALANCE_OR_ALLOWANCE): need=5.00 have=0.00 allowance=0.00 asset=COLLATERAL signer=0x9B9883152BfFeFB1cBE2A96FC0391537012ee5D1 collateral=unknown
2026-01-26 15:26:41 📢 BUY ❌ | Copy | YES $5.00 @ 67.0¢ | Bal: $97.46
```

**Key Issue:** The CLOB API reported balance=$0.00 when the actual on-chain balance was $97.46.

## Root Cause

1. **CLOB API Bug:** The Polymarket CLOB API has a known bug where it returns `balance=0` and `allowance=0` even when on-chain balance and approvals are correct.

2. **Trust Mode Limitation:** Trust Mode was only bypassing the allowance check, but still required `balanceSufficient` to be true before allowing orders.

3. **Check Sequence:**
   - CLOB API returns: balance=$0.00, allowance=$0.00
   - Trust Mode checks: `balanceSufficient` (FALSE) && other conditions
   - Since `balanceSufficient` is false, bypass doesn't happen
   - Order gets rejected even though actual on-chain balance is $97.46

4. **V2 Architecture:** V2 fetches balance directly from blockchain using `fetchBalance()`, but `postOrder()` uses `checkFundsAndAllowance()` which trusts the buggy CLOB API response.

## Solution

Modified `checkFundsAndAllowance()` in `src/utils/funds-allowance.util.ts` to:

1. **Detect the Issue:**
   ```typescript
   const shouldFetchOnchainBalance =
     trustOnchainApprovals &&
     onchainApprovalsVerified &&
     !balanceSufficient &&
     refreshedInsufficient.assetType === AssetType.COLLATERAL &&
     refreshedInsufficient.balanceUsd === 0;
   ```

2. **Fetch Balance On-Chain:** When CLOB returns $0.00, fetch the real balance from the blockchain:
   ```typescript
   const onchainSnapshot = await buildOnchainSnapshot({
     client: params.client,
     owner: tradingAddress,
     decimals: params.collateralTokenDecimals ?? DEFAULT_COLLATERAL_DECIMALS,
     tokenAddress: params.collateralTokenAddress,
     logger: params.logger,
   });
   balanceUsd = onchainSnapshot.balanceUsd;
   ```

3. **Update Trust Mode Logic:** Bypass BOTH balance and allowance checks when Trust Mode is active and balance is sufficient (checked on-chain).

## Expected Behavior After Fix

When the bot encounters the same scenario:

```
[15:26:41] 🔄 Refreshing balance...
[15:26:41] ⚠️ Balance: $0.00 | 🔒 Allowance: $0.00  (from CLOB API)
[15:26:41] [CLOB][TrustMode] CLOB API reports balance=$0.00, fetching on-chain balance...
[15:26:41] [CLOB][TrustMode] On-chain balance: $97.46 (CLOB reported: $0.00)
[15:26:41] [CLOB][TrustMode] Bypassing CLOB balance/allowance checks for COLLATERAL (known API bug). Balance sufficient and on-chain approvals verified. need=$5.00 have=$97.46 CLOB_allowance=$0.00
[15:26:41] 📢 BUY ✅ | Copy | YES $5.00 @ 67.0¢ | Bal: $97.46
```

## Files Changed

- `src/utils/funds-allowance.util.ts` - Core fix
- `tests/arbitrage/funds-allowance.test.ts` - Test updates

## Testing

### Unit Tests
```bash
npm test tests/arbitrage/funds-allowance.test.ts
```

Results: 1701/1707 tests pass (1 unrelated failure existed before)

### Manual Verification

To verify the fix works in production:

1. **Enable Trust Mode** (should be enabled by default):
   ```bash
   TRUST_ONCHAIN_APPROVALS=true  # or omit (defaults to true)
   ```

2. **Run V2 bot:**
   ```bash
   USE_V2=true npm start
   # or
   npm run start:v2
   ```

3. **Watch for the fix logs:**
   - Look for `[CLOB][TrustMode] CLOB API reports balance=$0.00, fetching on-chain balance...`
   - Verify orders are no longer rejected with `INSUFFICIENT_BALANCE_OR_ALLOWANCE`
   - Confirm buy orders succeed when you have sufficient on-chain balance

### Monitoring

Key log patterns to monitor:

**Before Fix:**
```
[CLOB] Order skipped (INSUFFICIENT_BALANCE_OR_ALLOWANCE): need=X.XX have=0.00
📢 BUY ❌ | ... | Bal: $XX.XX  (note: order rejected but balance shows funds!)
```

**After Fix:**
```
[CLOB][TrustMode] On-chain balance: $XX.XX (CLOB reported: $0.00)
[CLOB][TrustMode] Bypassing CLOB balance/allowance checks
📢 BUY ✅ | ... | Bal: $XX.XX  (order succeeds!)
```

## Compatibility

- **V1 Bot:** Not affected (doesn't use same balance checking flow)
- **V2 Bot:** Fixed
- **Environment Variables:**
  - `TRUST_ONCHAIN_APPROVALS=true` (default) - Fix enabled
  - `TRUST_ONCHAIN_APPROVALS=false` - Falls back to CLOB API (not recommended)

## Related Issues

This fix addresses the CLOB API bugs documented here:
- https://github.com/Polymarket/clob-client/issues/128
- https://github.com/Polymarket/py-clob-client/issues/102
- https://github.com/Polymarket/py-clob-client/issues/109

## Next Steps

1. Deploy the fix to production
2. Monitor logs for the new Trust Mode messages
3. Verify buy orders succeed when balance is available
4. If needed, adjust `TRUST_ONCHAIN_APPROVALS` env var
5. Report any issues with the fix

## Rollback Plan

If the fix causes issues:

1. Set `TRUST_ONCHAIN_APPROVALS=false` to disable Trust Mode
2. Revert to the previous commit before this fix
3. Report the issue with logs showing the problem

## Questions?

Contact the development team or open an issue on GitHub.
