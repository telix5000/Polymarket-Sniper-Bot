# Auth Story: Polymarket Sniper Bot - Trade Copy Failure Diagnostic

## Run Context
- **Date**: 2026-01-27 22:25:10+00:00
- **Mode**: Normal trading (not liquidation)
- **Symptoms**: Bot detects whale positions but does NOT copy trades after 5+ minutes

## Configuration Analysis

### Current State (from logs)
```
🐋 Tracking 100 top traders (requested: 100)
📡 Position monitoring enabled for 0x9b9883...
📡 Connected to CTF Exchange at 0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E
📡 Connected to NEG_RISK Exchange at 0xC5d563A36AE78145C45a50134d48A1215220f80a
📡 On-chain monitoring started (Infura tier: developer, 4000 credits/sec)
📡 On-chain monitor: Infura developer tier | 100 whales | Position monitoring: ON
📡 Data priority: ON-CHAIN > API (blockchain-speed edge)
🎲 Running...
📦 API returned 8 positions for 0x9b988315...
📊 Filtered: 2 active, 6 redeemable, 0 zero-size
```

### Critical Config Values (from src/start.ts:256-258)
- `biasMinNetUsd: 300` - Requires $300 net flow to trigger BUY signal
- `biasMinTrades: 3` - Requires at least 3 whale trades
- `biasWindowSeconds: 3600` - Trades must be within 1 hour
- `copyAnyWhaleBuy: false` (default) - CONSERVATIVE mode enabled

### Missing From Logs
❌ **NO** `⚡ On-chain → Bias` messages (whale trades being recorded)
❌ **NO** `📊 Bias | ... → LONG` messages (bias direction changes)
❌ **NO** entry attempt failures or success logs

## Execution Path Analysis

### Phase 1: Whale Trade Detection (WORKING ✓)
**File**: `src/lib/onchain-monitor.ts:515-758`
```
1. WebSocket listens for OrderFilled events on CTF/NEG_RISK exchanges
2. handleOrderFilled() processes each event
3. Checks if maker OR taker is in whale set
4. Filters by WHALE_TRADE_USD (default: $500)
5. Fires onWhaleTrade callback
```

**Status**: ✓ Monitor is connected and running
**Issue**: No `⚡ On-chain → Bias` logs = **NO whale trades detected above $500 threshold**

### Phase 2: Bias Accumulation (NOT TRIGGERING ❌)
**File**: `src/start.ts:2681-2713`
```
1. onWhaleTrade callback receives trade
2. Checks trade.side === "BUY" (only copy buys, not sells)
3. Validates whale is in whale set
4. Calls biasAccumulator.recordTrade()
5. Logs: "⚡ On-chain → Bias | Block #... | $... BUY | PRIORITY SIGNAL"
```

**Status**: ❌ No callback executions = no whale BUY trades detected

### Phase 3: Bias Direction Formation (NOT REACHED ❌)
**File**: `src/start.ts:922-964` (getBias method)
```
1. Sum all BUY trades in last 1 hour
2. Check: tradeCount >= 3 AND netUsd >= $300 (CONSERVATIVE mode)
3. If passed → direction = "LONG"
4. If failed → direction = "NONE"
```

**Status**: ❌ Never reached because Phase 1/2 not producing trades

### Phase 4: Entry Evaluation (NOT REACHED ❌)
**File**: `src/start.ts:2986-3011` (main cycle)
```
1. getActiveBiases() returns tokens where direction !== "NONE"
2. For each active bias (max 3):
   - Fetch market data
   - Call executionEngine.processEntry()
   - Check liquidity, price, risk limits
   - Execute buy if all checks pass
```

**Status**: ❌ getActiveBiases() returns empty array (no LONG signals)

## Root Cause: THREE BLOCKING ISSUES

### Issue 1: No Whale Trades Detected ⚠️
**Hypothesis**: Whale trades ARE happening, but below $500 threshold

**Evidence**:
- `WHALE_TRADE_USD` defaults to 500 (src/lib/onchain-monitor.ts:921)
- User wants `WHALE_TRADE_USD=100`
- Logs show "📦 API returned 8 positions" but NO on-chain trade events

**Fix Required**:
```bash
WHALE_TRADE_USD=100
```

