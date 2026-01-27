#!/bin/bash
# Diagnostic script for "No trades being copied" issue
# Run this to check your configuration

set -e

echo "═══════════════════════════════════════════════════════════════"
echo "  Polymarket Sniper Bot - No Trades Diagnostic"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# Check if .env exists
if [ ! -f .env ]; then
    echo "❌ ERROR: No .env file found"
    echo "   Copy .env.example to .env and configure it"
    exit 1
fi

echo "📋 Checking configuration..."
echo ""

# Source .env
set -a
source .env
set +a

# Check 1: LIVE_TRADING
echo "1️⃣  Live Trading Status"
if [ "$LIVE_TRADING" = "I_UNDERSTAND_THE_RISKS" ]; then
    echo "   ✅ LIVE_TRADING=I_UNDERSTAND_THE_RISKS (enabled)"
else
    echo "   ⚠️  LIVE_TRADING not set or wrong value"
    echo "   📝 Set: LIVE_TRADING=I_UNDERSTAND_THE_RISKS"
    echo "   ⚠️  Bot will only SIMULATE trades without this!"
fi
echo ""

# Check 2: COPY_ANY_WHALE_BUY
echo "2️⃣  Whale Copy Mode"
if [ "$COPY_ANY_WHALE_BUY" = "true" ]; then
    echo "   ✅ COPY_ANY_WHALE_BUY=true (AGGRESSIVE - copies any whale buy)"
    echo "   📊 Will copy immediately when 1 whale buys"
else
    echo "   ⚠️  COPY_ANY_WHALE_BUY=false or not set (CONSERVATIVE mode)"
    echo "   📝 Recommended: COPY_ANY_WHALE_BUY=true"
    echo "   📊 Currently requires: 3 whale trades + \$300 net flow"
    echo "   ⏱️  This can take 30-60 minutes to accumulate"
fi
echo ""

# Check 3: WHALE_TRADE_USD (supports both names)
echo "3️⃣  Whale Trade Threshold"
# Check both WHALE_TRADE_USD (preferred) and ONCHAIN_MIN_WHALE_TRADE_USD (legacy)
THRESHOLD=${WHALE_TRADE_USD:-${ONCHAIN_MIN_WHALE_TRADE_USD:-500}}
if [ "$THRESHOLD" -le 100 ]; then
    echo "   ✅ WHALE_TRADE_USD=$THRESHOLD"
    echo "   📊 Will detect whale trades >= \$$THRESHOLD"
elif [ "$THRESHOLD" -le 200 ]; then
    echo "   ⚠️  WHALE_TRADE_USD=$THRESHOLD (moderate)"
    echo "   📝 Consider lowering to 100 for more signals"
else
    echo "   ⚠️  WHALE_TRADE_USD=$THRESHOLD (high threshold)"
    echo "   📝 Recommended: WHALE_TRADE_USD=100"
    echo "   📊 Default is \$500 - may miss smaller whale trades"
fi
echo ""

# Check 4: RPC_URL WebSocket
echo "4️⃣  RPC Configuration"
if [ -z "$RPC_URL" ]; then
    echo "   ⚠️  RPC_URL not set (will use default)"
    echo "   📝 Recommended: Get Infura WebSocket URL"
    echo "   🔗 https://infura.io → Create project → Get WS endpoint"
