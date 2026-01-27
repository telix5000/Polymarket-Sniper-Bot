# Polymarket Sniper Bot

A trading bot for Polymarket that follows whale wallets.

## Quick Start

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# Edit .env with your PRIVATE_KEY

# 3. Run
npm start
```

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `PRIVATE_KEY` | Yes | Your wallet private key (with 0x prefix) |
| `RPC_URL` | No | Polygon RPC endpoint (default: `https://polygon-rpc.com`) |
| `MAX_TRADE_USD` | No | Bet size in USD (default: `25`) |
| `LIVE_TRADING` | No | Set to `I_UNDERSTAND_THE_RISKS` to enable real trades (default: simulation) |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot token for notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat ID for notifications |

## How It Works

The bot tracks the top 100 whale wallets from the Polymarket leaderboard and trades based on their activity. All trading parameters are fixed based on EV math - you only configure your bet size.

## License

Apache-2.0
