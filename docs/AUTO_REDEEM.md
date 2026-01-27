# 🎁 Auto-Redeem for Resolved Markets

## What is Redemption?

When a Polymarket market resolves (closes and determines winner):
- **Winning positions** pay $1.00 per share
- **Losing positions** pay $0.00 per share
- You must **redeem** to claim your payout

**Redemption is NOT the same as selling!**
- Selling = trade with another user (orderbook)
- Redemption = claim payout from smart contract (guaranteed)

## How It Works

### Automatic (Built-in)
The bot automatically checks for redeemable positions:
1. **On startup** - Redeems any resolved positions
2. **Every 10 cycles** in recovery mode
3. **Before attempting sells** (redemption is better than selling at 1¢!)

### Manual (CLI)
```bash
npm run redeem
```

This will:
- Fetch all your resolved positions from Polymarket API
- Call the CTF contract to redeem each one
- Transfer payouts to your wallet as USDC

## Example Output

```
🎁 AUTO-REDEEM: Checking for resolved positions...

📦 Found 4 market(s) to redeem:
   NFC: ~$48.23
   "Will the NFC team win Super Bowl 2025?"
   Seahawks: ~$12.30
   "Will Seahawks make playoffs 2024?"
   Patriots: ~$9.15
   Under: ~$122.17
   
   Total value: ~$191.85

🔄 Redeeming: 0x1234...
⏳ Transaction sent: 0xabcd...
✅ Confirmed in block 52847293

🔄 Redeeming: 0x5678...
⏳ Transaction sent: 0xdef0...
✅ Confirmed in block 52847301

📊 REDEMPTION SUMMARY
   Redeemed: 4
   Failed: 0
   Total: 4
```

## Why Your Positions Show 1¢ Bids

**Dead giveaway:** 1¢ bids = market is resolved

When markets resolve:
- Orderbook goes dead (no more trading)
- Only 1¢ bids remain (from bots scraping remaining orders)
- **DO NOT SELL** - you'll throw away money!
- **REDEEM INSTEAD** - claim full payout

Example:
- You bought at 67¢
- Market resolved (you won!)
- Orderbook shows 1¢ best bid
- **If you sell:** Get $0.01 per share (98% loss) ❌
- **If you redeem:** Get $1.00 per share (49% profit) ✅

## Technical Details

### Smart Contracts
- **CTF Contract:** `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045`
- **USDC:** `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`

### API Endpoint
```
https://data-api.polymarket.com/positions?user={ADDRESS}&redeemable=true
```

### Redemption Call
```solidity
redeemPositions(
  address collateralToken,    // USDC address
  bytes32 parentCollectionId, // Always 0x0 for Polymarket
  bytes32 conditionId,        // Market identifier
  uint256[] indexSets         // [1, 2] for both YES/NO outcomes
)
```

### Gas Settings
Uses 130% of current gas price for faster confirmation (based on Milan's proven code).

### Proxy Wallets
Automatically detects and uses proxy wallet if you have one:
1. Checks profile API for proxy address
2. Routes redemption through proxy contract if found
3. Falls back to direct redemption if no proxy

## Troubleshooting

### "No positions need redemption"
- All positions are in active markets (not yet resolved)
- Already redeemed previously
- Check https://polymarket.com to see market status

### "Transaction timeout"
- Network congestion
- Retry with: `npm run redeem`
- May need to wait and try again

### "Redemption failed: revert"
- Position already redeemed
- Market not actually resolved yet (API lag)
- Check Polygonscan for transaction details

## Credits

Based on Milan Zandbak's proven polymarketredeemer:
https://github.com/milanzandbak/polymarketredeemer

Thank you Milan! 🙏
