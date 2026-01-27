# 🧪 Testing SELL Orders Before Deployment

## Why This Test Exists

The user has $0.15 + trapped positions worth ~$100. We need to verify SELL orders work before deploying recovery mode.

## How to Test

### Step 1: Dry Run (Safe)
```bash
npm run test-sell
```

**This will:**
- ✅ Connect to your wallet
- ✅ Fetch your positions
- ✅ Select the most profitable position
- ✅ Fetch orderbook data
- ✅ Show what WOULD happen if sold
- ❌ NOT actually sell anything

**Expected output:**
```
🧪 APEX v3.0 - SELL ORDER TEST
Mode: 🔍 DRY RUN (simulation only)

✅ Authenticated: 0x1234...abcd
💰 Current USDC balance: $0.15
📊 Found 8 positions

Selected: YES (highest profit: +2.3%)
📖 Fetching orderbook...
✅ Orderbook fetched
   Best bid: 51.5¢
   Bid size: 150.00 shares

💰 Expected if sold:
   Proceeds: $48.23
   P&L: +$2.10

🔍 DRY RUN - Order structure:
   side: Side.SELL
   amount: 93.7
   price: 0.515

✅ Order structure is valid
📝 Run with --execute flag to actually attempt sell
```

### Step 2: Execute (ONE position only)
```bash
npm run test-sell -- --execute
```

**This will:**
- ⚠️ Wait 3 seconds (time to cancel)
- ⚡ Actually execute SELL order for ONE position
- ✅ Show if it succeeded

**Expected output:**
```
⚠️  WARNING: EXECUTE MODE ENABLED
⚠️  This will ACTUALLY SELL the position!

Waiting 3 seconds... (Ctrl+C to cancel)

⚡ EXECUTING SELL ORDER...
✅ Order created and signed
⏳ Posting order to exchange...

🎉 SELL ORDER SUCCESS!
   Sold: 93.70 shares
   Received: ~$48.23
   P&L: +$2.10

   New balance: $48.38 (was $0.15)

🎉 SELLING WORKS! Recovery mode will work correctly.
✅ Safe to deploy recovery mode
```

### Step 3: Deploy with Confidence
If test passes, deploy recovery mode knowing it will work!

## Troubleshooting

### "NO_BIDS"
Position has no buyers - try testing a different position.

### "PRICE_TOO_LOW"
Best bid would cause >1% loss - bot correctly refuses to sell at bad price.

### "ORDER_FAILED"
API error - check logs for details. May need to investigate before deploying.
