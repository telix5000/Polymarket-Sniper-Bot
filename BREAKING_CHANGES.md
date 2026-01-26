# ⚠️ APEX v3.0 - Breaking Changes & Migration Guide

## 🚨 Breaking Changes

### 1. VPN_BYPASS_POLYMARKET_READS Default Changed

**What Changed:**
- **Old Behavior (v2):** `VPN_BYPASS_POLYMARKET_READS` defaulted to `true` (enabled)
- **New Behavior (v3.0):** `VPN_BYPASS_POLYMARKET_READS` defaults to `false` (disabled)

**Why This Change:**
This is a critical security fix to prevent geo-blocking issues. Routing Polymarket reads outside the VPN by default can trigger geo-blocking detection, causing authentication failures.

**Impact:**
If you were relying on the default behavior and want to maintain VPN bypass for reads (NOT RECOMMENDED), you must now explicitly set:
```bash
VPN_BYPASS_POLYMARKET_READS=true
```

**Recommendation:**
Leave this setting at the new default (`false`) unless you have a specific reason to bypass the VPN for read operations.

---

### 2. Configuration Simplified to One-Line

**What Changed:**
- **Old System:** Required 20+ environment variables for configuration
- **New System:** Only requires `APEX_MODE` (plus basic requirements)

**Example Old Configuration:**
```bash
PRESET=aggressive
INITIAL_INVESTMENT_USD=300
MAX_POSITION_USD=30
MAX_TOTAL_EXPOSURE_USD=240
HEDGE_RESERVE_PCT=15
STACK_ENABLED=true
STACK_MAX_USD=25
HEDGE_ENABLED=true
HEDGE_MAX_USD=25
STOP_LOSS_ENABLED=true
STOP_LOSS_PCT=25
# ... and many more
```

**Example New Configuration:**
```bash
APEX_MODE=AGGRESSIVE
```

**Migration:**
All the old configuration variables are replaced by intelligent auto-detection:
- Position sizes auto-scale with your balance
- Reserves auto-calculate based on actual needs
- Strategy parameters optimize based on performance

**Old Variables Removed:**
- `INITIAL_INVESTMENT_USD` → Auto-detected from wallet
- `MAX_POSITION_USD` → Auto-calculated per strategy
- `MAX_TOTAL_EXPOSURE_USD` → Auto-calculated from mode
- `HEDGE_RESERVE_PCT` → Intelligent calculation
- `STACK_MAX_USD`, `HEDGE_MAX_USD`, etc. → Auto-scaled

---

### 3. Strategy Names Rebranded

**What Changed:**
All strategies have been renamed with APEX branding:

| Old Name | New Name (v3.0) |
|----------|-----------------|
| Copy Trading | APEX Shadow |
| Momentum | APEX Velocity |
| Endgame | APEX Closer |
| Stack | APEX Amplifier |
| Volume Trade | APEX Grinder |
| Quick Scalp | APEX Blitz |
| Trailing Stop | APEX Ratchet |
| Partial Exit | APEX Ladder |
| Scavenger | APEX Reaper |
| Hedging | APEX Shield |
| Stop Loss | APEX Guardian |
| - | APEX Sentinel (NEW) |
| - | APEX Firewall (NEW) |
| - | APEX Command (NEW) |
| - | APEX Hunter (NEW) |

**Impact:**
Internal references use new names. If you have custom code or monitoring that references strategy names, update accordingly.

---

## 📋 Migration Checklist

### Step 1: Backup Current Configuration
```bash
cp .env .env.backup
```

### Step 2: Update .env File
```bash
# Keep these (required)
PRIVATE_KEY=your_private_key_here
RPC_URL=https://polygon-rpc.com

# Add new APEX mode
APEX_MODE=AGGRESSIVE  # or CONSERVATIVE or BALANCED

# Optional: Live trading
LIVE_TRADING=I_UNDERSTAND_THE_RISKS

# Optional: Copy trading
TARGET_ADDRESSES=0xAddress1,0xAddress2

# Optional: Telegram
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# Optional: VPN (if using)
# VPN_BYPASS_POLYMARKET_READS=false  # Default, recommended
```

### Step 3: Remove Old Variables
Delete these from your `.env`:
```bash
# REMOVE THESE:
# PRESET=...
# INITIAL_INVESTMENT_USD=...
# MAX_POSITION_USD=...
# MAX_TOTAL_EXPOSURE_USD=...
# HEDGE_RESERVE_PCT=...
# STACK_ENABLED=...
# STACK_MAX_USD=...
# HEDGE_ENABLED=...
# HEDGE_MAX_USD=...
# STOP_LOSS_ENABLED=...
# STOP_LOSS_PCT=...
# SCALP_ENABLED=...
# AUTO_SELL_ENABLED=...
# SCAVENGER_*=...
```

