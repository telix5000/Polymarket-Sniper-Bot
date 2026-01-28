# Polymarket Bot

A trading bot for Polymarket prediction markets.

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
│   ├── config/          # Configuration
│   ├── core/            # Core trading logic
│   ├── infra/           # Infrastructure
│   ├── lib/             # Libraries
│   ├── models/          # Data models
│   ├── services/        # Services
│   └── start.ts         # Entry point
├── tests/
│   ├── unit/            # Unit tests
│   │   └── lib/         # Library unit tests
│   └── integration/     # Integration tests
├── docs/                # Documentation
└── scripts/             # Utility scripts
```

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `PRIVATE_KEY` | Yes | Your wallet private key (with 0x prefix) |
| `RPC_URL` | No | Polygon RPC endpoint (default: `https://polygon-rpc.com`). Infura recommended: `https://polygon-mainnet.infura.io/v3/YOUR_API_KEY` |
| `MAX_TRADE_USD` | No | Bet size in USD (default: `25`) |
| `LIVE_TRADING` | No | Set to `I_UNDERSTAND_THE_RISKS` to enable real trades (default: simulation) |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot token for notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat ID for notifications |

## Infura RPC

Get your API key at [infura.io](https://infura.io). Infura handles blockchain operations (balance checks, transactions) - goes direct, no VPN needed.

**Current usage**: Balance checks + transaction submissions (low usage compared to paid tier capacity)

**Example pricing tiers** (see [infura.io/pricing](https://infura.io/pricing) for up-to-date details; values below are approximate and may change):
- **Free**: ~3M credits/day
- **Developer** ($50/mo): ~15M credits/day  
- **Team** ($225/mo): ~75M credits/day

> Whale tracking uses Polymarket's API, not Infura. The paid tier has capacity for future enhancements like on-chain event monitoring.

## VPN (Geo-blocked regions only)

Infura RPC calls never require a VPN, but Polymarket APIs can be geo-blocked. A VPN is required for order submissions to Polymarket in geo-blocked regions and may also be needed for certain data-api requests (used for whale tracking) depending on your location. If you're in a geo-blocked region, configure WireGuard or OpenVPN in `.env`.

## How It Works

The bot tracks the top 100 whale wallets from the Polymarket leaderboard and trades based on their activity. All trading parameters are fixed based on EV math - you only configure your bet size.

For a comprehensive understanding of the order system, including whale tracking, position management, price protection, and all trading mechanisms, see the **[Order System Documentation](docs/ORDER_SYSTEM.md)**.

## License

Apache-2.0
