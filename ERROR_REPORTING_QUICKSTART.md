# 🚨 Error Reporting Feature - Quick Start

## What is it?

Automated error monitoring that **creates GitHub Issues** when your bot encounters problems. No more manual debugging - errors are automatically tracked, classified, and reported with full context.

## Setup (60 seconds)

### 1. Create GitHub Token

1. Go to: https://github.com/settings/tokens
2. Click "Generate new token (classic)"
3. Name: "APEX Error Reporter"
4. Select scope: ✅ **repo** (full control)
5. Generate and copy token

### 2. Add to .env

```bash
GITHUB_ERROR_REPORTER_TOKEN=ghp_YourTokenHere
```

That's it! ✅

## What You Get

### Automatic GitHub Issues

When errors occur, you get a GitHub Issue with:

- **🔴 Priority**: Critical, High, Medium, Low
- **📋 Error Details**: Type, message, stack trace
- **🔍 Context**: Balance, positions, mode, uptime
- **🎯 Operation**: What was happening when error occurred
- **🔧 Suggested Fixes**: Recommended actions

### Telegram Alerts

Get notified immediately:
```
🟠 Error Reported

Type: order
Priority: high
Message: Insufficient USDC balance

🔗 View Issue
```

### Smart Features

- ✅ **Rate Limiting**: Same error reported max once per hour
- ✅ **Classification**: Auth, network, order, data, config
- ✅ **Deduplication**: Tracks error history
- ✅ **Auto-Labels**: priority:high, category:order, auto-reported
- ✅ **Context Capture**: Full runtime state when error occurred

## Error Categories

| Category | Examples | Priority |
|----------|----------|----------|
| **Auth** | 401 errors, authentication failures | 🔴 Critical |
| **Network** | Timeouts, RPC errors | 🟡 Medium |
| **Order** | Insufficient balance, invalid orders | 🟠 High |
| **Data** | Parse errors, undefined properties | 🟡 Medium |
| **Configuration** | Missing ENV vars | 🟠 High |

## Example Issue

```markdown
🟠 [ORDER] Error: Insufficient USDC balance for order

## 🤖 Auto-Generated Error Report

**Error Pattern:** `order_failed`
**Category:** order
**Priority:** high
**Timestamp:** 2026-01-26T23:45:12.000Z

## 📋 Error Details

Type: OrderError
Message: Insufficient USDC balance for order

## 🔍 Runtime Context

Mode: AGGRESSIVE
Live Trading: YES ⚠️
Balance: $287.45
Positions: 12
Cycles: 14523
Uptime: 8.3h

## 🔧 Suggested Actions

- Verify sufficient USDC balance
- Check position sizing logic
- Review order validation rules
```

## No Token? No Problem!

If you don't set `GITHUB_ERROR_REPORTER_TOKEN`:
- Errors are still logged locally
- Bot still works normally
- Just no GitHub Issues created

## View Your Errors

**GitHub URL:**
```
https://github.com/YOUR-USERNAME/YOUR-REPO/issues?q=is:issue+label:auto-reported
```

**By Priority:**
```
label:priority:critical
label:priority:high
label:priority:medium
```

## Integration

The error reporter is **automatically initialized** on startup. It catches:
- Uncaught exceptions
- Unhandled promise rejections
- Manual reports (when you add `reportError()` calls)

No code changes needed - just set the token!

## Advanced Usage

### Manual Reporting

```typescript
import { reportError } from "./monitoring";

try {
  await riskyOperation();
} catch (error) {
  await reportError(error as Error, {
    operation: "buy_order",
    marketId: market.id,
    balance: state.balance,
  });
}
```

### Error Statistics

```typescript
import { getErrorReporter } from "./monitoring";

const reporter = getErrorReporter();
const stats = reporter?.getStats();

console.log(`Total errors: ${stats.totalErrors}`);
console.log(`Unique errors: ${stats.uniqueErrors}`);
```

## Documentation

- **Full Guide**: `docs/ERROR_REPORTING.md`
- **Integration Examples**: `docs/ERROR_REPORTING_INTEGRATION.md`

## Benefits

✅ **Automatic tracking** - No manual effort
✅ **Full context** - Debug faster
✅ **Priority sorting** - Focus on critical issues
✅ **Telegram alerts** - Stay informed
✅ **Rate limiting** - No spam
✅ **Suggested fixes** - Faster resolution
✅ **History tracking** - See patterns over time

---

**Your bot reports its own bugs!** 🤖🚨✅
