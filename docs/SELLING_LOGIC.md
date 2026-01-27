# 🔄 Selling Logic - Complete Guide

## Overview

This document provides a comprehensive guide to all selling pathways in the Polymarket Sniper Bot. Understanding when and why the bot sells positions is critical for troubleshooting and optimization.

## Table of Contents

1. [Sell Functions](#sell-functions)
2. [Sell Strategies](#sell-strategies)
3. [Emergency & Recovery Mode](#emergency--recovery-mode)
4. [Scavenger Mode Sells](#scavenger-mode-sells)
5. [Common Error Messages](#common-error-messages)
6. [Edge Cases & Known Issues](#edge-cases--known-issues)
7. [Troubleshooting Guide](#troubleshooting-guide)

---

## Sell Functions

### 1. `sellPosition()` - Standard Sell

**Location:** `src/start.ts:714`

**Purpose:** Basic sell function with 1% slippage protection

**How it works:**
1. Fetches orderbook for the position's token
2. Checks if bids are available
3. Calculates minimum acceptable price: `avgPrice * 0.99` (1% slippage)
4. Compares best bid against minimum price
5. If acceptable, creates SELL order via `createMarketOrder()`
6. Uses Fill-or-Kill (FOK) execution

**Price Protection:**
```javascript
const minPrice = position.avgPrice * 0.99;  // 1% slippage tolerance
if (bestBid < minPrice) {
  // Blocks sell - logs "Price too low"
  return false;
}
```

**Example Log Output:**
```
🔄 Selling Patriots
   Shares: 232.71
   Value: $125.66
   P&L: -0.9%
   Reason: APEX Blitz: 12.5% profit in 15min

✅ Sold: $126.89
```

**Common Failures:**
- `❌ No bids available` - No buyers in orderbook
- `❌ Price too low: 1¢ < 67¢` - Best bid below minimum acceptable price

---

### 2. `sellPositionEmergency()` - Emergency Sell

**Location:** `src/start.ts:792`

**Purpose:** Sell with configurable price protection for emergency situations

**How it works:**
1. Checks emergency mode configuration
2. Calculates `maxAcceptablePrice` based on mode:
   - **CONSERVATIVE**: `avgPrice * 0.50` (won't sell below 50% of entry)
   - **MODERATE**: `avgPrice * 0.20` (won't sell below 20% of entry)  
   - **NUCLEAR**: `undefined` (NO PROTECTION - sells at any price)
3. Calls `postOrder()` with configured price protection
4. Uses retry logic and Fill-or-Kill (FOK) execution

**Emergency Modes:**

| Mode | Protection | Example |
|------|------------|---------|
| **CONSERVATIVE** | 50% of entry | 67¢ entry → won't sell below 34¢ |
| **MODERATE** | 20% of entry | 67¢ entry → won't sell below 13¢ |
| **NUCLEAR** | None | 67¢ entry → will sell at 1¢ ⚠️ |

**Configuration:**
```bash
# In .env
EMERGENCY_SELL_MODE=CONSERVATIVE  # or MODERATE or NUCLEAR
EMERGENCY_BALANCE_THRESHOLD=5     # Activate when balance < $5
```

**Example Log Output (CONSERVATIVE):**
```
🔄 Selling Patriots
   Shares: 232.71
   Value: $125.66
   Entry: 67.0¢
   Current: 1.0¢
   P&L: -98.5%
   Reason: Emergency: free capital (-98.5% loss)
   Min acceptable: 34.0¢ (CONSERVATIVE mode)

❌ Sell failed: PRICE_TOO_LOW
```

**Example Log Output (NUCLEAR):**
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🚨 EMERGENCY SELL MODE: NUCLEAR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ⚠️  NO PROTECTION - Will sell at ANY price!
   ⚠️  This may result in massive losses!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🔄 Selling Patriots
   Entry: 67.0¢
   Current: 1.0¢
   ⚠️  NUCLEAR MODE - No price protection!

✅ Sold: $2.33 (98.5% loss accepted)
```

**See also:** [docs/EMERGENCY_SELLS.md](./EMERGENCY_SELLS.md)

---

### 3. `postOrder()` - Low-Level Order Execution

**Location:** `src/lib/order.ts:60`

**Purpose:** Universal order posting function with price protection

**Key Features:**
- Handles both BUY and SELL orders
- Optional `maxAcceptablePrice` parameter for price protection
- Retry logic with FOK execution
- Duplicate prevention for BUY orders
- Supports partial fills across multiple orderbook levels

**For SELL orders:**
- Uses orderbook **bids** (correct!)
- If `maxAcceptablePrice` undefined → sells at ANY price (NUCLEAR mode)
- If `maxAcceptablePrice` defined → blocks if `bestBid < maxAcceptablePrice`

**Price Protection Logic:**
```javascript
// For SELL orders
if (!isBuy && bestPrice < maxAcceptablePrice) {
  logger.debug(`Order rejected: PRICE_TOO_LOW (${bestPrice} < min ${maxAcceptablePrice})`);
  return { success: false, reason: "PRICE_TOO_LOW" };
}
```

---

## Sell Strategies

The bot uses multiple strategies to determine when to sell. Each strategy has its own detection logic and priority.

### Strategy Priority Order

**Strategies are evaluated in this order each cycle:**

1. **Blitz** → Quick scalps (highest urgency)
2. **Command** → Portfolio management (auto-sell near $1)
3. **Ratchet** → Dynamic stop-loss adjustment
4. **Ladder** → Partial profit taking
5. **Reaper** → Strategy performance cleanup

### 1. APEX Blitz - Quick Scalp

**Location:** `src/strategies/blitz.ts`

**Purpose:** Exit positions with quick, high-percentage gains

**Trigger Conditions:**
```javascript
position.pnlPct >= minProfitPct  // e.g., 10%+ profit
&& position.pnlUsd >= minProfitUsd  // e.g., $5+ profit
&& urgency score high  // Based on hold time and profit velocity
```

**Configuration:**
```bash
# Defaults from APEX mode
AGGRESSIVE: 10% min profit, $5 min USD
```

**Example Log:**
```
🔄 Selling Patriots
   Reason: APEX Blitz: 12.5% profit in 15min
```

**Why use Blitz?**
- Lock in fast profits before market reverses
- High priority ensures quick exits
- Ideal for momentum positions

---

### 2. APEX Command - Portfolio Manager

**Location:** `src/strategies/command.ts`

**Purpose:** Auto-sell positions near $1 and manage portfolio health

**Trigger Conditions:**

**Auto-Sell (primary):**
```javascript
position.curPrice >= 0.995  // 99.5¢ or higher
```

**Oversized Position Exit:**
```javascript
position.value > maxPositionSize  // Position too large for account
```

**Underperformer Cleanup:**
```javascript
// Triggered by APEX Oracle review
position identified as underperformer
&& position.pnlPct < threshold
```

**Example Log:**
```
🔄 Selling Patriots
   Reason: APEX Command: Auto-sell at 99¢
```

**Why use Command?**
- Frees capital from near-certain outcomes
- Reduces risk exposure
- Automatic portfolio optimization

---

### 3. APEX Guardian - Hard Stop-Loss

**Location:** `src/strategies/guardian.ts`

**Purpose:** Protect against catastrophic losses

**Trigger Conditions:**
```javascript
position.pnlPct <= -maxLossPct  // e.g., -25% loss
```

**Dynamic Stop-Loss:**
Guardian calculates stop-loss based on position characteristics:
- Near-resolution positions (≥95¢): higher tolerance
- Mid-range positions: standard stop-loss
- Accounts for hold time and market volatility

**Example Log:**
```
🔄 Selling Patriots
   Reason: APEX Guardian: Stop-loss 28.5% (max 25%)
```

---

### 4. APEX Ratchet - Trailing Stop

**Location:** `src/strategies/ratchet.ts`

**Purpose:** Dynamically adjust stop-loss as position gains profit

**How it works:**
1. Records highest profit achieved
2. Sets stop-loss relative to peak
3. "Ratchets up" protection as profit increases

**Example:**
- Position hits +15% profit → ratchet sets stop at +10%
- Position hits +20% profit → ratchet moves stop to +15%
- If position falls to +15% → triggers sell

**Example Log:**
```
🔄 Selling Patriots
   Reason: APEX Ratchet: Trailing stop at 15% (peak was 22%)
```

---

### 5. APEX Ladder - Partial Exits

**Location:** `src/strategies/ladder.ts`

**Purpose:** Take profits in stages as position gains value

**How it works:**
- Defines profit "rungs" (e.g., 10%, 20%, 30%)
- Sells percentage of position at each rung
- Locks in profits while maintaining exposure

**Example:**
- +10% profit → sell 25% of position
- +20% profit → sell another 25%
- +30% profit → sell another 25%
- Remaining 25% rides to resolution

**Example Log:**
```
🔄 Selling 58.18 shares (25% of position)
   Reason: APEX Ladder: Profit rung 20% reached
```

---

### 6. APEX Reaper - Cleanup

**Location:** `src/strategies/reaper.ts`

**Purpose:** Exit positions from underperforming strategies

**Trigger:**
- APEX Oracle identifies strategy performing below threshold
- Reaper exits all positions from that strategy
- Part of daily performance review

**Example Log:**
```
🔄 Selling Patriots
   Reason: APEX Reaper: Strategy disabled (score: 35/100)
```

---

## Emergency & Recovery Mode

### Recovery Mode Activation

**Triggers when:**
```javascript
balance < RECOVERY_MODE_BALANCE_THRESHOLD  // Default: $20
```

**Recovery Mode Sell Priority:**

#### Priority 1: Exit Profitable Positions
```javascript
position.pnlPct > 3%  // Any position with 3%+ profit
```
Sells most profitable first to free capital quickly.

#### Priority 2: Exit Near-Resolution
```javascript
position.curPrice > 0.95  // 95¢+ positions
&& position.pnlPct > -10%  // Not massive losers
```
Near-certain outcomes free capital with minimal loss.

#### Priority 3: Emergency Exit Small Losses
**Only if emergency mode active:**
```javascript
balance < emergencyThreshold  // e.g., < $5
&& position.pnlPct > -5%  // Small losses only
```

**Example Log:**
```
♻️ RECOVERY MODE (Cycle 42)
   Balance: $3.15 | Positions: 8
   Emergency mode: 🚨 ACTIVE

🔄 Recovery: Patriots +5.2%
   Reason: Recovery: take 5.2% profit

✅ Recovery: Exited 3 positions

🎉 RECOVERY COMPLETE! Balance: $21.45
```

### Emergency Thresholds

```javascript
const RECOVERY_MODE_BALANCE_THRESHOLD = 20;  // Enter recovery mode
const EMERGENCY_BALANCE_THRESHOLD = 5;       // Activate emergency sells
const PROFITABLE_POSITION_THRESHOLD = 3;     // Min profit to exit in recovery
const NEAR_RESOLUTION_PRICE_THRESHOLD = 0.95;  // 95¢ threshold
const ACCEPTABLE_LOSS_THRESHOLD = -10;       // Max loss for near-resolution
const MAX_ACCEPTABLE_LOSS = -5;              // Max loss for emergency exits
```

**See also:** [docs/EMERGENCY_SELLS.md](./EMERGENCY_SELLS.md)

---

## Scavenger Mode Sells

**Location:** `src/lib/scavenger.ts`

### When Scavenger Mode Activates

Triggers when low liquidity detected:
- Low volume (< $1000 in 5min window)
- Thin order books (< $500 depth)
- Stagnant prices (< 0.1% change in 2min)
- Inactive targets (< 1 active in 5min)

**Requires sustained conditions for 3+ minutes**

### Scavenger Sell Actions

#### 1. EXIT_GREEN - Green Position Exit

**Function:** `processGreenExit()`

**Trigger:**
```javascript
position.pnlPct >= config.exit.minGreenProfitPct  // e.g., 1%
&& position.pnlUsd >= config.exit.minAcceptableProfitUsd  // e.g., $0.50
&& price is stalled (no movement in 30s)
```

**Price Protection:**
```javascript
minPrice = (costBasis + minAcceptableProfitUsd) / shares
// Ensures sell locks in minimum dollar profit
```

**Example Log:**
```
🦅 [SCAV] Green exit: Patriots | P&L: 2.5%
✅ [SCAV] Green exit success: $12.89
```

#### 2. EXIT_RED_RECOVERY - Red Position Recovery

**Function:** `processRedRecovery()`

**How it works:**
1. Monitors red (losing) positions
2. When position recovers to small profit:
   ```javascript
   position.pnlPct >= config.redMonitor.smallProfitThresholdPct  // e.g., 0.5%
   && position.pnlUsd >= config.redMonitor.minRecoveryProfitUsd  // e.g., $0.25
   ```
3. Exits with conservative slippage

**Example Log:**
```
🦅 [SCAV] Red recovered: Patriots | P&L: 0.8%
✅ [SCAV] Recovery exit success: $5.45
```

### Scavenger Configuration

```bash
# In .env (examples)
SCAVENGER_ENABLED=true
SCAVENGER_MIN_GREEN_PROFIT_PCT=1
SCAVENGER_MIN_ACCEPTABLE_PROFIT_USD=0.5
SCAVENGER_SMALL_PROFIT_THRESHOLD_PCT=0.5
SCAVENGER_MIN_RECOVERY_PROFIT_USD=0.25
```

**Default config:** `src/lib/scavenger.ts:72` (`DEFAULT_SCAVENGER_CONFIG`)

---

## Common Error Messages

### `❌ No bids available`

**Meaning:** Orderbook has zero buyers for this token

**Why it happens:**
- Market is completely illiquid
- Token is for losing outcome
- Market closed or resolved

**What to do:**
- Wait for liquidity to return
- Check if market is resolved (redeem instead)
- Consider NUCLEAR mode if desperate (⚠️ risky)

---

### `❌ Price too low: 1¢ < 67¢`

**Meaning:** Best bid is below minimum acceptable price

**Why it happens:**
- Position bought at 67¢, current best bid is 1¢
- Sell function using 1% slippage: `minPrice = 67¢ * 0.99 = 66¢`
- 1¢ < 66¢ → sell blocked

**Sell pathway indicators:**
- Standard sell: "Price too low" with 1% slippage calculation
- Emergency sell: Includes mode indicator (CONSERVATIVE/MODERATE/NUCLEAR)

**What to do:**

**If using standard `sellPosition()`:**
- Wait for better liquidity
- Position will retry on next cycle

**If using emergency mode:**
- **CONSERVATIVE mode:** Won't sell below 50% of entry (34¢)
  - Consider switching to MODERATE if needed
- **MODERATE mode:** Won't sell below 20% of entry (13¢)
  - Consider switching to NUCLEAR if desperate
- **NUCLEAR mode:** Should sell at any price
  - If still blocked, check for "No bids available"

**Example logs:**

```
# Standard sell (1% slippage)
❌ Price too low: 1¢ < 67¢

# Emergency CONSERVATIVE
❌ Price too low: 1¢ < 34¢
   Min acceptable: 34.0¢ (CONSERVATIVE mode)

# Emergency MODERATE  
❌ Price too low: 1¢ < 13¢
   Min acceptable: 13.0¢ (MODERATE mode)

# Emergency NUCLEAR
⚠️  NUCLEAR MODE - No price protection!
✅ Sold: $2.33  # Accepts any price
```

---

### `❌ Sell failed: ORDER_FAILED`

**Meaning:** CLOB rejected the order

**Common causes:**
- Insufficient shares (position already sold)
- Market closed/resolved
- Network/API error

**What to do:**
- Check position still exists
- Verify market is active
- Check error logs for details

---

### `❌ Order rejected: INSUFFICIENT_BALANCE`

**Meaning:** Not enough USDC balance (for BUYs, not SELLs)

**Note:** Should not occur for SELL orders

---

### `❌ Order rejected: PRICE_TOO_HIGH`

**Meaning:** For BUY orders, ask price exceeded maximum

**Note:** Inverse of PRICE_TOO_LOW, applies to buys

---

### `❌ Order rejected: NO_FILLS`

**Meaning:** FOK order couldn't fill completely

**Why it happens:**
- Orderbook liquidity insufficient for order size
- Price slippage between order creation and posting
- Orderbook changed between retries

**What to do:**
- Reduce position size
- Wait for better liquidity
- Check if retry logic exhausted (3 attempts default)

---

### `❌ Order rejected: MARKET_CLOSED`

**Meaning:** Market has resolved or been removed

**What to do:**
- Check if position is redeemable
- Use redeem function instead of sell
- Position may auto-redeem on next cycle

---

## Edge Cases & Known Issues

### Issue 1: Stale Orderbook Data

**Problem:** `minAcceptablePrice` calculated from outdated orderbook

**Impact:** Sells may block more aggressively than necessary

**Status:** Known issue (documented Jan 2025)

**Workaround:**
- Orderbook is fetched fresh before each sell attempt
- Retry logic helps catch price improvements
- Consider manual intervention for stuck positions

**Code reference:**
```javascript
// postOrder() fetches fresh orderbook on each retry
const currentOrderBook = await client.getOrderBook(tokenId);
```

---

### Issue 2: Fill-or-Kill May Be Too Strict

**Problem:** FOK requires 100% fill or nothing

**Impact:** In low liquidity, partial fills would succeed but FOK blocks them

**Status:** By design, but can prevent sells in illiquid markets

**Workaround:**
- NUCLEAR mode removes price constraints
- Scavenger mode has separate logic for low liquidity

---

### Issue 3: Multiple Overlapping Sell Strategies

**Problem:** Legacy code has overlapping sell logic (hedging, auto-sell, scalp)

**Impact:** Confusion about which pathway executes

**Solution (this PR):**
- Clear documentation of all pathways
- Logging improvements to identify active pathway
- Strategy priority order documented

---

### Issue 4: Price Too Low Doesn't Indicate Sell Pathway

**Problem:** Error message "Price too low: 1¢ < 67¢" doesn't indicate which sell function/strategy was used

**Impact:** Hard to troubleshoot whether issue is with:
- Standard sell (1% slippage)
- Emergency mode (CONSERVATIVE/MODERATE/NUCLEAR)
- Scavenger mode
- Strategy-specific sell

**Solution (this PR):**
- Enhanced logging includes sell pathway
- Error messages reference configuration mode
- Documentation clarifies common patterns

---

## Troubleshooting Guide

### Problem: Position won't sell, keeps showing "Price too low"

**Diagnosis steps:**

1. **Check which sell pathway is being used:**
   - Look for log indicators:
     - `🔄 Selling` → Standard sell or emergency
     - `🦅 [SCAV]` → Scavenger mode
     - `Reason: APEX Blitz` → Strategy-based
     - `Reason: Emergency:` → Emergency sell
     - `Reason: Recovery:` → Recovery mode

2. **Check price protection mode:**
   - **Standard sell:** 1% slippage (minPrice = avgPrice * 0.99)
   - **Emergency CONSERVATIVE:** 50% of entry
   - **Emergency MODERATE:** 20% of entry
   - **Emergency NUCLEAR:** No protection

3. **Check orderbook:**
   ```bash
   # Use manual inspection
   npm run manual-sell
   # Shows current bids and asks
   ```

4. **Check if bids exist:**
   - "No bids available" → Market has zero buyers
   - May need to wait or use NUCLEAR mode

**Solutions:**

**If price protection too strict:**
```bash
# Option 1: Switch to MODERATE
EMERGENCY_SELL_MODE=MODERATE

# Option 2: Switch to NUCLEAR (⚠️ accepts massive losses)
EMERGENCY_SELL_MODE=NUCLEAR
```

**If no bids at all:**
- Wait for market activity
- Check if market is resolved → use redeem
- Consider accepting total loss with NUCLEAR mode

**If using scavenger mode:**
- Scavenger has different thresholds
- May wait for price recovery before selling reds
- Check scavenger config values

---

### Problem: Sells execute but logs don't show which strategy triggered it

**Solution:**
Look for the "Reason:" field in logs:

```
🔄 Selling Patriots
   Reason: APEX Blitz: 12.5% profit in 15min
           ^^^^^^^^^^
           Strategy indicator
```

**Common reason patterns:**
- `APEX Blitz:` → Quick scalp strategy
- `APEX Command:` → Portfolio management
- `APEX Guardian:` → Stop-loss
- `APEX Ratchet:` → Trailing stop
- `APEX Ladder:` → Partial exit
- `APEX Reaper:` → Strategy cleanup
- `Recovery:` → Recovery mode
- `Emergency:` → Emergency sell
- `[SCAV]` prefix → Scavenger mode

---

### Problem: Understanding if sell is happening in recovery/emergency mode

**Look for mode indicators in logs:**

**Recovery mode:**
```
♻️ RECOVERY MODE (Cycle 42)
   Balance: $3.15 | Positions: 8
   Emergency mode: 🚨 ACTIVE
```

**Emergency sell banner (NUCLEAR):**
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🚨 EMERGENCY SELL MODE: NUCLEAR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ⚠️  NO PROTECTION - Will sell at ANY price!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Scavenger mode:**
```
🦅 Scavenger Mode Active
   Deployed: $12.50 / $100
   Positions: 3 / 10
```

---

### Problem: Need to test which sell pathway works

**Use test script:**
```bash
npm run test-sell
```

This script (if available) can test sell logic without executing real trades.

**Manual testing:**
```bash
# 1. Check your positions
npm run onchain:status

# 2. Try manual sell
npm run manual-sell

# 3. Review logs for pathway used
```

---

### Problem: Want to force sell everything immediately

**Solution:**
```bash
# Set NUCLEAR mode
EMERGENCY_SELL_MODE=NUCLEAR
EMERGENCY_BALANCE_THRESHOLD=999999  # Always active

# Restart bot
docker-compose restart

# Or rebuild
docker-compose down && docker-compose up -d --build
```

⚠️ **Warning:** This will sell at ANY price, including 1¢ positions!

---

## Quick Reference Table

| Sell Function | Price Protection | Use Case | Location |
|---------------|------------------|----------|----------|
| `sellPosition()` | 1% slippage | Standard strategy sells | `src/start.ts:714` |
| `sellPositionEmergency()` | Configurable (CONSERVATIVE/MODERATE/NUCLEAR) | Emergency & recovery | `src/start.ts:792` |
| `processGreenExit()` | Conservative (profit-locked) | Scavenger green exits | `src/lib/scavenger.ts:543` |
| `processRedRecovery()` | Conservative slippage | Scavenger red recovery | `src/lib/scavenger.ts:574` |
| `postOrder()` | Via `maxAcceptablePrice` param | Low-level execution | `src/lib/order.ts:60` |

---

## Related Documentation

- [Emergency Sells Guide](./EMERGENCY_SELLS.md) - Detailed emergency mode documentation
- [Error Reporting](./ERROR_REPORTING.md) - Error handling and reporting
- [README.md](../README.md) - General bot configuration
- [Strategy Implementations](../archive/docs/STRATEGY_IMPLEMENTATIONS.md) - V2 strategy details (archived)

---

## Need Help?

1. Check logs for sell pathway indicators
2. Review common error messages above
3. Check emergency mode configuration
4. Verify orderbook has bids (buyers)
5. Consider adjusting emergency mode if needed
6. Open GitHub issue with logs and configuration

---

**Last Updated:** 2026-01-27  
**Bot Version:** APEX v3.0