### Issue 2: CONSERVATIVE Mode Too Strict 🚫
**Hypothesis**: Even if whale trades are detected, need 3 trades + $300 flow

**Evidence**:
- `copyAnyWhaleBuy: false` (default)
- Requires 3 trades AND $300 net flow to form LONG signal
- In 5 minutes, unlikely to see 3 whale buys on same token

**Fix Required**:
```bash
COPY_ANY_WHALE_BUY=true
```

### Issue 3: Missing Configuration ❌
**Hypothesis**: Live trading might not be enabled

**Evidence**:
- Need `LIVE_TRADING=I_UNDERSTAND_THE_RISKS` to actually place orders
- Not visible in logs provided
- Bot will simulate but not execute without this

**Fix Required**:
```bash
LIVE_TRADING=I_UNDERSTAND_THE_RISKS
```

## Recommended Configuration

Add to `.env`:
```bash
# Enable live trading
LIVE_TRADING=I_UNDERSTAND_THE_RISKS

# Lower whale trade threshold
WHALE_TRADE_USD=100

# Enable aggressive copy mode (copy ANY whale buy immediately)
COPY_ANY_WHALE_BUY=true

# Smaller trade size for testing
MAX_TRADE_USD=5

# Use GTC orders (posted to orderbook)
ORDER_TYPE=GTC
```

## Expected Behavior After Fix

### What You Should See:
```
⚡ On-chain → Bias | Block #12345678 | $150 BUY | PRIORITY SIGNAL
📊 Bias | 0xa7b3c... | NONE → LONG | $150 flow
💰 Entry | Token 0xa7b3c... | LONG @ 45¢ | $5.00
✅ BUY | Filled $5.00 @ 45.2¢ | Order ID: 0x...
```

### Diagnostic Markers:
1. `⚡ On-chain → Bias` - Whale trade detected and recorded
2. `📊 Bias | NONE → LONG` - Bias direction changed to LONG
3. `💰 Entry` - Entry attempt (evaluateEntry passed)
4. `✅ BUY` or `❌` - Execution result

## Validation Steps

1. **Verify WebSocket Connection**:
   ```bash
   # Check RPC_URL is Infura WebSocket
   grep RPC_URL .env
   # Should be: wss://polygon-mainnet.infura.io/ws/v3/YOUR_API_KEY
   ```

2. **Monitor for Whale Trades**:
   ```bash
   # Look for this log every 10-60 seconds:
   # "⚡ On-chain → Bias | Block #... | $... BUY"
   ```

3. **Check Bias Formation**:
   ```bash
   # With COPY_ANY_WHALE_BUY=true, should see immediately after first whale buy:
   # "📊 Bias | ... | NONE → LONG | $... flow"
   ```

4. **Verify Entry Attempts**:
   ```bash
   # Should see entry attempts within 200ms-600ms of bias forming
   # Either "💰 Entry" or rejection reason
   ```

## Summary Table

| Phase | Status | Issue | Fix |
|-------|--------|-------|-----|
| On-chain monitor | ✓ Connected | Threshold too high ($500) | Set `WHALE_TRADE_USD=100` |
| Whale trade detection | ❌ No events | See above + possibly no whale activity | Lower threshold + wait longer |
| Bias formation | ❌ Not triggered | Too strict (3 trades + $300) | Set `COPY_ANY_WHALE_BUY=true` |
| Entry evaluation | ❌ Not reached | No LONG signals | See above fixes |
| Order execution | ⚠️ Unknown | Possibly live trading disabled | Set `LIVE_TRADING=I_UNDERSTAND_THE_RISKS` |

## Auth Story Conclusion

**PRIMARY ISSUE**: Bot is in CONSERVATIVE mode requiring 3 whale trades + $300 flow before copying. With whale trade threshold at $500, unlikely to see enough signals.

**SECONDARY ISSUE**: Whale trade detection threshold ($500) is 5x higher than user's desired $100.

**TERTIARY ISSUE**: Possibly live trading not enabled (can't confirm from logs).

**RECOMMENDATION**: Apply all three config changes and monitor for 15-30 minutes. With `COPY_ANY_WHALE_BUY=true` and `WHALE_TRADE_USD=100`, should see first copy trade within 5-15 minutes if whales are active.
