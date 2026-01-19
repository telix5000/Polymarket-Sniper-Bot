#!/bin/bash
# Quick Diagnostic Script for 401 Auth Failures
# 
# This script runs the HMAC diagnostic tool to identify the exact cause
# of 401 "Unauthorized/Invalid api key" errors.
#
# Usage:
#   chmod +x scripts/quick-401-diagnostic.sh
#   ./scripts/quick-401-diagnostic.sh

set -e

echo "========================================================================"
echo "POLYMARKET 401 DIAGNOSTIC TOOL"
echo "========================================================================"
echo ""
echo "This tool will:"
echo "  1. Check your environment variables"
echo "  2. Run HMAC diagnostic tracing"
echo "  3. Show the exact mismatch causing 401 errors"
echo ""

# Check required environment variables
if [ -z "$PRIVATE_KEY" ]; then
  echo "❌ ERROR: PRIVATE_KEY is not set"
  echo ""
  echo "Please set your environment variables:"
  echo "  export PRIVATE_KEY=\"your_private_key\""
  echo "  export POLYMARKET_API_KEY=\"your_api_key\""
  echo "  export POLYMARKET_API_SECRET=\"your_api_secret\""
  echo "  export POLYMARKET_API_PASSPHRASE=\"your_passphrase\""
  echo ""
  echo "Then run this script again."
  exit 1
fi

if [ -z "$POLYMARKET_API_KEY" ]; then
  echo "❌ ERROR: POLYMARKET_API_KEY is not set"
  exit 1
fi

if [ -z "$POLYMARKET_API_SECRET" ]; then
  echo "❌ ERROR: POLYMARKET_API_SECRET is not set"
  exit 1
fi

if [ -z "$POLYMARKET_API_PASSPHRASE" ]; then
  echo "❌ ERROR: POLYMARKET_API_PASSPHRASE is not set"
  exit 1
fi

echo "✓ Environment variables configured"
echo ""

# Show configuration (redacted)
echo "Configuration:"
echo "  PRIVATE_KEY: ${PRIVATE_KEY:0:8}...${PRIVATE_KEY: -4}"
echo "  POLYMARKET_API_KEY: ${POLYMARKET_API_KEY:0:8}...${POLYMARKET_API_KEY: -4}"
echo "  POLYMARKET_API_SECRET: ${POLYMARKET_API_SECRET:0:8}...${POLYMARKET_API_SECRET: -4}"
echo "  POLYMARKET_API_PASSPHRASE: ${POLYMARKET_API_PASSPHRASE:0:4}...${POLYMARKET_API_PASSPHRASE: -4}"

if [ -n "$POLYMARKET_SIGNATURE_TYPE" ]; then
  echo "  POLYMARKET_SIGNATURE_TYPE: $POLYMARKET_SIGNATURE_TYPE"
fi

if [ -n "$POLYMARKET_PROXY_ADDRESS" ]; then
  echo "  POLYMARKET_PROXY_ADDRESS: $POLYMARKET_PROXY_ADDRESS"
fi

echo ""
echo "------------------------------------------------------------------------"
echo "RUNNING DIAGNOSTIC..."
echo "------------------------------------------------------------------------"
echo ""

# Enable diagnostics and run test
export ENABLE_HMAC_DIAGNOSTICS=true
export DEBUG_HMAC_SIGNING=true

# Build if needed
if [ ! -d "dist" ]; then
  echo "Building project..."
  npm run build
  echo ""
fi

# Run diagnostic
node scripts/test-hmac-diagnostic.js

echo ""
echo "------------------------------------------------------------------------"
echo "DIAGNOSTIC COMPLETE"
echo "------------------------------------------------------------------------"
echo ""
echo "If you see a 401 error above, look for:"
echo "  1. [WARN] [HmacDiag] MISMATCH DETECTED - Shows path/method mismatch"
echo "  2. JSON diagnostic output - Shows exact discrepancy"
echo ""
echo "Common fixes:"
echo ""
echo "  Path Mismatch:"
echo "    → The patch needs to be extended to more endpoints"
echo "    → Contact support with the diagnostic output"
echo ""
echo "  Wrong Signature Type:"
echo "    → If you created your wallet via polymarket.com, try:"
echo "      export POLYMARKET_SIGNATURE_TYPE=2"
echo "      export POLYMARKET_PROXY_ADDRESS=\"your_proxy_address\""
echo "    → Find proxy address: polymarket.com → Profile → Deposit address"
echo ""
echo "For detailed help, see:"
echo "  - NEXT_STEPS_401_FIX.md"
echo "  - HMAC_DIAGNOSTIC_FIX.md"
echo ""
