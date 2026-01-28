# Diagnostic Mode Guide

This document describes how to run the bot in **diagnostic mode** for safe testing and troubleshooting.

## Overview

Diagnostic mode (`DIAG_MODE=true`) runs a controlled one-shot workflow that:

1. **WHALE_BUY**: Waits for a whale signal and attempts to buy 1 share
2. **WHALE_SELL**: Attempts to sell 1 share from the whale buy
3. **WHALE_HEDGE**: Verifies hedge logic paths for the whale position
4. **SCAN_BUY**: Runs market scan and attempts to buy 1 share
5. **SCAN_SELL**: Attempts to sell 1 share from the scan buy
6. **SCAN_HEDGE**: Verifies hedge logic paths for the scan position

After completing all steps, the workflow either exits or holds (see `DIAGNOSTIC_POST_ACTION`).

## Running Diagnostic Mode

### Basic Usage

```bash
DIAG_MODE=true npm start
```

### With VPN (Recommended for Production)

```bash
DIAG_MODE=true \
WIREGUARD_ENABLED=true \
WIREGUARD_PRIVATE_KEY="..." \
WIREGUARD_ADDRESS="10.0.0.2/24" \
WIREGUARD_PEER_PUBLIC_KEY="..." \
WIREGUARD_PEER_ENDPOINT="vpn.example.com:51820" \
WIREGUARD_ALLOWED_IPS="0.0.0.0/0" \
npm start
```

## Environment Variables

### Core Diagnostic Settings

| Variable | Values | Default | Description |
|----------|--------|---------|-------------|
| `DIAG_MODE` | `true`/`false` | `false` | Enable diagnostic mode |
| `DIAGNOSTIC_POST_ACTION` | `exit`/`halt` | `halt` | What to do after workflow completes |
| `DIAG_MAX_PRICE` | `0.0-1.0` | `0.70` | Maximum price cap for diagnostic buys |
| `DIAG_WHALE_TIMEOUT_SEC` | number | `120` | Timeout waiting for whale signal |
| `DIAG_ORDER_TIMEOUT_SEC` | number | `30` | Timeout for order execution |
| `DIAG_FORCE_SHARES` | number | `1` | Number of shares to buy/sell |

### Post-Action Behavior

| Value | Description |
|-------|-------------|
| `exit` | Exit immediately after workflow (exit code from workflow result) |
| `halt` | Keep process alive indefinitely (prevents container restart loops) |

**Legacy variables** (still supported):
- `DIAG_EXIT=1` → Same as `DIAGNOSTIC_POST_ACTION=exit`
- `DIAG_HOLD_SECONDS=N` → Hold for N seconds then exit

### VPN Bypass Controls

| Variable | Values | Default | Description |
|----------|--------|---------|-------------|
| `VPN_BYPASS_RPC` | `true`/`false` | `true` | Bypass VPN for RPC calls (speed) |
| `VPN_BYPASS_POLYMARKET_READS` | `true`/`false` | `false` | Bypass VPN for read APIs |
| `VPN_BYPASS_POLYMARKET_WS` | `true`/`false` | `true` | Bypass VPN for WebSocket |

**CRITICAL**: WRITE hosts (`clob.polymarket.com`) are **NEVER** bypassed regardless of these settings. All order submissions, authentication, and cancellations always route through VPN.

## Understanding Diagnostic Events

### CLOUDFLARE_BLOCKED

**Meaning**: Cloudflare returned HTTP 403, blocking the request.

**Common causes**:
- Not using VPN (Polymarket blocks datacenter IPs)
- VPN server IP is flagged by Cloudflare
- WRITE host accidentally bypassing VPN

**Example log**:
```json
{
  "event": "CLOUDFLARE_BLOCKED",
  "host": "clob.polymarket.com",
  "statusCode": 403,
  "vpnActive": true,
  "hostBypassed": false,
  "rayId": "abc123..."
}
```

