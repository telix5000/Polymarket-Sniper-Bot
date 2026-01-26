# P&L Calculation Fix - Summary

## Problem

The Polymarket bot was incorrectly reporting P&L metrics after redemptions:
- **Realized P&L** always showed `$0.00` even after redeeming positions
- **Unrealized P&L** and **Net P&L** were identical (both `-$22.29`)
- Users couldn't see actual profits/losses from closed positions

### Example from Issue
```
📍 Position Redeemed
💵 Size: 5.80 shares
💰 Price: $1.00
📊 Value: $5.80

━━━ Portfolio Update ━━━
🔴 Net P&L: $-22.29
💰 Realized: +$0.00      ← BUG: Should show actual gain/loss
📈 Unrealized: $-22.29
```

## Root Cause

When AutoRedeem redeemed positions, it wasn't calculating or passing P&L information to the notification service. This meant:
1. `notifyRedeem()` was called without a `pnl` parameter
2. Trades were recorded with `pnlRealized: undefined`
3. The P&L ledger couldn't track realized gains from redemptions

## Solution

### What Changed

1. **Added P&L Data Interface** (`src/strategies/auto-redeem.ts`)
   ```typescript
   export interface PositionPnLData {
     entryPrice: number;  // Average cost per share
     pnlUsd: number;      // Current unrealized P&L
   }
   ```

2. **Added Callback to Get Position Data**
   - AutoRedeem can now optionally receive position entry price
   - Maintains architectural independence (no hard dependency on PositionTracker)

3. **Calculate Realized P&L on Redemption**
   ```typescript
   // When redeeming a position:
   realizedPnl = (redemption_price - entry_price) × size
   
   // Example: Bought 5.8 shares at 52¢, redeemed at $1.00
   // P&L = (1.00 - 0.52) × 5.8 = 0.48 × 5.8 = $2.78 profit
   ```

4. **Wire Up in Orchestrator** (`src/strategies/orchestrator.ts`)
   - Provides callback that looks up position data from PositionTracker
   - Works for both active and redeemable positions

### Code Flow

**Before:**
```
AutoRedeem
  └─> notifyRedeem(no P&L)
       └─> Ledger.recordTrade(pnlRealized=undefined)
            └─> Realized P&L = $0.00 ❌
```

**After:**
```
AutoRedeem
  ├─> getPositionPnL(tokenId) → entry price
  ├─> Calculate: (redemption_price - entry_price) × size
  └─> notifyRedeem(with P&L)
       └─> Ledger.recordTrade(pnlRealized=calculated)
            └─> Realized P&L = actual gain/loss ✅
```

## Understanding P&L Metrics

### 1. Realized P&L
- **What**: Total gains/losses from CLOSED positions (sold or redeemed)
- **Meaning**: ACTUAL money gained or lost
- **Changes**: Only when you close positions (sell/redeem)

### 2. Unrealized P&L
- **What**: Total gains/losses from OPEN positions at current market prices
- **Meaning**: POTENTIAL gain/loss if you sold at current prices
- **Changes**: As market prices fluctuate

### 3. Net P&L
- **What**: Realized + Unrealized
- **Meaning**: TOTAL profit/loss across all positions
- **Formula**: `Net P&L = Realized P&L + Unrealized P&L`

### Example Portfolio

```
Closed Positions:
  Position A (sold):     +$50.00
  Position B (redeemed): -$20.00
  Position C (sold):     +$15.00
  → Realized P&L: $45.00

Open Positions:
  Position D (up):       +$30.00
  Position E (down):     -$10.00
  → Unrealized P&L: $20.00

Total:
  🔴 Net P&L: $65.00
  💰 Realized: +$45.00
  📈 Unrealized: +$20.00
```

## Verification

Run the verification script to see examples:
```bash
node verify-pnl-fix.js
```

This shows:
- ✅ Winning position P&L calculation
- ❌ Losing position P&L calculation
- 📚 Detailed explanation of P&L metrics
- 💼 Example portfolio state

## Testing

Added comprehensive unit tests in `tests/strategies/auto-redeem.test.ts`:

1. **Winning Position**: Entry 30¢ → Redeem $1.00 = +$7.00 profit
2. **Losing Position**: Entry 70¢ → Redeem $0.00 = -$10.50 loss
3. **Break-even**: Entry $1.00 → Redeem $1.00 = $0.00
4. **Real Example**: Entry 52¢ → Redeem $1.00 for 5.8 shares = +$2.78 profit
5. **Callback Test**: Verify position lookup works correctly

## Edge Cases Handled

1. **Bot Restart**: If bot doesn't have original BUY in ledger, still works
   - Ledger accepts `pnlRealized` from trade when no prior position exists
   - This is specifically designed for bot restart scenarios

2. **Missing Position Data**: If PositionTracker doesn't have entry price
   - P&L calculation is skipped
   - Redemption still succeeds (redemption itself is independent)
   - Notification just won't include P&L

3. **Zero/Negative Sizes**: Handled by existing validation logic

## Impact

After this fix:

✅ **Realized P&L** correctly shows actual gains/losses from closed positions
✅ **Unrealized P&L** only shows potential gains/losses from open positions
✅ **Net P&L** accurately represents total portfolio performance
✅ Users can see which trades were profitable vs. which positions are still open
✅ Historical tracking of actual profits/losses is now accurate

## Files Changed

1. `src/strategies/auto-redeem.ts` - Added P&L calculation logic
2. `src/strategies/orchestrator.ts` - Wired up PositionTracker callback
3. `tests/strategies/auto-redeem.test.ts` - Added comprehensive tests
4. `verify-pnl-fix.js` - Verification script for manual testing

## Security Review

✅ CodeQL security scan passed with 0 alerts
✅ Code review completed
✅ No vulnerabilities introduced

## Next Steps

The fix is ready to deploy. After deployment:

1. Monitor first redemption to verify P&L is calculated correctly
2. Check that Realized P&L increments properly
3. Verify Net P&L = Realized + Unrealized
4. Look for any edge cases in production

If you see any issues, check the logs for:
- `[AutoRedeem] Calculated P&L: ...` - Shows P&L calculation details
- `[PnLLedger] Using provided P&L for ...` - Confirms ledger received the P&L
- `[PnLLedger] ... SELL realized: ...` - Shows realized P&L being tracked
