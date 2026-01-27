# 🚨 Emergency Sell Mode

## Overview

When your balance drops critically low but you have positions, APEX v3.0 enters **Recovery Mode** and uses **Emergency Sell Logic** to liquidate positions and free capital.

## Configuration

### Environment Variables

```bash
# Emergency sell mode
EMERGENCY_SELL_MODE=CONSERVATIVE  # CONSERVATIVE | MODERATE | NUCLEAR

# Balance threshold (activates when balance < this amount)
EMERGENCY_BALANCE_THRESHOLD=5
```

## Modes Explained

### CONSERVATIVE (Default)
**Protection:** Won't sell below 50% of entry price

**Example:**
- Entry price: 67¢
- Minimum acceptable: 34¢ (50% of 67¢)
- Best bid: 1¢
- **Result:** ❌ BLOCKED (protects from 98% loss)

**Use when:**
- You believe liquidity will improve
- You don't want to lock in catastrophic losses
- You can wait for better prices

### MODERATE
**Protection:** Won't sell below 20% of entry price

**Example:**
- Entry price: 67¢
- Minimum acceptable: 13¢ (20% of 67¢)
- Best bid: 1¢
- **Result:** ❌ BLOCKED (but allows 80% loss)

**Use when:**
- You need liquidity but want SOME protection
- Markets are mostly dead but might have occasional spikes
- Willing to accept large losses but not total wipeouts

### NUCLEAR ⚠️
**Protection:** NONE - Sells at ANY price

**Example:**
- Entry price: 67¢
- Minimum acceptable: NONE
- Best bid: 1¢
- **Result:** ✅ SELLS (accepts 98.5% loss)

**Use when:**
- You NEED capital immediately
- Markets are completely dead with no hope
- Willing to take total loss to free capital
- Every dollar counts more than P&L

## How It Works

1. **Balance Check**
   - If balance < `EMERGENCY_BALANCE_THRESHOLD` → Emergency mode ON
   - If balance >= threshold → Normal mode

2. **Price Calculation**
   - Gets best bid from orderbook
   - Calculates minimum acceptable based on mode
   - Compares bid vs minimum

3. **Execution**
   - If bid >= minimum → Executes sell
   - If bid < minimum → Blocks sell (logs reason)

4. **Logging**
   ```
   🔄 Selling Patriots
      Entry: 67¢
      Current: 1¢
      Min acceptable: 34¢ (CONSERVATIVE mode)
   
   ❌ Sell failed: PRICE_TOO_LOW
      Bid price below CONSERVATIVE threshold
      To force sell, use NUCLEAR mode (⚠️ accepts massive losses)
   ```

## Changing Modes

### Option 1: Environment Variable
```bash
# In .env
EMERGENCY_SELL_MODE=NUCLEAR
```

Then restart bot:
```bash
docker-compose restart
```

### Option 2: Rebuild (if env change doesn't work)
```bash
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

## Recommendations

### Scenario 1: Markets are illiquid but not dead
**Recommendation:** CONSERVATIVE
- Protects from panic selling
- Waits for liquidity spikes
- May never sell if markets truly dead

### Scenario 2: Need capital soon, markets mostly dead
**Recommendation:** MODERATE
- Allows 80% losses
- Catches occasional liquidity
- Better than NUCLEAR

### Scenario 3: Markets completely dead, need any capital
**Recommendation:** NUCLEAR
- Sells at ANY price
- Frees capital immediately
- Accepts total loss

## Example Output

### CONSERVATIVE Mode (Default Setup)
```
♻️ RECOVERY MODE (Cycle 42)
   Balance: $0.15 | Positions: 8
   Emergency mode: 🚨 ACTIVE

🔄 Emergency: Patriots -0.9%
   Entry: 67¢
   Current: 1¢
   Min acceptable: 34¢ (CONSERVATIVE mode)

❌ Sell failed: PRICE_TOO_LOW
   Bid price below CONSERVATIVE threshold

💡 Tip: CONSERVATIVE mode may block very low bids
   Consider MODERATE or NUCLEAR mode if desperate
```

### NUCLEAR Mode
```
♻️ RECOVERY MODE (Cycle 42)
   Balance: $0.15 | Positions: 8
   Emergency mode: 🚨 ACTIVE

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🚨 EMERGENCY SELL MODE: NUCLEAR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ⚠️  NO PROTECTION - Will sell at ANY price!
   ⚠️  This may result in massive losses!
   Activate when balance < $5.00
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🔄 Emergency: Patriots -0.9%
   Entry: 67¢
   Current: 1¢
   ⚠️  NUCLEAR MODE - No price protection!

✅ Sold: $0.09 (from $5.01 position)

💰 POSITION SOLD
Patriots
Entry: 67¢
Sold: 1¢
P&L: -98.5%
Received: $0.09
```

## Safety Features

1. **Requires explicit configuration**
   - NUCLEAR mode must be set in .env
   - Won't accidentally activate

2. **Balance threshold**
   - Only activates below threshold
   - Above threshold = normal protection

3. **Logging at every step**
   - Shows mode in use
   - Shows min acceptable price
   - Shows why sells blocked/executed

4. **Telegram notifications**
   - Get notified of every sell
   - Includes P&L information
   - Can monitor remotely

## FAQ

**Q: Will CONSERVATIVE mode ever sell my 1¢ positions?**
A: Only if best bid improves to 34¢+ (50% of your 67¢ entry)

**Q: How do I force sell everything immediately?**
A: Set `EMERGENCY_SELL_MODE=NUCLEAR` and restart

**Q: Can I change modes without losing positions?**
A: Yes - just change .env and restart. Positions remain.

**Q: What if orderbook has NO bids?**
A: Sell is blocked regardless of mode (can't sell with no buyers)

**Q: Does this affect normal trading?**
A: No - only affects Recovery Mode (when balance < $20)
