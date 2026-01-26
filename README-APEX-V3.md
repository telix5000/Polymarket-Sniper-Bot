# ⚡ APEX v3.0 - Aggressive Polymarket Execution

<div align="center">

```
   █████╗ ██████╗ ███████╗██╗  ██╗
  ██╔══██╗██╔══██╗██╔════╝╚██╗██╔╝
  ███████║██████╔╝█████╗   ╚███╔╝ 
  ██╔══██║██╔═══╝ ██╔══╝   ██╔██╗ 
  ██║  ██║██║     ███████╗██╔╝ ██╗
  ╚═╝  ╚═╝╚═╝     ╚══════╝╚═╝  ╚═╝
```

**Intelligent, Self-Optimizing, 24/7 Trading Machine**

[![Version](https://img.shields.io/badge/version-3.0-blue.svg)](https://github.com/your-repo)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

</div>

---

## 🚀 What is APEX v3.0?

APEX (Aggressive Polymarket Execution) v3.0 is a **complete revolution** of the Polymarket trading bot. It transforms a passive follower into an **APEX PREDATOR** - an intelligent, self-optimizing trading machine that:

- ⚡ **Auto-detects** wallet balance and optimizes everything
- 📈 **Auto-scales** position sizes as your account grows
- 🧠 **Self-optimizes** daily with the APEX Oracle
- 🎯 **Hunts opportunities** with 6 active scanning patterns
- 🛡️ **Protects capital** with 8 protection modules
- 📊 **Tracks performance** with stateless 24hr memory
- 🌍 **Never sleeps** - 24/7 market monitoring

---

## ✨ Key Features

### 🎯 ONE-LINE CONFIGURATION
```bash
APEX_MODE=AGGRESSIVE
```
That's it! No more manual USD limits, static percentages, or complex configurations. APEX auto-detects your balance and optimizes everything.

### 📊 PERCENTAGE-BASED AUTO-SCALING
Position sizes scale automatically with your balance:

**Formula:**
```
Position Size = Balance × (ModePct / 100) × TierMultiplier × StrategyWeight
```

**Example ($300 balance, AGGRESSIVE mode, Velocity strategy):**
```
$300 × 10% × 1.0 × 1.3 = $39 position
```

### 🏆 ACCOUNT TIERS
Your trading power scales as you grow:

| Tier | Balance | Multiplier |
|------|---------|------------|
| Tier 1 | $100-$500 | 1.0× |
| Tier 2 | $500-$1500 | 1.2× |
| Tier 3 | $1500-$3000 | 1.4× |
| Tier 4 | $3000+ | 1.5× |

### 🧠 INTELLIGENT RESERVES
No more arbitrary percentages! Reserves calculated based on actual needs:

- **Hedge Reserve**: Based on at-risk positions
- **POL Reserve**: Based on transaction frequency  
- **Emergency Reserve**: Based on risky exposure

### 🔮 APEX ORACLE - DAILY OPTIMIZER
Every 24 hours, the Oracle:
1. Analyzes each strategy's performance
2. Calculates priority scores
3. Ranks strategies (CHAMPION, PERFORMING, TESTING, STRUGGLING, DISABLED)
4. Reallocates capital to winners
5. Sends detailed Telegram report

**Priority Score:**
```
Score = (WinRate × 0.6) + (AvgProfit × 10 × 0.4)
```

### 🎯 APEX HUNTER - ACTIVE SCANNER
Scans markets every 5 seconds for 6 hunting patterns:

1. **Momentum Detection**: 12%+ price velocity in 30min
2. **Mispricing Detection**: YES + NO > $1.05
3. **Volume Spike Detection**: 3× normal volume
4. **New Market Detection**: Markets <6 hours old
5. **Whale Activity Detection**: Large trades, price stable
6. **Spread Compression**: Spread <1%, liquidity >$1000

---

## 🎮 THREE TRADING MODES

### 🛡️ CONSERVATIVE
- Position Size: **5%** of balance
- Max Exposure: **60%**
- Weekly Target: **+12%**
- Drawdown Halt: **-10%**

### ⚖️ BALANCED  
- Position Size: **7%** of balance
- Max Exposure: **70%**
- Weekly Target: **+18%**
- Drawdown Halt: **-12%**

### 🔥 AGGRESSIVE (Recommended)
- Position Size: **10%** of balance
- Max Exposure: **80%**
- Weekly Target: **+25%**
- Drawdown Halt: **-15%**

---

## 🎯 APEX STRATEGIES

### 📈 ENTRY STRATEGIES

| Strategy | Description | Risk Weight |
|----------|-------------|-------------|
| ⚡ **APEX Velocity** | Momentum trading (12%+ velocity) | 1.3× |
| 👤 **APEX Shadow** | Copy successful traders | 1.0× |
| 🎯 **APEX Closer** | Endgame opportunities (<24h) | 0.8× |
| 💎 **APEX Amplifier** | Stack winning positions | 1.2× |
| 🔄 **APEX Grinder** | High-volume tight spreads | 0.6× |
| 🎯 **APEX Hunter** | Active market scanner | 1.1× |

### 📉 EXIT STRATEGIES

| Strategy | Description |
|----------|-------------|
| ⚡ **APEX Blitz** | Quick scalp (10%+ profit) |
| 📈 **APEX Ratchet** | Trailing stops (dynamic) |
| 📊 **APEX Ladder** | Partial exits at milestones |
| 💀 **APEX Reaper** | Scavenger mode exits |

### 🛡️ PROTECTION MODULES

| Module | Function |
|--------|----------|
| 🛡️ **APEX Shield** | Intelligent hedging with stop-loss |
| 🛡️ **APEX Guardian** | Hard stop-loss protection |
| 🚨 **APEX Sentinel** | Emergency exit (<5min to close) |
| 🔥 **APEX Firewall** | Circuit breaker & limits |
| 🎮 **APEX Command** | Portfolio manager |

### 🧠 INTELLIGENCE MODULES

| Module | Function |
|--------|----------|
| 🧠 **APEX Brain** | Intelligent reserve calculator |
| 📈 **APEX Multiplier** | Dynamic scaling engine |
| 🔮 **APEX Oracle** | Daily performance optimizer |

---

## 📦 Installation

### Prerequisites
- Node.js v18+
- Polygon wallet with USDC
- (Optional) VPN for geo-restricted regions
- (Optional) Telegram bot for notifications

### Quick Start

1. **Clone the repository:**
```bash
git clone https://github.com/your-repo/apex-bot.git
cd apex-bot
```

2. **Install dependencies:**
```bash
npm install
```

3. **Configure environment:**
```bash
cp .env.example .env
nano .env
```

**Minimal configuration:**
```bash
PRIVATE_KEY=your_private_key_here
RPC_URL=https://polygon-rpc.com
APEX_MODE=AGGRESSIVE
```

4. **Start the bot:**
```bash
npm start
```

---

## ⚙️ Configuration

### Required Variables
```bash
PRIVATE_KEY=your_private_key_here
RPC_URL=https://polygon-rpc.com
```

### APEX Configuration
```bash
# Choose your mode
APEX_MODE=AGGRESSIVE  # CONSERVATIVE | BALANCED | AGGRESSIVE

# Enable live trading
LIVE_TRADING=I_UNDERSTAND_THE_RISKS

# Cycle interval (milliseconds)
INTERVAL_MS=5000
```

### Optional: Copy Trading
```bash
TARGET_ADDRESSES=0xAddress1,0xAddress2
```

### Optional: Telegram Notifications
```bash
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
```

### Optional: VPN Configuration
See [VPN Setup Guide](docs/vpn-setup.md)

---

## 🎯 Expected Performance

Starting with **$300** in AGGRESSIVE mode:

| Week | Balance | Gain |
|------|---------|------|
| Week 1 | $378 | +26% |
| Week 4 | $763 | +154% |
| Week 8 | $1,867 | +522% |
| **Week 12** | **$3,625** | **🎯 +1,108%** |

**Target: $3,000 (10× return in ~12 weeks)**

*Past performance doesn't guarantee future results. Trade responsibly.*

---

## 📊 Execution Priority

Every 5-second cycle executes in this order:

```
1. HUNT      → Scan markets for opportunities
2. EXITS     → Blitz, Ratchet, Ladder, Command, Reaper
3. PROTECTION → Shield, Guardian, Sentinel, Firewall
4. ENTRIES   → Execute opportunities from Hunter
5. STRATEGIES → Velocity, Shadow, Grinder, Closer, Amplifier
```

---

## 📈 Telegram Reports

### Real-time
- Every trade executed
- Critical alerts
- Protection activations

### Hourly Summary
- Balance & P&L
- Positions & exposure  
- Trades & win rate

### Daily Oracle Review
- Strategy rankings
- Capital allocations
- Market conditions
- Top performers

### Weekly Progress
- Weekly P&L
- Target progress
- Best/worst days
- Top strategies

---

## 🛡️ Critical Fixes (v3.0)

### 1. VPN_BYPASS_POLYMARKET_READS
**Default changed to `false`** to prevent geo-blocking issues.

### 2. Hedge Stop-Loss & Take-Profit
Hedges now have automatic exits:
- **Stop-Loss**: Exit if hedge loses 5%+
- **Take-Profit**: Exit if hedge gains 15%+

### 3. Never Hedge a Hedge
Protection against double-hedging implemented.

---

## 🏗️ Architecture

### Stateless Design
- No database required
- 24-hour in-memory tracking
- Server restart = fresh start (by design!)
- All data sent to Telegram

### Modular Structure
```
src/
├── core/           # Core APEX modules
│   ├── modes.ts    # Trading modes
│   ├── scaling.ts  # Dynamic scaling
│   ├── reserves.ts # Intelligent reserves
│   └── oracle.ts   # Performance optimizer
├── strategies/     # Trading strategies
│   ├── hunter.ts   # Market scanner
│   ├── velocity.ts # Momentum
│   ├── shadow.ts   # Copy trading
│   ├── blitz.ts    # Quick scalp
│   ├── ratchet.ts  # Trailing stops
│   ├── ladder.ts   # Partial exits
│   ├── grinder.ts  # Volume trading
│   ├── closer.ts   # Endgame
│   ├── amplifier.ts # Stacking
│   ├── reaper.ts   # Scavenger
│   ├── shield.ts   # Hedging
│   ├── guardian.ts # Stop-loss
│   ├── sentinel.ts # Emergency
│   ├── firewall.ts # Circuit breaker
│   └── command.ts  # Portfolio mgmt
├── telegram/       # Reporting
│   └── reports.ts
└── lib/            # Utilities
```

---

## 🔒 Security

- ✅ Private keys stored locally only
- ✅ No data sent to external services (except Telegram)
- ✅ All trades signed locally
- ✅ Open-source for audit
- ✅ No database = no data leaks

---

## 🤝 Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Open a Pull Request

---

## 📜 License

MIT License - see [LICENSE](LICENSE) file

---

## ⚠️ Disclaimer

**This software is for educational purposes only.**

- Cryptocurrency trading involves substantial risk
- Never invest more than you can afford to lose
- Past performance doesn't guarantee future results
- The authors are not responsible for financial losses
- Use at your own risk
- Always do your own research

---

## 📞 Support

- 📖 [Documentation](docs/)
- 🐛 [Report Issues](https://github.com/your-repo/issues)
- 💬 [Discussions](https://github.com/your-repo/discussions)

---

<div align="center">

**Built with ⚡ by traders, for traders**

</div>
