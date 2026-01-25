# Getting Started with Polymarket Sniper Bot

## Complete Setup Guide for Beginners

This guide walks you through **everything** you need to do to get the Polymarket Sniper Bot running, from scratch. No prior experience required.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Step 1: Install MetaMask](#step-1-install-metamask)
- [Step 2: Create or Import a Wallet](#step-2-create-or-import-a-wallet)
- [Step 3: Get Your Private Key](#step-3-get-your-private-key)
- [Step 4: Add Polygon Network to MetaMask](#step-4-add-polygon-network-to-metamask)
- [Step 5: Get an RPC URL](#step-5-get-an-rpc-url)
- [Step 6: Fund Your Wallet](#step-6-fund-your-wallet)
- [Step 7: Make Your First Trade on Polymarket](#step-7-make-your-first-trade-on-polymarket)
- [Step 8: Install and Configure the Bot](#step-8-install-and-configure-the-bot)
- [Step 9: Run the Bot](#step-9-run-the-bot)
- [Troubleshooting](#troubleshooting)
- [Security Best Practices](#security-best-practices)

---

## Prerequisites

Before starting, you'll need:

- A computer with internet access
- Node.js 18 or higher installed ([download here](https://nodejs.org/))
- Git installed ([download here](https://git-scm.com/))
- A web browser (Chrome, Firefox, or Brave recommended)
- $50-500+ in cryptocurrency to trade with

---

## Step 1: Install MetaMask

MetaMask is a cryptocurrency wallet that runs in your browser. It's how you'll manage your funds.

### Option A: Browser Extension (Recommended)

1. Go to [metamask.io](https://metamask.io/download/)
2. Click **Download** and select your browser (Chrome, Firefox, Brave, Edge)
3. Click **Add to [Browser]** to install the extension
4. A fox icon will appear in your browser toolbar

### Option B: Mobile App

1. Download MetaMask from the [App Store](https://apps.apple.com/app/metamask/id1438144202) (iOS) or [Google Play](https://play.google.com/store/apps/details?id=io.metamask) (Android)
2. Follow the in-app setup instructions

> **Note:** For running the bot, you'll need the browser extension. The mobile app is useful for managing funds on the go.

---

## Step 2: Create or Import a Wallet

### Creating a New Wallet (Recommended for New Users)

1. Click the MetaMask fox icon in your browser
2. Click **Get Started**
3. Click **Create a Wallet**
4. Create a strong password (write it down!)
5. **CRITICAL:** Write down your 12-word Secret Recovery Phrase on paper
   - Store it in a safe place (fireproof safe, safety deposit box)
   - NEVER share it with anyone
   - NEVER store it digitally (no screenshots, no cloud storage)
6. Confirm your Secret Recovery Phrase by clicking the words in order
7. Your wallet is now created!

### Importing an Existing Wallet

If you already have a wallet (from another device or from Polymarket):

1. Click the MetaMask fox icon
2. Click **Get Started**
3. Click **Import Wallet**
4. Enter your 12-word Secret Recovery Phrase
5. Create a password
6. Your wallet is now imported!

---

## Step 3: Get Your Private Key

The bot needs your wallet's **private key** to sign transactions automatically. This is different from your Secret Recovery Phrase.

### How to Export Your Private Key

1. Click the MetaMask fox icon in your browser
2. Click the **three dots (⋮)** in the top right
3. Click **Account Details**
4. Click **Show Private Key** (or the key icon)
5. Enter your MetaMask password to confirm
6. Your private key will be displayed (starts with `0x` followed by 64 characters)

### ⚠️ CRITICAL SECURITY WARNING ⚠️

- **NEVER share your private key with anyone**
- **NEVER paste it into websites** (except your own `.env` file)
- **NEVER send it in chat, email, or social media**
- Anyone with your private key can steal ALL your funds
- The bot only needs this key locally - it never sends it anywhere

### Copy Your Private Key Safely

1. Click the copy icon next to the private key
2. Paste it ONLY into your `.env` file (we'll create this in Step 8)
3. Do NOT save it in a text file, notes app, or cloud storage

---

## Step 4: Add Polygon Network to MetaMask

Polymarket runs on the **Polygon network** (not Ethereum mainnet). You need to add this network to MetaMask.

### Automatic Method (Easiest)

1. Go to [chainlist.org](https://chainlist.org/)
2. Search for **"Polygon Mainnet"** or **"Polygon PoS"**
3. Click **Connect Wallet** (if prompted)
4. Click **Add to MetaMask** for Polygon Mainnet (Chain ID: 137)
5. Approve the network addition in MetaMask

### Manual Method

1. Click the MetaMask fox icon
2. Click the network dropdown at the top (usually says "Ethereum Mainnet")
3. Click **Add Network** or **Add a network manually**
4. Enter these details:

| Field | Value |
|-------|-------|
| Network Name | Polygon Mainnet |
| New RPC URL | https://polygon-rpc.com (temporary, we'll get a better one in Step 5) |
| Chain ID | 137 |
| Currency Symbol | POL (or MATIC) |
| Block Explorer URL | https://polygonscan.com |

5. Click **Save**
6. Switch to **Polygon Mainnet** in the network dropdown

---

## Step 5: Get an RPC URL

An **RPC URL** is how the bot connects to the Polygon blockchain. Free public RPCs work, but can be slow or rate-limited. For best performance, get your own.

### Option A: MetaMask Developer Tools (Free Tier)

MetaMask offers Infura-powered RPC endpoints through their developer portal:

1. Go to [developer.metamask.io](https://developer.metamask.io/)
2. Click **Sign Up** or **Get Started**
3. Create a free account (email + password)
4. After signing in, go to the **Dashboard**
5. Click **Create New Project** or find your default project
6. Look for your **API Key** or **Project ID**
7. Your RPC URL will be: `https://polygon-mainnet.infura.io/v3/YOUR_PROJECT_ID`
8. Copy this URL for your `.env` file

### Option B: Infura (Free Tier - 100k requests/day)

1. Go to [infura.io](https://infura.io/)
2. Click **Sign Up** (free account)
3. Create a new project (name it anything, like "Polymarket Bot")
4. Under **ENDPOINTS**, select **Polygon PoS**
5. Copy the HTTPS URL (looks like `https://polygon-mainnet.infura.io/v3/abc123...`)
6. Save this URL for your `.env` file

### Option C: Alchemy (Free Tier - 300M compute units/month)

1. Go to [alchemy.com](https://www.alchemy.com/)
2. Click **Get started for free**
3. Create an account
4. Create a new app:
   - Name: "Polymarket Bot"
   - Chain: Polygon PoS
   - Network: Polygon Mainnet
5. Click on your app, then **View Key**
6. Copy the HTTPS URL
7. Save this URL for your `.env` file

### Option D: QuickNode (Free Tier)

1. Go to [quicknode.com](https://www.quicknode.com/)
2. Sign up for a free account
3. Create an endpoint:
   - Chain: Polygon
   - Network: Mainnet
4. Copy your HTTP provider URL
5. Save this URL for your `.env` file

### Updating MetaMask with Your New RPC

After getting your personal RPC URL:

1. Click the MetaMask fox icon
2. Click the network dropdown → **Polygon Mainnet**
3. Click the **three dots** → **Edit**
4. Replace the RPC URL with your new personal URL
5. Click **Save**

> **Why get a personal RPC?** Free public RPCs are shared by thousands of users and may be slow or rate-limited. Your own RPC URL gives you better performance and reliability.

---

## Step 6: Fund Your Wallet

You need two types of tokens on Polygon:

1. **USDC** (or USDC.e) - For trading on Polymarket
2. **POL** (formerly MATIC) - For paying gas fees

### How Much Do You Need?

| Purpose | Minimum | Recommended |
|---------|---------|-------------|
| USDC for trading | $50 | $200-500+ |
| POL for gas | 0.1 POL (~$0.05) | 1-5 POL (~$0.50-2.50) |

### Option A: Buy on a Centralized Exchange (Easiest)

1. Create an account on [Coinbase](https://coinbase.com), [Kraken](https://kraken.com), or [Binance](https://binance.com)
2. Complete identity verification (KYC)
3. Buy **USDC** and **POL** (or MATIC)
4. Withdraw to your MetaMask wallet address on the **Polygon network**

**Finding your wallet address:**
1. Click the MetaMask fox icon
2. Click on your account name at the top
3. Your address will be copied (starts with `0x...`)

> ⚠️ **IMPORTANT:** When withdrawing, make sure to select **Polygon Network** (not Ethereum). Sending to the wrong network can result in lost funds.

### Option B: Bridge from Ethereum

If you already have USDC/MATIC on Ethereum:

1. Go to [Portal Bridge](https://portalbridge.com/) or [Polygon Bridge](https://wallet.polygon.technology/bridge/)
2. Connect your MetaMask wallet
3. Select:
   - From: Ethereum
   - To: Polygon
   - Token: USDC (or MATIC/POL)
4. Enter the amount and confirm
5. Wait for the bridge to complete (may take 7-30 minutes)

### Option C: Use a DEX Aggregator

1. Go to [1inch.io](https://1inch.io/) or [Matcha.xyz](https://matcha.xyz/)
2. Connect your MetaMask wallet
3. Switch to Polygon network
4. Swap ETH/MATIC for USDC if needed

### Verify Your Funds

After funding:

1. Open MetaMask
2. Switch to **Polygon Mainnet**
3. You should see your POL balance
4. Click **Import Tokens** at the bottom
5. Search for **USDC** or paste the contract address: `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`
6. Add the token to see your balance

---

## Step 7: Make Your First Trade on Polymarket

**This step is REQUIRED!** The Polymarket API cannot create credentials for wallets that have never traded on the platform.

### Why Is This Necessary?

- Polymarket's authentication system requires your wallet to have on-chain trading history
- The bot cannot generate API credentials until you've made at least one trade
- You'll get "Could not create api key" errors if you skip this step

### Making Your First Trade

1. Go to [polymarket.com](https://polymarket.com/)
2. Click **Connect Wallet** (top right)
3. Select **MetaMask** and approve the connection
4. Browse to any market that interests you
5. Click on a market to open it
6. Enter a small amount (even $1 is enough)
7. Click **Buy** or **Sell** to place your order
8. Approve the transaction in MetaMask
9. Wait for the transaction to confirm (1-2 minutes)

### Verification

After your trade confirms:
- You should see your position on Polymarket
- Your wallet is now "known" to Polymarket's API
- The bot will be able to derive API credentials from your private key

> **Tip:** Keep this first trade small ($1-5) since it's just to activate your wallet for API access.

---

## Step 8: Install and Configure the Bot

Now let's get the bot running!

### Clone the Repository

Open a terminal (Command Prompt on Windows, Terminal on Mac/Linux):

```bash
# Clone the repository
git clone https://github.com/telix5000/Polymarket-Sniper-Bot.git

# Enter the directory
cd Polymarket-Sniper-Bot

# Install dependencies
npm install

# Build the project
npm run build
```

### Create Your Configuration File

1. Copy the example environment file:

```bash
# Mac/Linux
cp .env.example .env

# Windows
copy .env.example .env
```

2. Open `.env` in a text editor (VS Code, Notepad++, or any text editor)

3. Fill in the required values:

```env
# REQUIRED: Your wallet's private key from Step 3
PRIVATE_KEY=0xyour_private_key_here_without_quotes

# REQUIRED: Your RPC URL from Step 5
RPC_URL=https://polygon-mainnet.infura.io/v3/your_project_id

# OPTIONAL: Target addresses to copy trade (leave blank to use leaderboard)
# If you know specific wallets to follow, add them here:
# TARGET_ADDRESSES=0xabc...,0xdef...

# OPTIONAL BUT IMPORTANT: Enable live trading
# Without this, the bot runs in dry-run mode (no real trades)
# ARB_LIVE_TRADING=I_UNDERSTAND_THE_RISKS
```

### Minimal Configuration Example

For the simplest setup, you only need two things:

```env
PRIVATE_KEY=0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
RPC_URL=https://polygon-mainnet.infura.io/v3/abc123xyz789
```

That's it! The bot will:
- Automatically derive your CLOB API credentials from your private key
- Fetch top traders from the Polymarket leaderboard to follow
- Run in dry-run mode (no real trades) until you enable live trading

### Enabling Live Trading

When you're ready to trade with real money, add this line to your `.env`:

```env
ARB_LIVE_TRADING=I_UNDERSTAND_THE_RISKS
```

> ⚠️ **Warning:** Only enable this after you've tested the bot in dry-run mode and understand the risks!

---

## Step 9: Run the Bot

### Development Mode (for testing)

```bash
npm run dev
```

This runs the bot with live reloading - useful for testing and debugging.

### Production Mode

```bash
npm run build
npm start
```

This compiles and runs the optimized production version.

### Verifying It Works

When the bot starts, you should see:

```
[Preflight][Summary] ✅ auth_ok=true ready_to_trade=true
```

If you see `auth_ok=false`, check the [Troubleshooting](#troubleshooting) section.

### Using Docker (Optional)

If you prefer Docker:

```bash
# Build the image
docker build -t polymarket-sniper-bot .

# Run with your .env file
docker run --env-file .env polymarket-sniper-bot
```

Or with Docker Compose:

```bash
docker-compose up -d
```

---

## Troubleshooting

### "401 Unauthorized/Invalid api key" Error

**Cause:** The bot can't authenticate with Polymarket.

**Solutions:**
1. Make sure you've made at least one trade on [polymarket.com](https://polymarket.com/) (Step 7)
2. Verify your private key is correct (64 hex characters after `0x`)
3. Check that you're not using Builder API keys (they're different from CLOB keys)

### "Could not create api key" Error

**Cause:** Your wallet has never traded on Polymarket.

**Solution:** Complete [Step 7](#step-7-make-your-first-trade-on-polymarket) - make one trade on the website first.

### "Insufficient funds" Error

**Cause:** Not enough USDC or POL in your wallet.

**Solution:** Add more funds (Step 6). You need both USDC for trading and POL for gas.

### RPC Connection Errors

**Cause:** Your RPC URL is invalid or rate-limited.

**Solutions:**
1. Verify your RPC URL is correct
2. Try a different RPC provider (see Step 5)
3. Check if you've exceeded the free tier limits

### Bot Runs But No Trades

**Cause:** Various reasons.

**Checks:**
1. Verify `ARB_LIVE_TRADING=I_UNDERSTAND_THE_RISKS` is set (if you want real trades)
2. Check that target addresses are actively trading
3. Verify you have sufficient funds
4. Check `MIN_TRADE_SIZE_USD` isn't set too high

### MetaMask Not Connecting

**Cause:** Browser extension issues.

**Solutions:**
1. Make sure MetaMask is unlocked
2. Try refreshing the page
3. Clear browser cache and restart
4. Disable other wallet extensions that might conflict

---

## Security Best Practices

### Protect Your Private Key

- ✅ Store it only in your `.env` file
- ✅ Never share it with anyone
- ✅ Add `.env` to your `.gitignore` (already done)
- ❌ Don't paste it into websites
- ❌ Don't send it via chat, email, or social media
- ❌ Don't store it in cloud services

### Use a Dedicated Trading Wallet

- Create a **separate wallet** just for bot trading
- Only fund it with what you're willing to risk
- Keep your main holdings in a different wallet (or hardware wallet)

### Protect Your Server

If running on a VPS:
- Use strong SSH passwords or key-based authentication
- Keep your system updated
- Use a firewall
- Don't run as root

### Monitor Your Activity

- Check your positions regularly on [polymarket.com](https://polymarket.com/)
- Review bot logs for unexpected behavior
- Set up Telegram notifications (see `.env.example` for details)

---

## Next Steps

Now that your bot is running, you might want to:

1. **Read the [Complete Guide](./GUIDE.md)** - Detailed documentation on all features
2. **Customize your strategy** - Check out `STRATEGY_IMPLEMENTATIONS.md`
3. **Set up monitoring** - Configure Telegram notifications in your `.env`
4. **Fine-tune parameters** - Adjust `MIN_TRADE_SIZE_USD`, `FRONTRUN_SIZE_MULTIPLIER`, etc.

---

## Getting Help

If you're stuck:

1. Check the [docs folder](./docs/) for more detailed guides
2. Review the [Troubleshooting](#troubleshooting) section above
3. Check existing GitHub issues for similar problems
4. Open a new issue with your logs (redact your private key!)

---

## Summary

Here's what you accomplished:

1. ✅ Installed MetaMask and created a wallet
2. ✅ Exported your private key (safely!)
3. ✅ Added Polygon network to MetaMask
4. ✅ Got a reliable RPC URL
5. ✅ Funded your wallet with USDC and POL
6. ✅ Made your first trade on Polymarket (required for API access)
7. ✅ Installed and configured the bot
8. ✅ Started trading!

**Happy trading!** 🎯