### Step 4: Choose Your Mode

**CONSERVATIVE (Recommended for beginners):**
- 5% position sizes
- 60% max exposure
- Weekly target: +12%
- Drawdown halt: -10%

**BALANCED (Recommended for most users):**
- 7% position sizes
- 70% max exposure
- Weekly target: +18%
- Drawdown halt: -12%

**AGGRESSIVE (Experienced traders only):**
- 10% position sizes
- 80% max exposure
- Weekly target: +25%
- Drawdown halt: -15%

### Step 5: Test in Simulation Mode
```bash
# Make sure LIVE_TRADING is NOT set or is set to anything except "I_UNDERSTAND_THE_RISKS"
npm start
```

Verify the startup banner shows correct configuration and watch for any errors.

### Step 6: Enable Live Trading (when ready)
```bash
LIVE_TRADING=I_UNDERSTAND_THE_RISKS
```

---

## 🆕 New Features Available

### Account Tier System
Your position sizes automatically scale as your account grows:
- Tier 1 ($100-$500): 1.0× multiplier
- Tier 2 ($500-$1500): 1.2× multiplier
- Tier 3 ($1500-$3000): 1.4× multiplier
- Tier 4 ($3000+): 1.5× multiplier

### APEX Oracle
Every 24 hours:
- Analyzes strategy performance
- Ranks strategies (CHAMPION, PERFORMING, TESTING, STRUGGLING, DISABLED)
- Reallocates capital to winners
- Sends detailed Telegram report

### APEX Hunter
Active market scanner that runs every 5 seconds, looking for:
- Momentum (12%+ velocity)
- Mispricing (YES+NO > $1.05)
- Volume spikes (3× normal)
- New markets (<6 hours old)
- Whale activity
- Spread compression

### Intelligent Reserves
Reserves calculated based on actual needs:
- Hedge reserve: Based on at-risk positions
- POL reserve: Based on transaction frequency
- Emergency reserve: Based on risky exposure

### Enhanced Protection
- APEX Shield: Hedging with automatic stop-loss/take-profit
- APEX Guardian: Dynamic stop-loss
- APEX Sentinel: Emergency exits (<5min to close)
- APEX Firewall: Circuit breaker for spending limits

---

## ⚠️ Important Notes

### VPN Users
The default for `VPN_BYPASS_POLYMARKET_READS` has changed to `false`. This is a security improvement. If you experience issues:
1. Verify your VPN is working correctly
2. Do NOT set this to `true` unless absolutely necessary
3. Contact support if you have geo-blocking issues

### Balance Requirements
APEX v3.0 is optimized for accounts with at least $100 USDC. While it will work with smaller amounts, position sizes may be suboptimal.

### First Run
On first run with v3.0:
1. Bot will detect your balance
2. Determine your account tier
3. Calculate optimal position sizes
4. Display comprehensive startup banner
5. Send configuration to Telegram (if configured)

### Stateless Architecture
APEX v3.0 uses stateless in-memory tracking:
- Tracks last 24 hours only
- No database required
- Server restart = fresh start (by design)
- All data sent to Telegram

---

## 🆘 Troubleshooting

### "Invalid APEX_MODE" Error
**Solution:** Set `APEX_MODE` to one of: `CONSERVATIVE`, `BALANCED`, or `AGGRESSIVE`

### Position Sizes Seem Wrong
**Solution:** Check your balance. Position sizes auto-scale based on your account tier.

### VPN/Geo-Blocking Issues
**Solution:** 
1. Ensure VPN is running correctly
2. Verify `VPN_BYPASS_POLYMARKET_READS=false` (default)
3. Check VPN logs for connection issues

### Missing Telegram Reports
**Solution:** 
1. Verify `TELEGRAM_BOT_TOKEN` is set
2. Verify `TELEGRAM_CHAT_ID` is set
3. Test bot connectivity

---

## 📞 Support

If you encounter issues during migration:
1. Check this migration guide
2. Review `README-APEX-V3.md`
3. Check `IMPLEMENTATION_COMPLETE.md`
4. Open an issue on GitHub

---

## 🎯 Summary

APEX v3.0 is a major upgrade that:
- ✅ Simplifies configuration (1 line vs 20+)
- ✅ Auto-scales with your account
- ✅ Self-optimizes daily
- ✅ Actively hunts opportunities
- ✅ Provides comprehensive protection
- ⚠️ Changes VPN default (security fix)
- ⚠️ Requires migration of configuration

**The effort is worth it!** APEX v3.0 transforms the bot from passive to predator. 🦖⚡💰
