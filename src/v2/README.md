# Polymarket Trading Bot V2

Simple, efficient trading bot with preset-based configuration.

## Quick Start

```bash
# Minimum config
PRIVATE_KEY=0x... RPC_URL=https://polygon-rpc.com npm run start:v2

# With preset
PRESET=aggressive PRIVATE_KEY=0x... RPC_URL=https://polygon-rpc.com npm run start:v2
```

## Environment Variables

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `PRIVATE_KEY` | Wallet private key (with 0x) | `0xabc123...` |
| `RPC_URL` | Polygon RPC endpoint | `https://polygon-rpc.com` |

### Preset Selection

| Variable | Values | Default | Description |
|----------|--------|---------|-------------|
| `PRESET` | `conservative`, `balanced`, `aggressive` | `balanced` | Strategy parameter preset |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `INTERVAL_MS` | `5000` | Cycle interval in milliseconds |
| `TELEGRAM_TOKEN` | - | Telegram bot token for alerts |
| `TELEGRAM_CHAT` | - | Telegram chat ID for alerts |

---

## Strategy Configuration

All strategies can be enabled/disabled and fine-tuned via ENV variables.
If not set, values come from the selected preset.

### AutoSell - Sell positions near $1

Frees up capital from positions that are nearly resolved.

| Variable | Conservative | Balanced | Aggressive | Description |
|----------|--------------|----------|------------|-------------|
| `AUTO_SELL_ENABLED` | true | true | true | Enable/disable |
| `AUTO_SELL_THRESHOLD` | 0.98 | 0.99 | 0.995 | Price to trigger sell (0-1) |

### StopLoss - Prevent catastrophic losses

Sells positions when loss exceeds threshold.

| Variable | Conservative | Balanced | Aggressive | Description |
|----------|--------------|----------|------------|-------------|
| `STOP_LOSS_ENABLED` | true | true | true | Enable/disable |
| `STOP_LOSS_PCT` | 20 | 25 | 35 | Max loss % before sell |

### Hedge - Protect losing positions

Buys opposite outcome to lock in value on moderate losses.

| Variable | Conservative | Balanced | Aggressive | Description |
|----------|--------------|----------|------------|-------------|
| `HEDGE_ENABLED` | true | true | true | Enable/disable |
| `HEDGE_TRIGGER_PCT` | 15 | 20 | 25 | Loss % to trigger hedge |
| `HEDGE_MAX_USD` | 15 | 25 | 50 | Max USD per hedge |

### Scalp - Take profits

Sells winning positions to lock in gains.

| Variable | Conservative | Balanced | Aggressive | Description |
|----------|--------------|----------|------------|-------------|
| `SCALP_ENABLED` | true | true | true | Enable/disable |
| `SCALP_MIN_PROFIT_PCT` | 15 | 10 | 5 | Min profit % to take |
| `SCALP_MIN_GAIN_CENTS` | 8 | 5 | 3 | Min gain in cents |

### Stack - Double down on winners

Buys more of positions that are winning (once per position).

| Variable | Conservative | Balanced | Aggressive | Description |
|----------|--------------|----------|------------|-------------|
| `STACK_ENABLED` | true | true | true | Enable/disable |
| `STACK_MIN_GAIN_CENTS` | 25 | 20 | 15 | Min gain to trigger |
| `STACK_MAX_USD` | 15 | 25 | 50 | USD amount per stack |
| `STACK_MAX_PRICE` | 0.90 | 0.95 | 0.97 | Max price to stack at |

### Endgame - Buy high-confidence positions

Adds to positions near resolution (high probability of paying $1).

| Variable | Conservative | Balanced | Aggressive | Description |
|----------|--------------|----------|------------|-------------|
| `ENDGAME_ENABLED` | true | true | true | Enable/disable |
| `ENDGAME_MIN_PRICE` | 0.90 | 0.85 | 0.80 | Min price for endgame |
| `ENDGAME_MAX_PRICE` | 0.98 | 0.99 | 0.995 | Max price for endgame |
| `ENDGAME_MAX_USD` | 15 | 25 | 50 | Max USD per buy |

### Redeem - Claim resolved positions

Automatically redeems resolved markets for USDC.