elif [[ "$RPC_URL" == wss://* ]]; then
    echo "   ✅ RPC_URL uses WebSocket (wss://)"
    if [[ "$RPC_URL" == *"infura"* ]]; then
        echo "   ✅ Using Infura (recommended)"
    else
        echo "   ⚠️  Not using Infura - may have rate limits"
    fi
elif [[ "$RPC_URL" == https://* ]]; then
    echo "   ⚠️  RPC_URL uses HTTPS (not WebSocket)"
    echo "   📝 Change to WebSocket: wss://polygon-mainnet.infura.io/ws/v3/YOUR_KEY"
    echo "   ⚠️  On-chain monitoring requires WebSocket!"
else
    echo "   ❌ RPC_URL format not recognized"
fi
echo ""

# Check 5: MAX_TRADE_USD
echo "5️⃣  Trade Size"
TRADE_SIZE=${MAX_TRADE_USD:-25}
echo "   📊 MAX_TRADE_USD=$TRADE_SIZE"
if [ "$TRADE_SIZE" -le 10 ]; then
    echo "   ✅ Good for testing/small account"
else
    echo "   ⚠️  Consider starting with MAX_TRADE_USD=5 for testing"
fi
echo ""

# Check 6: ORDER_TYPE
echo "6️⃣  Order Type"
ORDER=${ORDER_TYPE:-FOK}
echo "   📊 ORDER_TYPE=$ORDER"
if [ "$ORDER" = "GTC" ]; then
    echo "   ✅ GTC (Good-Til-Cancelled) - posts to orderbook"
else
    echo "   ℹ️  FOK (Fill-Or-Kill) - immediate or cancel"
    echo "   📝 Optional: Set ORDER_TYPE=GTC for limit orders"
fi
echo ""

# Summary
echo "═══════════════════════════════════════════════════════════════"
echo "  SUMMARY"
echo "═══════════════════════════════════════════════════════════════"
echo ""

ISSUES=0
WARNINGS=0

if [ "$LIVE_TRADING" != "I_UNDERSTAND_THE_RISKS" ]; then
    echo "❌ CRITICAL: Live trading not enabled - bot will only simulate!"
    ISSUES=$((ISSUES + 1))
fi

if [ "$COPY_ANY_WHALE_BUY" != "true" ]; then
    echo "⚠️  WARNING: Conservative mode - may take 30-60 min to see trades"
    WARNINGS=$((WARNINGS + 1))
fi

THRESHOLD=${WHALE_TRADE_USD:-${ONCHAIN_MIN_WHALE_TRADE_USD:-500}}
if [ "$THRESHOLD" -gt 200 ]; then
    echo "⚠️  WARNING: High whale threshold ($THRESHOLD) - may miss signals"
    WARNINGS=$((WARNINGS + 1))
fi

if [ -z "$RPC_URL" ] || [[ "$RPC_URL" != wss://* ]]; then
    echo "❌ CRITICAL: WebSocket RPC required for on-chain monitoring!"
    ISSUES=$((ISSUES + 1))
fi

echo ""
if [ $ISSUES -gt 0 ]; then
    echo "🔴 $ISSUES critical issue(s) found - bot may not work properly"
    echo ""
    echo "📝 RECOMMENDED .env CHANGES:"
    echo ""
    if [ "$LIVE_TRADING" != "I_UNDERSTAND_THE_RISKS" ]; then
        echo "   LIVE_TRADING=I_UNDERSTAND_THE_RISKS"
    fi
    if [ -z "$RPC_URL" ] || [[ "$RPC_URL" != wss://* ]]; then
        echo "   RPC_URL=wss://polygon-mainnet.infura.io/ws/v3/YOUR_API_KEY"
    fi
    if [ "$COPY_ANY_WHALE_BUY" != "true" ]; then
        echo "   COPY_ANY_WHALE_BUY=true"
    fi
    if [ "$THRESHOLD" -gt 200 ]; then
        echo "   WHALE_TRADE_USD=100"
    fi
    echo ""
elif [ $WARNINGS -gt 0 ]; then
    echo "🟡 $WARNINGS warning(s) found - bot should work but may be slow"
    echo ""
    echo "📝 RECOMMENDED .env CHANGES (optional but helpful):"
    echo ""
    if [ "$COPY_ANY_WHALE_BUY" != "true" ]; then
        echo "   COPY_ANY_WHALE_BUY=true"
    fi
    if [ "$THRESHOLD" -gt 200 ]; then
        echo "   WHALE_TRADE_USD=100"
    fi
    echo ""
else
    echo "✅ Configuration looks good!"
    echo ""
    echo "🚀 Start the bot and look for these logs:"
    echo "   ⚡ On-chain → Bias | Block #... | \$... BUY"
    echo "   📊 Bias | ... | NONE → LONG | \$... flow"
    echo "   📥 LONG \$5.00 @ 45.0¢"
    echo ""
fi

echo "═══════════════════════════════════════════════════════════════"
