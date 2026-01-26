# ⚡ APEX v3.0 - Quick Reference

## 📖 Documentation Quick Access

```bash
# Start here first
cat START_HERE.md

# Complete user guide
cat README-APEX-V3.md

# Migration from v2
cat BREAKING_CHANGES.md

# Implementation details
cat FINAL_SUMMARY.md

# File listing
cat FILES_CREATED.md

# Quick status
cat STATUS.txt
```

## 🔍 Code Navigation

### View Core Modules
```bash
# All core modules
ls -la src/core/

# Trading modes
cat src/core/modes.ts

# Dynamic scaling
cat src/core/scaling.ts

# Intelligent reserves
cat src/core/reserves.ts

# Performance optimizer
cat src/core/oracle.ts
```

### View Strategies
```bash
# All strategies
ls -la src/strategies/

# Market scanner (Hunter)
cat src/strategies/hunter.ts

# Momentum trading (Velocity)
cat src/strategies/velocity.ts

# Copy trading (Shadow)
cat src/strategies/shadow.ts

# Protection modules
cat src/strategies/shield.ts
cat src/strategies/guardian.ts
cat src/strategies/sentinel.ts
cat src/strategies/firewall.ts
```

### View Reporting
```bash
# Telegram reports
cat src/telegram/reports.ts

# Startup banner
cat src/utils/banner.ts
```

## 🛠️ Build Commands

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run in development
npm start

# Run with specific mode
APEX_MODE=AGGRESSIVE npm start
```

## 🔧 Configuration

### Minimum .env
```bash
PRIVATE_KEY=your_private_key_here
RPC_URL=https://polygon-rpc.com
APEX_MODE=AGGRESSIVE
```

### With All Options
```bash
# Required
PRIVATE_KEY=your_private_key_here
RPC_URL=https://polygon-rpc.com

# APEX Mode
APEX_MODE=AGGRESSIVE  # CONSERVATIVE | BALANCED | AGGRESSIVE

# Optional: Live Trading
LIVE_TRADING=I_UNDERSTAND_THE_RISKS

# Optional: Copy Trading
TARGET_ADDRESSES=0xAddress1,0xAddress2

# Optional: Telegram
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# Optional: VPN
# VPN_BYPASS_POLYMARKET_READS=false  # Default (recommended)

# Optional: Interval
INTERVAL_MS=5000
```

## 📊 Quick Stats

```bash
# Count new files
find src/core src/strategies src/telegram src/utils/banner.ts -type f 2>/dev/null | wc -l

# Count lines of code
find src/core src/strategies src/telegram src/utils/banner.ts -name "*.ts" -exec wc -l {} + | tail -1

# List all APEX docs
ls -1 *.md *.txt | grep -E "(APEX|START|FINAL|BREAKING|IMPLEMENTATION|FILES|STATUS|README-APEX)"
```

## 🎯 Strategy Quick Reference

### Entry Strategies
| Strategy | File | Risk | Description |
|----------|------|------|-------------|
| APEX Hunter | hunter.ts | 1.1× | Market scanner (6 patterns) |
| APEX Velocity | velocity.ts | 1.3× | Momentum (12%+ velocity) |
| APEX Shadow | shadow.ts | 1.0× | Copy trading |
| APEX Closer | closer.ts | 0.8× | Endgame (<24h) |
| APEX Amplifier | amplifier.ts | 1.2× | Stack winners |
| APEX Grinder | grinder.ts | 0.6× | Volume trading |

### Exit Strategies
| Strategy | File | Description |
|----------|------|-------------|
| APEX Blitz | blitz.ts | Quick scalp (10%+ profit) |
| APEX Ratchet | ratchet.ts | Dynamic trailing stops |
| APEX Ladder | ladder.ts | Partial profit-taking |
| APEX Reaper | reaper.ts | Scavenger mode exits |

### Protection
| Module | File | Function |
|--------|------|----------|
| APEX Shield | shield.ts | Hedging + stop-loss/take-profit |
| APEX Guardian | guardian.ts | Hard stop-loss |
| APEX Sentinel | sentinel.ts | Emergency exit (<5min) |
| APEX Firewall | firewall.ts | Circuit breaker |

## 🏆 Account Tiers

| Tier | Balance | Multiplier |
|------|---------|------------|
| Tier 1 | $100-$500 | 1.0× |
| Tier 2 | $500-$1500 | 1.2× |
| Tier 3 | $1500-$3000 | 1.4× |
| Tier 4 | $3000+ | 1.5× |

## ⚖️ Trading Modes

| Mode | Position | Exposure | Target | Halt |
|------|----------|----------|--------|------|
| CONSERVATIVE | 5% | 60% | +12%/wk | -10% |
| BALANCED | 7% | 70% | +18%/wk | -12% |
| AGGRESSIVE | 10% | 80% | +25%/wk | -15% |

## 📈 Position Size Formula

```
Position Size = Balance × (ModePct / 100) × TierMultiplier × StrategyWeight
```

**Example:**
- Balance: $300
- Mode: AGGRESSIVE (10%)
- Tier: 1 (1.0×)
- Strategy: Velocity (1.3×)
- **Result: $39 position**

## 🔮 Oracle Score Formula

```
Score = (WinRate × 0.6) + (AvgProfit × 10 × 0.4)
```

**Rankings:**
- CHAMPION: 75+ score
- PERFORMING: 55-75 score
- TESTING: 40-55 score
- STRUGGLING: 30-40 score
- DISABLED: <30 score

## 🎯 Hunter Patterns

1. **Momentum**: 12%+ price velocity
2. **Mispricing**: YES + NO > $1.05
3. **Volume Spike**: 3× normal volume
4. **New Market**: <6 hours old
5. **Whale Activity**: Large trade, stable price
6. **Spread Compression**: <1% spread, >$1000 liquidity

## 📊 Expected Growth (AGGRESSIVE, $300)

| Week | Balance | Weekly | Total |
|------|---------|--------|-------|
| 1 | $378 | +26% | +26% |
| 4 | $763 | +26% | +154% |
| 8 | $1,867 | +26% | +522% |
| 12 | $3,625 | +26% | +1,108% 🎯 |

## ⚠️ Important Notes

### VPN Default Changed
```bash
# Old (v2): VPN_BYPASS_POLYMARKET_READS=true (default)
# New (v3): VPN_BYPASS_POLYMARKET_READS=false (default)
```
This is a critical security fix.

### Configuration Simplified
Old system required 20+ variables.
New system requires only: `APEX_MODE=AGGRESSIVE`

### All Strategies Renamed
- Copy → APEX Shadow
- Momentum → APEX Velocity  
- Endgame → APEX Closer
- Stack → APEX Amplifier
- Scavenger → APEX Reaper
- Plus 10 new APEX modules

## 🚀 Next Actions

1. Review documentation:
   ```bash
   cat START_HERE.md
   cat README-APEX-V3.md
   ```

2. Update configuration:
   ```bash
   cp .env.example .env
   nano .env
   ```

3. Build and test:
   ```bash
   npm install
   npm run build
   npm start  # Simulation mode
   ```

4. Monitor first 24 hours:
   - Watch Telegram reports
   - Verify Oracle review
   - Check position sizing
   - Monitor protection modules

5. Scale gradually:
   - Start: CONSERVATIVE
   - After 1 week: BALANCED
   - After confidence: AGGRESSIVE

---

**Built with ⚡ by traders, for traders**  
*APEX v3.0 - Aggressive Polymarket Execution*
