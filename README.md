# Polymarket Sniper Bot

A trading bot for Polymarket that follows whale wallets.

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

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `PRIVATE_KEY` | Yes | Your wallet private key (with 0x prefix) |
| `RPC_URL` | Yes | Infura Polygon endpoint: `https://polygon-mainnet.infura.io/v3/YOUR_API_KEY` |
| `MAX_TRADE_USD` | No | Bet size in USD (default: `25`) |
| `LIVE_TRADING` | No | Set to `I_UNDERSTAND_THE_RISKS` to enable real trades (default: simulation) |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot token for notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat ID for notifications |

## Infura RPC

Get your API key at [infura.io](https://infura.io). Infura handles blockchain operations (balance checks, transactions) - goes direct, no VPN needed.

**Current usage**: Balance checks + transaction submissions (~1% of paid tier capacity)

**Pricing tiers** (check [infura.io/pricing](https://infura.io/pricing) for current rates):
- **Free**: ~3M credits/day
- **Developer** ($50/mo): ~15M credits/day  
- **Team** ($225/mo): ~75M credits/day

> Whale tracking uses Polymarket's API, not Infura. The paid tier has capacity for future enhancements like on-chain event monitoring.

## VPN (Geo-blocked regions only)

VPN is only needed for Polymarket API requests (order submissions), not for Infura RPC. If you're in a geo-blocked region, configure WireGuard or OpenVPN in `.env`.

## How It Works

The bot tracks the top 100 whale wallets from the Polymarket leaderboard and trades based on their activity. All trading parameters are fixed based on EV math - you only configure your bet size.

## License

Apache-2.0
