# Polymarket Bot

A trading bot for Polymarket prediction markets with advanced risk management, whale tracking, and automated position management.

## Features

- **Whale Tracking**: Monitor top 100 leaderboard wallets via on-chain events
- **Risk Guard**: Financial bleed protection with portfolio-wide safeguards
- **Smart Sell**: Intelligent order execution with slippage protection
- **Dynamic Reserves**: Self-balancing capital management
- **Market Scanner**: Automated opportunity detection across active markets
- **Real-time Data**: WebSocket-based market data with REST fallback

## Quick Start

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# Edit .env with your PRIVATE_KEY and RPC_URL

# 3. Run
npm start
```

## Development

```bash
# Type checking
npm run typecheck

# Linting
npm run lint

# Run all tests
npm test

# Run unit tests only
npm run test:unit

# Run integration tests only
npm run test:integration
```

### Project Structure

```
├── src/                  # Source code
│   ├── config/          # Configuration schemas
│   ├── core/            # Core trading logic
│   │   ├── decision-engine.ts    # Entry/exit decision making
│   │   ├── execution-engine.ts   # Order execution
│   │   ├── position-manager.ts   # Position lifecycle
│   │   ├── risk-guard.ts         # Financial bleed protection
│   │   ├── smart-sell.ts         # Intelligent sell execution
│   │   └── ...
│   ├── infra/           # Infrastructure (logging, monitoring)
│   ├── lib/             # Utility libraries
│   ├── models/          # Data models
│   ├── services/        # External services
│   └── start.ts         # Entry point
├── tests/
│   ├── unit/            # Unit tests
│   └── integration/     # Integration tests
├── docs/                # Documentation
└── scripts/             # Utility scripts
```

## Environment Variables

All configuration is done through environment variables. See `.env.example` for the complete template.

### Required

| Variable | Description |
|----------|-------------|
| `PRIVATE_KEY` | Your wallet private key (with 0x prefix) |

### Core Trading

| Variable | Default | Description |
|----------|---------|-------------|
| `RPC_URL` | `https://polygon-rpc.com` | Polygon RPC endpoint. Infura recommended: `https://polygon-mainnet.infura.io/v3/YOUR_API_KEY` |
| `MAX_TRADE_USD` | `25` | Maximum trade size in USD |
| `LIVE_TRADING` | (disabled) | Set to `I_UNDERSTAND_THE_RISKS` to enable real trades |

### Entry Price Bounds

| Variable | Default | Description |
|----------|---------|-------------|
| `MIN_ENTRY_PRICE_CENTS` | `30` | Minimum entry price (30¢) |
| `MAX_ENTRY_PRICE_CENTS` | `82` | Maximum entry price (82¢) |
| `PREFERRED_ENTRY_LOW_CENTS` | `35` | Preferred zone lower bound (35¢) |
| `PREFERRED_ENTRY_HIGH_CENTS` | `65` | Preferred zone upper bound (65¢) |
| `MIN_SPREAD_CENTS` | `6` | Maximum acceptable spread |
| `MIN_DEPTH_USD_AT_EXIT` | `25` | Minimum liquidity depth required |

### Whale Detection

| Variable | Default | Description |
|----------|---------|-------------|
| `WHALE_TRADE_USD` | `100` | Minimum trade size to detect as whale trade |
| `WHALE_PRICE_MIN` | `0.35` | Minimum price for whale trades (35¢) |
| `WHALE_PRICE_MAX` | `0.65` | Maximum price for whale trades (65¢) |
| `COPY_ANY_WHALE_BUY` | `true` | Copy any whale buy immediately (vs. waiting for bias) |

### Bias Thresholds (Conservative Mode)

These only apply when `COPY_ANY_WHALE_BUY=false`:

| Variable | Default | Description |
|----------|---------|-------------|
| `BIAS_MIN_NET_USD` | `300` | Minimum net whale flow required |
| `BIAS_MIN_TRADES` | `3` | Minimum whale trades required |
| `BIAS_STALE_SECONDS` | `900` | Bias expiration (15 minutes) |

### Market Scanner

| Variable | Default | Description |
|----------|---------|-------------|
| `SCAN_ACTIVE_MARKETS` | `true` | Enable market scanning |
| `SCAN_MIN_VOLUME_USD` | `10000` | Minimum 24h volume ($10k) |
| `SCAN_TOP_N_MARKETS` | `20` | Number of top markets to scan |
| `SCAN_INTERVAL_SECONDS` | `300` | Scan refresh interval (5 min) |

### Dynamic Reserves

| Variable | Default | Description |
|----------|---------|-------------|
| `DYNAMIC_RESERVES_ENABLED` | `true` | Enable dynamic reserve management |
| `RESERVE_ADAPTATION_RATE` | `0.1` | Adaptation rate (10%) |
| `MISSED_OPPORTUNITY_WEIGHT` | `0.5` | Weight for missed trades |
| `HEDGE_COVERAGE_WEIGHT` | `0.5` | Weight for hedge needs |
| `MAX_RESERVE_FRACTION` | `0.5` | Maximum reserve fraction (50%) |

### On-Chain Monitoring

| Variable | Default | Description |
|----------|---------|-------------|
| `ONCHAIN_MONITOR_ENABLED` | `true` | Enable on-chain monitoring |
| `INFURA_TIER` | `core` | Infura plan: `core`, `developer`, `team`, `growth` |
| `BALANCE_REFRESH_INTERVAL_MS` | `10000` | Balance cache refresh (10s) |

### Liquidation Mode

| Variable | Default | Description |
|----------|---------|-------------|
| `LIQUIDATION_MODE` | `off` | Mode: `off`, `losing`, `all` |
| `LIQUIDATION_MAX_SLIPPAGE_PCT` | `10` | Max slippage for liquidation sells |
| `LIQUIDATION_POLL_INTERVAL_MS` | `1000` | Poll interval during liquidation |

