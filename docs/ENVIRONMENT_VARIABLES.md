# Environment Variables Reference

A comprehensive guide to all environment variables in Polymarket Sniper Bot. This document is organized by category with clear descriptions, default values, and usage examples.

---

## 📋 Table of Contents

- [Quick Start (Minimal Configuration)](#-quick-start-minimal-configuration)
- [Core Required Variables](#-core-required-variables)
- [CLOB Authentication](#-clob-authentication)
- [Trading Configuration](#-trading-configuration)
- [Strategy Presets](#-strategy-presets)
- [Position Management](#-position-management)
- [Auto-Sell & Exit Strategies](#-auto-sell--exit-strategies)
- [Hedging](#-smart-hedging)
- [Scalping Configuration](#-scalping-configuration)
- [Auto-Redeem](#-auto-redeem)
- [Arbitrage Engine](#-arbitrage-engine)
- [Monitor/Copy Trading](#-monitorcopy-trading)
- [Leaderboard Settings](#-leaderboard-settings)
- [Gas & Network](#-gas--network)
- [Relayer & Builder](#-relayer--builder)
- [Approvals](#-approvals)
- [Rate Limiting](#-rate-limiting)
- [Logging & Debugging](#-logging--debugging)
- [Telegram Notifications](#-telegram-notifications)
- [VPN Configuration](#-vpn-configuration)
- [Contract Addresses](#-contract-addresses)
- [Advanced/Debug Options](#-advanceddebug-options)

---

## 🚀 Quick Start (Minimal Configuration)

Following [pmxt methodology](https://github.com/pmxt-dev/pmxt), you only need **3 variables** to get started:

```bash
# Required - Your Polygon wallet private key
PRIVATE_KEY=your_private_key_here

# Required - Polygon RPC endpoint
RPC_URL=https://polygon-rpc.com

# Optional - Target addresses for copy trading
# If not set, automatically fetches top 20 traders from Polymarket leaderboard
TARGET_ADDRESSES=0xabc...,0xdef...
```

**That's it!** The bot automatically:
- ✅ Derives CLOB API credentials from your private key
- ✅ Uses EOA signature type (0) by default
- ✅ Uses official Polygon USDC.e address
- ✅ Auto-detects your wallet type and auth method
- ✅ Fetches target addresses from leaderboard if not specified

---

## 🔑 Core Required Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `PRIVATE_KEY` | Your Polygon wallet private key (64 hex chars, 0x prefix optional) | ✅ Yes | - |
| `RPC_URL` | Polygon RPC endpoint URL | ✅ Yes | - |
| `PUBLIC_KEY` | Your wallet address (auto-derived from PRIVATE_KEY if omitted) | No | Derived |

### Example
```bash
PRIVATE_KEY=your_64_character_hex_private_key
RPC_URL=https://polygon-mainnet.infura.io/v3/YOUR_PROJECT_ID
# PUBLIC_KEY is auto-derived - no need to set it
```

---

## 🔐 CLOB Authentication

Polymarket uses **two different credential systems** - understanding this is critical for successful setup.

### Credential Derivation (Recommended)

| Variable | Description | Default |
|----------|-------------|---------|
| `CLOB_DERIVE_CREDS` | Enable automatic credential derivation from PRIVATE_KEY | `true` |

### Manual CLOB Credentials (Advanced)

Only use these if you have explicitly generated CLOB credentials:

| Variable | Description | Aliases |
|----------|-------------|---------|
| `POLYMARKET_API_KEY` | CLOB API key | `POLY_API_KEY`, `CLOB_API_KEY` |
| `POLYMARKET_API_SECRET` | CLOB API secret | `POLY_SECRET`, `CLOB_API_SECRET` |
| `POLYMARKET_API_PASSPHRASE` | CLOB API passphrase | `POLY_PASSPHRASE`, `CLOB_API_PASSPHRASE` |

### Signature Configuration

| Variable | Description | Default | Values |
|----------|-------------|---------|--------|
| `POLYMARKET_SIGNATURE_TYPE` | Wallet signature type | `0` (EOA) | `0`=EOA, `1`=PROXY, `2`=GNOSIS_SAFE |
| `POLYMARKET_PROXY_ADDRESS` | Proxy/Safe address (required for type 1 or 2) | - | Ethereum address |

### Advanced Auth Options

| Variable | Description | Default |
|----------|-------------|---------|
| `CLOB_FORCE_WALLET_MODE` | Force specific wallet mode | `auto` |
| `CLOB_FORCE_L1_AUTH` | Force specific L1 auth address | `auto` |
| `AUTH_DERIVE_RETRY_SECONDS` | Retry delay after 400 error | `600` (10 min) |
| `CLOB_AUTH_COOLDOWN_SECONDS` | Cooldown after auth failure | `300` (5 min) |

### Recommended Setup
```bash
# Just set PRIVATE_KEY - credentials are auto-derived
PRIVATE_KEY=your_private_key_here
# CLOB_DERIVE_CREDS=true is the default - no need to set it
```

---

## 💰 Trading Configuration

### Core Trading Variables

| Variable | Description | Default | Range |
|----------|-------------|---------|-------|
| `ARB_LIVE_TRADING` | Enable live trading (must be exactly this value) | - | `I_UNDERSTAND_THE_RISKS` |
| `TRADE_MODE` | Trading execution mode | `clob` | `clob`, `onchain` |
| `MIN_ORDER_USD` | Minimum order size in USD | `10` | Any positive number |
| `MIN_TRADE_SIZE_USD` | Minimum trade size to copy (monitor mode) | `100` | Any positive number |

### Buy Price Protection

| Variable | Description | Default | Range |
|----------|-------------|---------|-------|
| `MIN_BUY_PRICE` | Minimum price for BUY orders (prevents buying losers) | `0.50` | `0.0` - `1.0` |

**Recommended values:**
- `0.15` (15¢): Aggressive - blocks only extreme losers
- `0.25` (25¢): Moderate - blocks most risky positions
- `0.50` (50¢): Conservative - only copy trades close to fair odds

### Frontrunning Settings

| Variable | Description | Default | Range |
|----------|-------------|---------|-------|
| `FRONTRUN_SIZE_MULTIPLIER` | Percentage of target trade to frontrun | `0.5` (50%) | `0.0` - `1.0` |
| `FRONTRUN_MAX_SIZE_USD` | Maximum USD size for frontrun orders | `50` | Any positive number |

### Example
```bash
ARB_LIVE_TRADING=I_UNDERSTAND_THE_RISKS
TRADE_MODE=clob
MIN_ORDER_USD=10
MIN_BUY_PRICE=0.25
FRONTRUN_SIZE_MULTIPLIER=0.5
FRONTRUN_MAX_SIZE_USD=50
```

---

## 🎛️ Strategy Presets

Presets provide curated configurations for different trading styles.

### Main Preset

| Variable | Description | Default | Options |
|----------|-------------|---------|---------|
| `STRATEGY_PRESET` | Master strategy configuration | `balanced` | `off`, `conservative`, `balanced`, `aggressive` |

### Strategy Preset Comparison

| Preset | Risk | Description |
|--------|------|-------------|
| `off` | None | All strategies disabled |
| `conservative` | Low | Higher minimums, slower execution, larger profit targets |
| `balanced` | Medium | Default settings, good for most users |
| `aggressive` | High | Lower minimums, faster execution, smaller profit targets |

### Mode-Specific Presets

| Variable | Description | Default | Options |
|----------|-------------|---------|---------|
| `ARB_PRESET` | Arbitrage engine preset | `safe_small` | `off`, `safe_small`, `classic`, `micro`, `quality`, `late` |
| `MONITOR_PRESET` | Copy trading preset | `balanced` | `off`, `conservative`, `balanced`, `active`, `test` |
| `MODE` | Operating mode | `mempool` | `mempool`, `arb`, `both` |

### Arbitrage Presets

| Preset | Scan Interval | Min Edge | Risk |
|--------|---------------|----------|------|
| `off` | N/A | N/A | None |
| `safe_small` | 1s | 0.5% | Low |
| `classic` | 0.5s | 0.3% | Medium |
| `micro` | 0.25s | 0.2% | Medium |
| `quality` | 1s | 1.0% | Low |
| `late` | 0.25s | 0.3% | Medium |

### Monitor Presets

| Preset | Poll Interval | Min Trade | Risk |
|--------|---------------|-----------|------|
| `off` | N/A | N/A | None |
| `conservative` | 2s | $250 | Low |
| `balanced` | 2s | $75 | Medium |
| `active` | 1s | $25 | Higher |
| `test` | 2s | $5 | Highest |

### Example
```bash
STRATEGY_PRESET=balanced
ARB_PRESET=classic
MONITOR_PRESET=balanced
MODE=both
```

---

## 📊 Position Management

### Position Sizing

| Variable | Description | Default |
|----------|-------------|---------|
| `MAX_POSITION_USD` | Maximum USD per position | Varies by preset (15-100) |
| `ARB_MAX_POSITION_USD` | Max position for arbitrage | `15` |
| `ARB_MAX_WALLET_EXPOSURE_USD` | Total portfolio exposure limit | Varies by preset |

### Enterprise Risk Management

| Variable | Description | Default |
|----------|-------------|---------|
| `MAX_EXPOSURE_USD` | Total portfolio exposure | Varies by preset |
| `MAX_EXPOSURE_PER_MARKET_USD` | Per-market limit | Varies by preset |
| `MAX_DRAWDOWN_PCT` | Circuit breaker threshold | Varies by preset |

### Position Stacking

| Variable | Description | Default |
|----------|-------------|---------|
| `POSITION_STACKING_ENABLED` | Enable doubling down on winners | `true` |
| `POSITION_STACKING_MIN_GAIN_CENTS` | Min gain in cents before stacking | `20` |
| `POSITION_STACKING_MAX_CURRENT_PRICE` | Max price to stack at | `0.95` (95¢) |

### Example
```bash
MAX_POSITION_USD=25
POSITION_STACKING_ENABLED=true
POSITION_STACKING_MIN_GAIN_CENTS=20
POSITION_STACKING_MAX_CURRENT_PRICE=0.95
```

---

## 🚪 Auto-Sell & Exit Strategies

### Auto-Sell (Near Resolution)

| Variable | Description | Default |
|----------|-------------|---------|
| `AUTO_SELL_ENABLED` | Enable automatic selling at high prices | `true` |
| `AUTO_SELL_THRESHOLD` | Price threshold to trigger sell | `0.999` (99.9¢) |
| `AUTO_SELL_MIN_HOLD_SEC` | Minimum hold time before selling | `60` |
| `AUTO_SELL_STALE_POSITION_HOURS` | Hours before profitable position is "stale" | `24` |

### Dispute Window Exit

| Variable | Description | Default |
|----------|-------------|---------|
| `AUTO_SELL_DISPUTE_EXIT_ENABLED` | Enable dispute window exit | `true` |
| `AUTO_SELL_DISPUTE_EXIT_PRICE` | Exit price during disputes | `0.999` (99.9¢) |

### Sell Early Strategy

| Variable | Description | Default |
|----------|-------------|---------|
| `SELL_EARLY_ENABLED` | Enable selling at near-resolution | `true` |
| `SELL_EARLY_BID_CENTS` | Sell when bid reaches this level | `99.9` |
| `SELL_EARLY_MIN_LIQUIDITY_USD` | Min liquidity (0 = disabled) | `0` |
| `SELL_EARLY_MAX_SPREAD_CENTS` | Max spread (0 = disabled) | `0` |
| `SELL_EARLY_MIN_HOLD_SEC` | Min hold time (0 = disabled) | `0` |

### On-Chain Exit

| Variable | Description | Default |
|----------|-------------|---------|
| `ON_CHAIN_EXIT_ENABLED` | Route non-tradable positions to redemption | `true` |
| `ON_CHAIN_EXIT_PRICE_THRESHOLD` | Price threshold for on-chain exit | `0.99` (99¢) |
| `ON_CHAIN_EXIT_MIN_POSITION_USD` | Min position value for exit | `0.01` |

### Example
```bash
AUTO_SELL_ENABLED=true
AUTO_SELL_THRESHOLD=0.999
AUTO_SELL_MIN_HOLD_SEC=60
AUTO_SELL_STALE_POSITION_HOURS=24
ON_CHAIN_EXIT_ENABLED=true
```

---

## 🛡️ Hedging

Hedging protects against losses by buying the opposing side instead of selling at a loss.

| Variable | Description | Default |
|----------|-------------|---------|
| `HEDGING_ENABLED` | Enable hedging | `true` |
| `HEDGING_DIRECTION` | Hedging direction | `both` |
| `HEDGING_TRIGGER_LOSS_PCT` | Loss percentage to trigger hedge | `20` |
| `HEDGING_MAX_HEDGE_USD` | Maximum USD per hedge | Varies (10-50) |
| `HEDGING_RESERVE_PCT` | Percentage reserved for hedging | `20` |

### Hedge Up Settings (Buy More When Winning)

| Variable | Description | Default |
|----------|-------------|---------|
| `HEDGING_HEDGE_UP_PRICE_THRESHOLD` | Min price for hedge up | `0.85` (85¢) |
| `HEDGING_HEDGE_UP_MAX_PRICE` | Max price for hedge up | `0.95` (95¢) |
| `HEDGING_HEDGE_UP_WINDOW_MINUTES` | Minutes before close | `30` |
| `HEDGING_HEDGE_UP_MAX_USD` | Max USD for hedge up | `25` |
| `HEDGING_HEDGE_UP_ANYTIME` | Allow hedge up anytime | `false` |

### Direction Options
- `down`: Only hedge losing positions (traditional)
- `up`: Only buy more when winning at high probability
- `both`: Both behaviors enabled (default)

### Example
```bash
HEDGING_ENABLED=true
HEDGING_DIRECTION=both
HEDGING_TRIGGER_LOSS_PCT=20
HEDGING_MAX_HEDGE_USD=25
HEDGING_RESERVE_PCT=20
```

---

## 📈 Scalping Configuration

### Quick Flip

| Variable | Description | Default |
|----------|-------------|---------|
| `QUICK_FLIP_ENABLED` | Enable quick flip strategy | `true` |
| `QUICK_FLIP_TARGET_PCT` | Target profit percentage | Varies (10-30) |
| `QUICK_FLIP_MIN_HOLD_SECONDS` | Minimum hold time | `30-60` |
| `QUICK_FLIP_MIN_PROFIT_USD` | Minimum profit in USD | `0.25-2.0` |

### Low-Price Scalping

| Variable | Description | Default |
|----------|-------------|---------|
| `SCALP_LOW_PRICE_THRESHOLD` | Buy threshold for scalping | - |
| `SCALP_LOW_PRICE_MAX_HOLD_MINUTES` | Max hold time for low-price positions | `3` |

### Scalp Take-Profit

| Variable | Description | Default |
|----------|-------------|---------|
| `SCALP_TAKE_PROFIT_ENABLED` | Enable time-based profit taking | `true` |
| `SCALP_MIN_HOLD_MINUTES` | Minimum hold time | `45-60` |
| `SCALP_MAX_HOLD_MINUTES` | Force exit time | `90-120` |
| `SCALP_MIN_PROFIT_PCT` | Minimum profit percentage | `3-8` |
| `SCALP_TARGET_PROFIT_PCT` | Target profit percentage | `5-12` |
| `SCALP_MIN_PROFIT_USD` | Minimum profit in USD | `0.5-2.0` |
| `SCALP_RESOLUTION_EXCLUSION_PRICE` | Never time-exit below this entry | `0.6` (60¢) |

### Sudden Spike Detection

| Variable | Description | Default |
|----------|-------------|---------|
| `SCALP_SUDDEN_SPIKE_ENABLED` | Enable spike detection | `true` |
| `SCALP_SUDDEN_SPIKE_THRESHOLD_PCT` | Spike threshold | `15-20` |
| `SCALP_SUDDEN_SPIKE_WINDOW_MINUTES` | Detection window | `10` |

### Example
```bash
SCALP_LOW_PRICE_THRESHOLD=0.20
SCALP_LOW_PRICE_MAX_HOLD_MINUTES=3
SCALP_TAKE_PROFIT_ENABLED=true
SCALP_MIN_HOLD_MINUTES=45
SCALP_TARGET_PROFIT_PCT=8
```

---

## 💵 Auto-Redeem

Automatically claim resolved market positions for USDC.

| Variable | Description | Default |
|----------|-------------|---------|
| `AUTO_REDEEM_ENABLED` | Enable automatic redemption | `true` |
| `AUTO_REDEEM_MIN_POSITION_USD` | Skip positions below this value | `0.10` |
| `AUTO_REDEEM_CHECK_INTERVAL_MS` | Check frequency in milliseconds | `30000` (30s) |

### Example
```bash
AUTO_REDEEM_ENABLED=true
AUTO_REDEEM_MIN_POSITION_USD=0.10
AUTO_REDEEM_CHECK_INTERVAL_MS=30000
```

---

## 🎯 Arbitrage Engine

### Core Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `ARB_ENABLED` | Enable arbitrage engine | `true` |
| `ARB_DRY_RUN` | Run in simulation mode | `true` |
| `ARB_SCAN_INTERVAL_MS` | Scan interval in milliseconds | `1000-2000` |

### Edge & Profit

| Variable | Description | Default |
|----------|-------------|---------|
| `ARB_MIN_EDGE_BPS` | Minimum edge in basis points | `30-300` |
| `ARB_MIN_PROFIT_USD` | Minimum profit per trade | `0.1-1.0` |
| `ARB_MIN_LIQUIDITY_USD` | Minimum liquidity | `2000-15000` |
| `ARB_MAX_SPREAD_BPS` | Maximum spread | `100-250` |

### Sizing

| Variable | Description | Default |
|----------|-------------|---------|
| `ARB_TRADE_BASE_USD` | Base trade size | `2-8` |
| `ARB_SIZE_SCALING` | Scaling method | `sqrt` |
| `ARB_SLIPPAGE_BPS` | Slippage tolerance | `20-40` |
| `ARB_FEE_BPS` | Fee in basis points | `1` (0.01%) |

### Limits

| Variable | Description | Default |
|----------|-------------|---------|
| `ARB_MAX_HOLD_MINUTES` | Maximum hold time | `120` |
| `ARB_MAX_TRADES_PER_HOUR` | Max trades per hour | `5000-20000` |
| `ARB_MAX_CONCURRENT_TRADES` | Max concurrent trades | `10-20` |
| `ARB_MAX_CONSECUTIVE_FAILURES` | Circuit breaker threshold | `5-10` |

### Safety

| Variable | Description | Default |
|----------|-------------|---------|
| `ARB_STARTUP_COOLDOWN_SECONDS` | Cooldown at startup | `3-30` |
| `ARB_MARKET_COOLDOWN_SECONDS` | Per-market cooldown | `1-10` |
| `ARB_KILL_SWITCH_FILE` | Kill switch file path | `/data/KILL` |
| `ARB_DECISIONS_LOG` | Decisions log path | `/data/arb_decisions.jsonl` |
| `ARB_MIN_POL_GAS` | Minimum POL for gas | `3` |

### Example
```bash
ARB_PRESET=classic
ARB_DRY_RUN=false
ARB_LIVE_TRADING=I_UNDERSTAND_THE_RISKS
ARB_MIN_EDGE_BPS=50
ARB_MAX_POSITION_USD=25
ARB_MAX_WALLET_EXPOSURE_USD=100
```

---

## 👀 Monitor/Copy Trading

### Target Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `TARGET_ADDRESSES` | Comma-separated addresses to monitor | Auto-fetched from leaderboard |
| `MONITOR_ENABLED` | Enable monitor mode | `true` |
| `MONITOR_REQUIRE_CONFIRMED` | Require confirmed trades | `true` |

### Timing

| Variable | Description | Default |
|----------|-------------|---------|
| `FETCH_INTERVAL` | Polling interval in seconds | `1-2` |
| `TRADE_AGGREGATION_ENABLED` | Enable trade aggregation | `false` |
| `TRADE_AGGREGATION_WINDOW_SECONDS` | Aggregation window | `300` |

### Sizing

| Variable | Description | Default |
|----------|-------------|---------|
| `TRADE_MULTIPLIER` | Position size multiplier | `1.0` |
| `RETRY_LIMIT` | Max retry attempts | `3` |
| `GAS_PRICE_MULTIPLIER` | Gas price multiplier | `1.2` |

### Example
```bash
TARGET_ADDRESSES=0xabc...,0xdef...
MONITOR_ENABLED=true
FETCH_INTERVAL=2
TRADE_MULTIPLIER=0.5
```

---

## 🏆 Leaderboard Settings

When `TARGET_ADDRESSES` is not set, the bot fetches top traders automatically.

| Variable | Description | Default |
|----------|-------------|---------|
| `LEADERBOARD_LIMIT` | Number of top traders to fetch (max 50) | `20` |
| `LEADERBOARD_ENABLE_CACHE` | Enable disk caching | `false` |
| `LEADERBOARD_TTL_SECONDS` | Cache TTL in seconds | `3600` (1 hour) |
| `LEADERBOARD_CACHE_FILE` | Cache file path | `.leaderboard-cache.json` |

### Example
```bash
# Don't set TARGET_ADDRESSES to use leaderboard
LEADERBOARD_LIMIT=20
LEADERBOARD_ENABLE_CACHE=true
LEADERBOARD_TTL_SECONDS=3600
```

---

## ⛽ Gas & Network

### EIP-1559 Gas Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `POLY_GAS_MULTIPLIER` | Gas fee multiplier | `1.2` |
| `POLY_MAX_PRIORITY_FEE_GWEI` | Min priority fee in gwei | `30` |
| `POLY_MAX_FEE_GWEI` | Min max fee in gwei | `60` |
| `POLY_MAX_FEE_GWEI_CAP` | Max gas price cap | `200` |

### Example
```bash
POLY_GAS_MULTIPLIER=1.2
POLY_MAX_PRIORITY_FEE_GWEI=30
POLY_MAX_FEE_GWEI=60
POLY_MAX_FEE_GWEI_CAP=200
```

---

## 🔄 Relayer & Builder

For gasless transactions via Polymarket's relayer infrastructure.

### Builder Credentials (Recommended)

| Variable | Description |
|----------|-------------|
| `POLY_BUILDER_API_KEY` | Builder API key |
| `POLY_BUILDER_API_SECRET` | Builder API secret |
| `POLY_BUILDER_API_PASSPHRASE` | Builder API passphrase |

### Relayer Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `RELAYER_URL` | Relayer endpoint | `https://relayer-v2.polymarket.com/` |
| `RELAYER_TX_TYPE` | Transaction type | `SAFE` |
| `USE_RELAYER_FOR_APPROVALS` | Use relayer for approvals | `true` (when configured) |

### Remote Signer (Legacy)

| Variable | Description |
|----------|-------------|
| `SIGNER_URL` | Remote signer endpoint |
| `SIGNER_AUTH_TOKEN` | Auth token for signer |

### Example
```bash
POLY_BUILDER_API_KEY=your_builder_key
POLY_BUILDER_API_SECRET=your_builder_secret
POLY_BUILDER_API_PASSPHRASE=your_builder_passphrase
USE_RELAYER_FOR_APPROVALS=true
```

---

## ✅ Approvals

### Auto-Approve

| Variable | Description | Default |
|----------|-------------|---------|
| `APPROVALS_AUTO` | Auto-approve on startup | `false` |
| `APPROVAL_MIN_USDC` | Minimum approval target | `1000` |
| `APPROVAL_MAX_UINT` | Approve max uint256 | - |
| `APPROVALS_MAX_RETRY_ATTEMPTS` | Max retry attempts | `3` |
| `TRUST_ONCHAIN_APPROVALS` | Trust on-chain approval checks | `true` |

### Example
```bash
APPROVALS_AUTO=true
APPROVAL_MIN_USDC=1000
APPROVAL_MAX_UINT=true
TRUST_ONCHAIN_APPROVALS=true
```

---

## 🚦 Rate Limiting

### Order Submission

| Variable | Description | Default |
|----------|-------------|---------|
| `ORDER_SUBMIT_MIN_INTERVAL_MS` | Minimum ms between orders | `0` |
| `ORDER_SUBMIT_MAX_PER_HOUR` | Max orders per hour | `100000` |
| `ORDER_SUBMIT_MARKET_COOLDOWN_SECONDS` | Per-market cooldown | `1` |
| `ORDER_DUPLICATE_PREVENTION_SECONDS` | Duplicate prevention window | `300` |

### Cooldowns

| Variable | Description | Default |
|----------|-------------|---------|
| `CLOUDFLARE_COOLDOWN_SECONDS` | Pause after Cloudflare block | `3600` |
| `CLOB_AUTH_COOLDOWN_SECONDS` | Pause after auth failure | `300` |

### Example
```bash
ORDER_SUBMIT_MIN_INTERVAL_MS=5000
ORDER_SUBMIT_MAX_PER_HOUR=60
ORDER_SUBMIT_MARKET_COOLDOWN_SECONDS=60
ORDER_DUPLICATE_PREVENTION_SECONDS=300
```

---

## 📝 Logging & Debugging

### Log Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `LOG_LEVEL` | Logging level | `info` |
| `LOG_FORMAT` | Log format | `json` |
| `LOG_HTTP_DEBUG` | Enable HTTP debug logs | `false` |

### Heartbeat Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `SKIP_LOG_TTL_MS` | Duplicate log suppression | - |
| `MONITOR_HEARTBEAT_MS` | Monitor heartbeat interval | - |
| `TRACKER_HEARTBEAT_MS` | Tracker heartbeat interval | - |

### History Loading

| Variable | Description | Default |
|----------|-------------|---------|
| `LOAD_FULL_TRADE_HISTORY_ON_START` | Load full wallet trade history | `false` |
| `HISTORY_MAX_DAYS` | Max days of history to load | - |
| `HISTORY_MAX_TRADES_PER_TOKEN` | Max trades per token | - |

### Example
```bash
LOG_LEVEL=info
LOG_FORMAT=json
LOAD_FULL_TRADE_HISTORY_ON_START=false
```

---

## 📱 Telegram Notifications

| Variable | Description | Default |
|----------|-------------|---------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather | - |
| `TELEGRAM_CHAT_ID` | Your chat/group ID | - |
| `TELEGRAM_TOPIC_ID` | Topic ID (for forum-style groups) | - |
| `TELEGRAM_NOTIFICATION_NAME` | Custom name in notifications | `Polymarket Alert` |
| `TELEGRAM_PNL_INTERVAL_MINUTES` | P&L update frequency | `60` |
| `TELEGRAM_SILENT` | Send silently (no sound) | `false` |

### Setup Steps
1. Create a bot via @BotFather on Telegram
2. Get your chat ID (use @userinfobot or @getmyid_bot)
3. For group topics, get the topic ID from the URL

### Example
```bash
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
TELEGRAM_CHAT_ID=123456789
TELEGRAM_NOTIFICATION_NAME=My Polymarket Bot
TELEGRAM_PNL_INTERVAL_MINUTES=60
```

---

## 🔒 VPN Configuration

### OpenVPN

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENVPN_ENABLED` | Enable OpenVPN | `false` |
| `OPENVPN_CONFIG` | Full config contents | - |
| `OPENVPN_CONFIG_PATH` | Config file path | `/etc/openvpn/openvpn.conf` |
| `OPENVPN_AUTH_PATH` | Auth file path | `/etc/openvpn/auth.txt` |
| `OPENVPN_USERNAME` | VPN username | - |
| `OPENVPN_PASSWORD` | VPN password | - |
| `OPENVPN_EXTRA_ARGS` | Extra args for openvpn | - |

### WireGuard

| Variable | Description | Default |
|----------|-------------|---------|
| `WIREGUARD_ENABLED` | Enable WireGuard | `false` |
| `WIREGUARD_INTERFACE_NAME` | Interface name | `wg0` |
| `WIREGUARD_CONFIG_PATH` | Config path | `/etc/wireguard/wg0.conf` |
| `WIREGUARD_CONFIG` | Full config contents | - |
| `WIREGUARD_ADDRESS` | Interface address | - |
| `WIREGUARD_PRIVATE_KEY` | Interface private key | - |
| `WIREGUARD_MTU` | MTU (optional) | - |
| `WIREGUARD_DNS` | DNS servers | - |
| `WIREGUARD_PEER_PUBLIC_KEY` | Peer public key | - |
| `WIREGUARD_PEER_PRESHARED_KEY` | Peer preshared key | - |
| `WIREGUARD_PEER_ENDPOINT` | Peer endpoint (host:port) | - |
| `WIREGUARD_ALLOWED_IPS` | Allowed IP ranges | - |
| `WIREGUARD_PERSISTENT_KEEPALIVE` | Keepalive interval | - |
| `WIREGUARD_FORCE_RESTART` | Force restart on start | `false` |

> **Note**: OpenVPN and WireGuard are mutually exclusive. If both enabled, OpenVPN takes priority.

---

## 📜 Contract Addresses

All contracts have official defaults but can be overridden if needed.

| Variable | Description | Default |
|----------|-------------|---------|
| `COLLATERAL_TOKEN_ADDRESS` | USDC.e on Polygon | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |
| `COLLATERAL_TOKEN_DECIMALS` | Token decimals | `6` |
| `POLY_USDCE_ADDRESS` | USDC.e address | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |
| `POLY_CTF_ADDRESS` | CTF ERC1155 contract | `0x4d97dcd97ec945f40cf65f87097ace5ea0476045` |
| `POLY_CTF_EXCHANGE_ADDRESS` | CTF Exchange | `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E` |
| `POLY_NEG_RISK_CTF_EXCHANGE_ADDRESS` | Neg-Risk CTF Exchange | `0xC5d563A36AE78145C45a50134d48A1215220f80a` |
| `POLY_NEG_RISK_ADAPTER_ADDRESS` | Neg-Risk Adapter | `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296` |

---

## 🔧 Advanced/Debug Options

### Debug Flags

| Variable | Description | Default |
|----------|-------------|---------|
| `DEBUG` | Enable debug mode | - |
| `DEBUG_HMAC_SIGNING` | Debug HMAC signatures | `false` |
| `ENABLE_HMAC_DIAGNOSTICS` | Enable HMAC diagnostics | `false` |
| `DEBUG_HTTP_HEADERS` | Debug HTTP headers | - |
| `DEBUG_AUTH_PROBE` | Debug auth probe | - |
| `CLOB_DEBUG_CANON` | Debug canonicalization | `false` |

### Skip/Bypass Flags

| Variable | Description | Default |
|----------|-------------|---------|
| `ALLOW_TRADING_WITHOUT_PREFLIGHT` | Skip preflight checks | `false` |
| `SKIP_GEOBLOCK_CHECK` | Skip geo restriction check | `false` |
| `ARB_ALLOW_UNSAFE_OVERRIDES` | Allow unsafe preset overrides | `false` |

### API Endpoints

| Variable | Description | Default |
|----------|-------------|---------|
| `CLOB_HOST` | CLOB API host | `https://clob.polymarket.com` |
| `CHAIN_ID` | Chain ID | `137` (Polygon) |

### Miscellaneous

| Variable | Description | Default |
|----------|-------------|---------|
| `ARB_STATE_DIR` | State directory | `/data` |
| `ARB_SNAPSHOT_STATE` | Enable state snapshots | `true` |
| `ARB_UNITS_AUTO_FIX` | Auto-fix unit issues | `true` |
| `ARB_LOG_EVERY_MARKET` | Log every market scan | `false` |
| `ARB_DEBUG_TOP_N` | Log top N candidates | `0` |
| `RUN_ID` | Run identifier | Auto-generated |
| `CLOB_404_SUMMARY_INTERVAL_SEC` | 404 summary interval | - |

---

## 📋 Complete Example .env

```bash
# ============================================================================
# MINIMAL REQUIRED
# ============================================================================
PRIVATE_KEY=your_64_char_hex_private_key
RPC_URL=https://polygon-mainnet.infura.io/v3/YOUR_PROJECT_ID

# ============================================================================
# TRADING (Choose presets or customize)
# ============================================================================
ARB_LIVE_TRADING=I_UNDERSTAND_THE_RISKS
STRATEGY_PRESET=balanced
MODE=both

# ============================================================================
# OPTIONAL - Copy Trading Targets
# ============================================================================
# Leave empty to auto-fetch from leaderboard
# TARGET_ADDRESSES=0xabc...,0xdef...
LEADERBOARD_LIMIT=20

# ============================================================================
# OPTIONAL - Notifications
# ============================================================================
# TELEGRAM_BOT_TOKEN=your_bot_token
# TELEGRAM_CHAT_ID=your_chat_id

# ============================================================================
# OPTIONAL - Gas Settings
# ============================================================================
# POLY_GAS_MULTIPLIER=1.2
# POLY_MAX_FEE_GWEI_CAP=200

# ============================================================================
# OPTIONAL - Builder Credentials (for gasless approvals)
# ============================================================================
# POLY_BUILDER_API_KEY=your_builder_key
# POLY_BUILDER_API_SECRET=your_builder_secret
# POLY_BUILDER_API_PASSPHRASE=your_builder_passphrase
```

---

## 🔗 Related Documentation

- [README.md](../README.md) - Main documentation
- [GUIDE.md](./GUIDE.md) - Complete setup guide
- [CREDENTIALS_EXPLAINED.md](./CREDENTIALS_EXPLAINED.md) - CLOB vs Builder credentials
- [AUTH_TROUBLESHOOTING.md](./AUTH_TROUBLESHOOTING.md) - Authentication issues
- [PREFLIGHT_SEVERITY_GUIDE.md](./PREFLIGHT_SEVERITY_GUIDE.md) - Preflight error handling
