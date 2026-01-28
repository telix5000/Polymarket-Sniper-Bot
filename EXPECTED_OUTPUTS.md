# Expected Output Examples

This document shows what the bot logs will look like after the fixes are applied.

---

## 1. Bias Rejection Examples

### Signal rejected due to low flow:
```
❌ [Entry] FAILED: 0xa1b2c3d4e5f6... - BIAS_BELOW_MIN_FLOW ($150 < $300)
```

### Signal rejected due to insufficient trades:
```
❌ [Entry] FAILED: 0xa1b2c3d4e5f6... - BIAS_BELOW_MIN_TRADES (2 < 3)
```

### Signal rejected due to staleness:
```
❌ [Entry] FAILED: 0xa1b2c3d4e5f6... - BIAS_STALE (last: 1200s ago)
```

---

## 2. Orderbook Sanity Gate Examples

### Dust book rejection (no cooldown):
```
⚠️ [Entry] No market data for 0xa1b2c3d4e5f6... | reason: DUST_BOOK | strike 1 | cooldown: 0s
```
Detail: `Dust book: bid=1.5¢, ask=98.5¢`

### Wide spread rejection (no cooldown):
```
⚠️ [Entry] No market data for 0xa1b2c3d4e5f6... | reason: INVALID_LIQUIDITY | strike 1 | cooldown: 0s
```
Detail: `Spread 12.3¢ > max 6¢`

### Invalid prices rejection (no cooldown):
```
⚠️ [Entry] No market data for 0xa1b2c3d4e5f6... | reason: INVALID_PRICES | strike 1 | cooldown: 0s
```
Detail: `Invalid prices: bid=0, ask=0`

---

## 3. Spread Gate Consistency

### Debug output (only when DEBUG=true):
```
🔍 [DEBUG] [Liquidity Gate] Spread check: 4.5¢ vs max 6.0¢
```

### Rejection when spread > 6¢:
```
❌ [Entry] FAILED: 0xa1b2c3d4e5f6... - Spread 7.2¢ > max 6¢
```

**Note:** The gate now uses ONLY `MIN_SPREAD_CENTS=6` from ENV, not `min(6, 2*2) = 4`.

---

## 4. Cooldown Policy Examples

### Transient error → cooldown applied:
```
❌ [Entry] FAILED: 0xa1b2c3d4e5f6... - RATE_LIMIT
   ⏳ Token on cooldown for 30s (transient error)
```

```
❌ [Entry] FAILED: 0xa1b2c3d4e5f6... - NETWORK_ERROR
   ⏳ Token on cooldown for 30s (transient error)
```

### Permanent condition → NO cooldown:
```
❌ [Entry] FAILED: 0xa1b2c3d4e5f6... - DUST_BOOK
```
(No cooldown message - just skip and check next candidate)

```
❌ [Entry] FAILED: 0xa1b2c3d4e5f6... - Spread 8.0¢ > max 6¢
```
(No cooldown message - permanent market condition)

---

## 5. Token ID Validation Examples

### Valid candidate (DEBUG=true):
```
🔍 [DEBUG] [Whale Trade] Candidate: tokenId=0xa1b2c3d4e5... | conditionId=0x7f8e9d0c1... | outcome=YES | size=$1500
```

### Invalid candidate rejected:
```
🔍 [DEBUG] [Whale Trade] Rejected: empty tokenId | conditionId: 0x7f8e9d0c1... | outcome: YES | wallet: 0xabc123...
```

---

## 6. Status Output with Funnel Metrics

### Before fixes (no funnel visibility):
```
   📊 Diagnostics: API trades detected: 47 | Entry attempts: 15 (20% success) | OB failures: 8
```

### After fixes (funnel visible):
```
   📊 Diagnostics: API trades detected: 47 | Entry attempts: 15 (20% success) | OB failures: 8
   🔬 Funnel: Candidates seen: 15 | Rejected liquidity: 8
```

**Interpretation:**
- 47 whale trades detected from API
- 15 entry attempts made (candidates that passed all gates)
- 20% success rate (3 successful entries)
- 8 orderbook fetch failures
- 15 candidates processed (passed bias filters)
- 8 rejected due to liquidity (dust books, wide spreads)

---

## 7. Eligible Whale Signals Example

### With active signals:
```
🐋 [Bias] 3 eligible whale signals
```

### With signals but all on cooldown:
```
⏳ [Bias] 5 whale signals on cooldown (price/liquidity or market-data issues)
```
(Only logged every 30 cycles to avoid spam)

---

## 8. Successful Entry Example

```
🐋 [Bias] 2 eligible whale signals
✅ [Entry] SUCCESS: Copied whale trade on 0xa1b2c3d4e5f6...
```

---

## 9. Entry Attempt Flow (complete example)

### Scenario: Bot sees whale trade, attempts entry, rejects due to dust book

```
📊 [API Poll #42] Batch 1-20 of 100 wallets (cycle 2/5) | Success: 18 | Trades found: 52 | In window: 23 | New BUYs: 1
🐋 [API] Detected 1 new whale trade(s)!
🐋 [Bias] 1 eligible whale signals
⚠️ [Entry] No market data for 0xa1b2c3d4e5f6... | reason: DUST_BOOK | strike 1 | cooldown: 0s
```

**No cooldown applied** - bot continues checking other tokens.

---

## 10. Complete Status Summary Example

```
════════════════════════════════════════════════════════════════════════════
⏰ TIME: 2024-01-15 14:32:18 UTC | UPTIME: 2h 15m
💰 BALANCE: $1,247.33 | EFFECTIVE: $935.50 (reserve: $311.83 @ 25%)
📊 POSITIONS: 3 open (total: $225.00 deployed, 18% of max)
   
   Position #1: 0xa1b2c3d4e... | LONG @ 45.2¢ | P&L: +$3.40 (+1.51%)
   Position #2: 0x7f8e9d0c1... | LONG @ 52.8¢ | P&L: +$1.20 (+0.53%)
   Position #3: 0xdef456789... | LONG @ 38.1¢ | P&L: -$0.80 (-0.35%)

📈 PERFORMANCE: 15 trades | 67% win rate | Avg win: $5.20 | Avg loss: -$2.80
💡 EV: Estimated +2.1¢ per trade (TRADING ALLOWED)

🐋 WHALE TRACKING: 100 top traders | 47 trades detected this session
🟢 On-chain: CONNECTED | Events: 23 | Whales loaded: 100

   📊 Diagnostics: API trades detected: 47 | Entry attempts: 15 (20% success) | OB failures: 8
   🔬 Funnel: Candidates seen: 15 | Rejected liquidity: 8

   🌐 Network: RPC: 45ms | API: 123ms | Status: healthy
════════════════════════════════════════════════════════════════════════════
```

---

## Key Differences After Fixes

### BEFORE:
- ❌ Accepts signals with $24 flow
- ❌ Accepts 1¢/99¢ spreads
- ❌ Uses dynamic 4¢ spread max
- ❌ Cooldowns everything (including permanent conditions)
- ❌ No funnel visibility

### AFTER:
- ✅ Rejects signals with < $300 flow
- ✅ Rejects 1¢/99¢ spreads immediately
- ✅ Uses consistent 6¢ spread max from ENV
- ✅ Only cooldowns transient errors (30s)
- ✅ Funnel visible in status output
- ✅ Clear rejection reasons in logs