### POL Gas Reserve

| Variable | Default | Description |
|----------|---------|-------------|
| `POL_RESERVE_TARGET` | `50` | Target POL balance when refilling |
| `POL_RESERVE_MIN` | `0.5` | Trigger threshold for refill |
| `POL_RESERVE_MAX_SWAP_USD` | `10` | Max USDC per swap |
| `POL_RESERVE_CHECK_INTERVAL_MIN` | `5` | Check interval (minutes) |

### Order Types

| Variable | Default | Description |
|----------|---------|-------------|
| `ORDER_TYPE` | `FOK` | Master order type: `FOK` or `GTC` |
| `BUY_ORDER_TYPE` | (uses ORDER_TYPE) | Buy-specific order type |
| `SELL_ORDER_TYPE` | (uses ORDER_TYPE) | Sell-specific order type |
| `BUY_GTC_EXPIRATION_SECONDS` | `3600` | GTC buy expiration (1 hour) |
| `SELL_GTC_EXPIRATION_SECONDS` | `86400` | GTC sell expiration (24 hours) |
| `BUY_DEFAULT_SLIPPAGE_PCT` | `2` | Default buy slippage |
| `BUY_MAX_SLIPPAGE_PCT` | `5` | Maximum buy slippage |

### WebSocket Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `WS_RECONNECT_BASE_MS` | `1000` | Initial reconnect delay |
| `WS_RECONNECT_MAX_MS` | `30000` | Maximum reconnect delay |
| `WS_STABLE_CONNECTION_MS` | `15000` | Stable connection threshold |
| `WS_STALE_MS` | `2000` | Data staleness threshold |
| `WS_PING_INTERVAL_MS` | `10000` | Keepalive ping interval |
| `WS_CONNECTION_TIMEOUT_MS` | `10000` | Connection timeout |

### Notifications

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Telegram bot token for notifications |
| `TELEGRAM_CHAT_ID` | Telegram chat ID for notifications |

### Error Reporting

| Variable | Description |
|----------|-------------|
| `GITHUB_ERROR_REPORTER_ENABLED` | Enable GitHub issue reporting |
| `GITHUB_ERROR_REPORTER_TOKEN` | GitHub Personal Access Token |
| `GITHUB_ERROR_REPORTER_REPO` | Repository for error issues |

### Diagnostic Mode

| Variable | Default | Description |
|----------|---------|-------------|
| `DIAG_MODE` | `false` | Enable diagnostic workflow |
| `DIAG_WHALE_TIMEOUT_SEC` | `60` | Timeout for whale signal |
| `DIAG_ORDER_TIMEOUT_SEC` | `30` | Timeout for order execution |
| `DIAG_FORCE_SHARES` | `1` | Force shares per order |

### Debug & Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `DEBUG` | `false` | Enable verbose debug logging |
| `LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |

### VPN Configuration

For geo-blocked regions only:

| Variable | Description |
|----------|-------------|
| `WG_CONFIG` | WireGuard config file path |
| `OVPN_CONFIG` | OpenVPN config file path |

## Risk Management

The bot includes multiple layers of risk protection:

### RiskGuard Module

The `RiskGuard` module provides portfolio-wide protection against financial bleed:

- **Entry Validation**: Prevents wallet depletion and over-deployment
- **Hedge Validation**: Limits reverse hedging to prevent cascading losses
- **Portfolio Health Monitoring**: Tracks global exposure and position health
- **Protective Mode**: Automatically blocks entries during portfolio stress

Key safeguards:
- Maximum 70% capital deployment
- Maximum 50% global hedge exposure
- Minimum $50 wallet balance maintained
- Maximum 5 hedged positions simultaneously
- Maximum $200 total hedge capital
- 30-second cooldown between hedges on same position

### Position Limits

- 12 maximum concurrent positions
- 1 position per token (hedges stored inside position)
- 30% maximum total exposure
- 3-minute cooldown between trades on same token

### Exit Triggers

- Take profit at +14¢
- Hedge trigger at -16¢
- Hard stop at -30¢
- Time stop at 1 hour

### API Rate Monitoring

The `ApiRateMonitor` module tracks all API calls and automatically alerts when:

- **Rate limits approached**: Warns at 70% of limit, critical at 90%
- **Consecutive failures**: Detects patterns of missed buys/sells/hedges
- **Daily limits**: Tracks usage against daily API quotas

When issues are detected, the system:
1. Logs warnings to console
2. Automatically creates GitHub issues (if reporter is configured)
3. Provides real-time usage statistics

Limits are automatically adjusted based on your `INFURA_TIER` setting.

## Infura RPC

Get your API key at [infura.io](https://infura.io). Infura handles blockchain operations (balance checks, transactions).

**Tier Comparison** (approximate):
| Tier | Credits/Day | Cost |
|------|-------------|------|
| Core (Free) | 3,000,000 | Free |
| Developer | 15,000,000 | $50/mo |
| Team | 75,000,000 | $225/mo |
| Growth | 200,000,000+ | Enterprise |

## VPN (Geo-blocked regions only)

Infura RPC calls never require a VPN, but Polymarket APIs can be geo-blocked in certain regions. Configure WireGuard or OpenVPN in `.env` if needed.

## How It Works

The bot tracks the top 100 whale wallets from the Polymarket leaderboard and trades based on their activity. All trading parameters are fixed based on EV math - you only configure your bet size.

For a comprehensive understanding of the order system, including whale tracking, position management, price protection, and all trading mechanisms, see the **[Order System Documentation](docs/ORDER_SYSTEM.md)**.

## License

Apache-2.0