**Remediation**:
1. Ensure VPN is active (`vpnActive: true`)
2. Ensure host is not bypassed (`hostBypassed: false`)
3. Try a different VPN server (residential IPs work better)
4. Check VPN egress IP with `curl ifconfig.me`

### VPN_MISROUTED_WRITE_HOST

**Meaning**: A WRITE host was added to bypass routes (should never happen).

**Example log**:
```json
{
  "event": "VPN_MISROUTED_WRITE_HOST",
  "misroutedHosts": ["clob.polymarket.com"],
  "remediation": "Remove bypass routes for WRITE hosts"
}
```

**Remediation**:
1. Check your VPN configuration
2. Ensure `clob.polymarket.com` is not in any bypass list
3. Restart the bot to reset routing

### BOOK_TOO_WIDE

**Meaning**: Orderbook conditions are too extreme for safe trading.

**Triggers**:
- `bestAsk > 0.95` (market nearly resolved)
- `spread > 0.30` (illiquid market)

**Example log**:
```
🚫 BUY rejected: BOOK_TOO_WIDE - spread > threshold - illiquid market
   bestBid=0.3500, bestAsk=0.7000, spread=0.3500
```

**This is expected behavior** - diagnostic mode skips trades on untradeable books to prevent losses.

### Price Clamping

**Meaning**: The calculated limit price exceeded `DIAG_MAX_PRICE` and was capped.

**Example log**:
```
⚠️ [DIAG] Price clamped: 0.8500 → 0.7000 (DIAG_MAX_PRICE cap)
```

**This is a safety feature** - diagnostic mode never buys above the cap (default 0.70).

## Hedge Verification Skip Reasons

When hedge verification is skipped, the reason indicates why:

| Reason | Description |
|--------|-------------|
| `no_executed_position` | The buy step didn't execute or was rejected |
| `not_triggered` | Price hasn't moved adversely enough to trigger hedge |
| `missing_position_data` | Entry price unknown and no market data available |

## GitHub Issue Reporting

### Required Permissions

For GitHub Actions:
```yaml
permissions:
  issues: write
```

For personal access tokens (PAT):
- `repo` scope (for private repositories)
- `public_repo` scope (for public repositories only)

### Configuration

```bash
GITHUB_ERROR_REPORTER_TOKEN=ghp_xxxxx
GITHUB_ERROR_REPORTER_REPO=owner/repo
GITHUB_ERROR_REPORTER_ENABLED=true  # optional, defaults to true if token+repo set
```

### GITHUB_REPORT_FORBIDDEN

If you see this event, the GitHub API returned 403:

```json
{
  "event": "GITHUB_REPORT_FORBIDDEN",
  "tokenExists": true,
  "isCI": true,
  "error": "403 Forbidden"
}
```

**Remediation**:
1. For GitHub Actions: Add `permissions: issues: write` to workflow
2. For fork PRs: Issue creation may not be allowed
3. For PAT: Ensure token has `repo` scope

## Trace Files

Diagnostic mode generates `diag-trace.jsonl` with all events:

```bash
# View trace file
cat diag-trace.jsonl | jq .

# Filter for errors
cat diag-trace.jsonl | jq 'select(.result == "ERROR" or .result == "REJECTED")'
```

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Workflow completed (even if steps were rejected/skipped) |
| `1` | Fatal error or uncaught exception |

## Troubleshooting

### No whale signals received

1. Check `DIAG_WHALE_TIMEOUT_SEC` (default 120 seconds)
2. Verify on-chain monitor is connected
3. Check whale wallet list is loaded

### Orders always rejected

1. Check VPN is active and properly configured
2. Check balance is sufficient (`LIVE_TRADING_ENABLED=true`)
3. Check orderbook conditions (not too wide)

### Process keeps restarting

Set `DIAGNOSTIC_POST_ACTION=halt` to prevent restart loops in container orchestrators.