| Variable | Conservative | Balanced | Aggressive | Description |
|----------|--------------|----------|------------|-------------|
| `REDEEM_ENABLED` | true | true | true | Enable/disable |
| `REDEEM_INTERVAL_MIN` | 15 | 15 | 10 | Minutes between checks |

---

## Preset Comparison

| Setting | Conservative | Balanced | Aggressive |
|---------|--------------|----------|------------|
| **Risk Level** | Low | Medium | High |
| **Position Sizes** | $15 | $25 | $50 |
| **Stop Loss** | -20% | -25% | -35% |
| **Take Profit** | +15% | +10% | +5% |
| **Best For** | Capital preservation | General trading | Maximum growth |

---

## Examples

### Conservative trader (protect capital)
```bash
PRESET=conservative \
PRIVATE_KEY=0x... \
RPC_URL=https://polygon-rpc.com \
npm run start:v2
```

### Aggressive with custom stop loss
```bash
PRESET=aggressive \
STOP_LOSS_PCT=40 \
PRIVATE_KEY=0x... \
RPC_URL=https://polygon-rpc.com \
npm run start:v2
```

### Balanced with Telegram alerts
```bash
PRESET=balanced \
TELEGRAM_TOKEN=123456:ABC... \
TELEGRAM_CHAT=-100123456 \
PRIVATE_KEY=0x... \
RPC_URL=https://polygon-rpc.com \
npm run start:v2
```

### Disable specific strategies
```bash
PRESET=balanced \
HEDGE_ENABLED=false \
ENDGAME_ENABLED=false \
PRIVATE_KEY=0x... \
RPC_URL=https://polygon-rpc.com \
npm run start:v2
```

### Custom configuration (no preset base)
```bash
PRESET=balanced \
AUTO_SELL_THRESHOLD=0.985 \
STOP_LOSS_PCT=30 \
HEDGE_TRIGGER_PCT=18 \
HEDGE_MAX_USD=30 \
SCALP_MIN_PROFIT_PCT=12 \
STACK_MIN_GAIN_CENTS=22 \
STACK_MAX_USD=30 \
PRIVATE_KEY=0x... \
RPC_URL=https://polygon-rpc.com \
npm run start:v2
```

---

## Strategy Priority Order

Strategies run in this order each cycle:

1. **AutoSell** - Free capital from near-$1 positions
2. **StopLoss** - Protect from catastrophic losses  
3. **Hedge** - Protect from moderate losses
4. **Scalp** - Take profits on winners
5. **Stack** - Double down on winners
6. **Endgame** - Buy high-confidence positions
7. **Redeem** - Claim resolved positions (runs on separate interval)

---

## Switching Between V1 and V2

```bash
# Run V2 (new simple system)
USE_V2=true npm start
# or
npm run start:v2

# Run V1 (legacy system)
USE_V2=false npm start
# or  
npm run start:v1
```

---

## VPN Bypass

If running behind a VPN, RPC calls can be routed outside the tunnel:

| Variable | Default | Description |
|----------|---------|-------------|
| `VPN_BYPASS_RPC` | `true` | Route RPC calls outside VPN tunnel |

Set `VPN_BYPASS_RPC=false` if your RPC provider requires VPN routing.

The VPN bypass logic is in `src/utils/vpn-rpc-bypass.util.ts`.

---

## Address Monitoring (Copy Trading)

Monitor other traders and copy their moves:

| Variable | Description |
|----------|-------------|
| `MONITOR_ADDRESSES` | Comma-separated addresses to monitor |

```bash
MONITOR_ADDRESSES=0xabc...,0xdef... npm run start:v2
```

The monitor checks for new trades from watched addresses and can trigger copy trades.

---

## Additional Strategies

### Arbitrage - Guaranteed profit when YES + NO < $1

| Variable | Conservative | Balanced | Aggressive | Description |
|----------|--------------|----------|------------|-------------|
| `ARB_ENABLED` | true | true | true | Enable/disable |
| `ARB_MAX_USD` | 15 | 25 | 50 | Max USD per arbitrage |

### Sell Signal Protection

When a tracked trader SELLS a position you hold and you're losing:
- Loss > 40%: Stop loss (sell immediately)
- Loss 15-40%: Hedge (buy opposite side)
- Profitable: Ignore (hold your winner)

This is automatic when `COPY_ADDRESSES` is set.
