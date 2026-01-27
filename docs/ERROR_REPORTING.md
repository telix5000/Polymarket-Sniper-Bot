# 🚨 APEX Error Reporting System

## Overview

The APEX Error Reporter automatically monitors your trading bot for errors and creates GitHub Issues when problems occur. This enables:

- **Automatic error tracking** - No manual reporting needed
- **Detailed diagnostics** - Full context capture (balance, positions, stack traces)
- **Priority classification** - Critical, high, medium, low based on error type
- **Smart deduplication** - Rate limiting prevents spam (1 hour between duplicate reports)
- **Telegram alerts** - Get notified immediately when errors occur
- **Auto-fix suggestions** - Known error patterns include suggested fixes

## Setup

### 1. Create GitHub Personal Access Token

1. Go to GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Click "Generate new token (classic)"
3. Give it a descriptive name: "APEX Error Reporter"
4. Select scopes: **`repo`** (full control of private repositories)
5. Click "Generate token"
6. **Copy the token** (you won't see it again!)

### 2. Add to .env File

```bash
# APEX Error Reporting (optional)
GITHUB_ERROR_REPORTER_TOKEN=ghp_your_token_here
```

That's it! The error reporter will automatically initialize when the bot starts.

## How It Works

### Automatic Error Detection

The error reporter monitors:
- **Uncaught exceptions** - Any unhandled errors that would crash the bot
- **Unhandled promise rejections** - Async errors
- **Manual reports** - Errors you explicitly report in your code

### Error Classification

Errors are automatically classified into categories:

| Category | Examples | Priority |
|----------|----------|----------|
| **Auth** | 401 errors, authentication failures | Critical |
| **Network** | Timeouts, connection refused, RPC errors | Medium-High |
| **Order** | Insufficient balance, invalid orders | High |
| **Data** | Parse errors, undefined properties | Medium |
| **Configuration** | Missing ENV vars, invalid config | High |

### GitHub Issue Creation

When an error occurs, the reporter:

1. **Classifies** the error based on patterns
2. **Checks rate limiting** (1 hour between duplicate reports)
3. **Creates GitHub Issue** with:
   - Priority emoji (🔴 critical, 🟠 high, 🟡 medium, 🟢 low)
   - Detailed error message and stack trace
   - Runtime context (balance, positions, mode)
   - Suggested actions for fixing
   - Auto-generated labels
4. **Sends Telegram notification** (if configured)
5. **Records** in error history for deduplication

### Example GitHub Issue

```markdown
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

## Using Error Reporter in Code

### Basic Usage

```typescript
import { reportError } from "./monitoring";

try {
  await riskyOperation();
} catch (error) {
  // Automatically report to GitHub
  await reportError(error as Error, {
    operation: "buy_order",
    marketId: "market_123",
    balance: currentBalance,
    positionCount: positions.length,
  });
  
  // Handle error locally
  logger.error(`Operation failed: ${error}`);
}
```

### With Strategy Context

```typescript
// In APEX Hunter strategy
try {
  const opportunities = await scanMarkets();
} catch (error) {
  await reportError(error as Error, {
    operation: "apex_hunter_scan",
    mode: "AGGRESSIVE",
    cycleCount: state.cycleCount,
  });
}
```

### Manual Reporting

```typescript
import { getErrorReporter } from "./monitoring";

const reporter = getErrorReporter();

if (reporter) {
  await reporter.reportError(
    new Error("Custom error message"),
    {
      operation: "custom_operation",
      balance: 300.00,
      mode: "AGGRESSIVE",
    }
  );
}
```

## Rate Limiting

The reporter automatically prevents spam:

- **Same error reported multiple times:** Only reported once per hour
- **History tracking:** Maintains count of how many times each error occurred
- **Auto-cleanup:** Old errors removed after 100 unique errors tracked

Example:
```
[12:00] Auth error → GitHub Issue created ✅
[12:15] Auth error → Rate limited (skip) ⏭️
[12:45] Auth error → Rate limited (skip) ⏭️
[13:01] Auth error → GitHub Issue created ✅ (1 hour passed)
```

## Error Statistics

Get insights into error patterns:

```typescript
import { getErrorReporter } from "./monitoring";

const reporter = getErrorReporter();
const stats = reporter?.getStats();

console.log(`Total errors: ${stats.totalErrors}`);
console.log(`Unique errors: ${stats.uniqueErrors}`);
console.log(`Recent errors:`, stats.recentErrors);
```

Output:
```
Total errors: 47
Unique errors: 8
Recent errors: [
  { key: "order_failed:Insufficient balance", count: 12, lastReport: 1706315112000 },
  { key: "network_timeout:RPC timeout", count: 8, lastReport: 1706312000000 },
  ...
]
```

## Telegram Integration

When an error is reported to GitHub, you'll also get a Telegram notification (if configured):

```
🟠 Error Reported

Type: order
Priority: high
Message: Insufficient USDC balance for order

🔗 View Issue
```

Click the link to go directly to the GitHub Issue.

## Configuration Options

### Environment Variables

```bash
# Required for GitHub reporting
GITHUB_ERROR_REPORTER_TOKEN=ghp_your_token_here

# Optional: Custom repo (default: telix5000/Polymarket-Sniper-Bot)
# GITHUB_ERROR_REPO_OWNER=your-username
# GITHUB_ERROR_REPO_NAME=your-repo

# Optional: Disable Telegram notifications for errors
# GITHUB_ERROR_TELEGRAM_ENABLED=false
```

### Programmatic Configuration

```typescript
import { ErrorReporter } from "./monitoring";

const reporter = new ErrorReporter(logger, {
  githubToken: "ghp_your_token",
  repoOwner: "your-username",
  repoName: "your-repo",
  telegramEnabled: true,
});
```

## Error Patterns

The reporter recognizes these patterns:

| Pattern ID | Regex | Priority | Auto-Fix |
|------------|-------|----------|----------|
| `auth_401` | 401, unauthorized | Critical | No |
| `network_timeout` | timeout, ETIMEDOUT | Medium | Yes |
| `order_failed` | order failed, insufficient balance | High | No |
| `data_parse` | parse, JSON, undefined | Medium | Yes |
| `config_missing` | missing config, env not set | High | No |
| `rpc_error` | rpc error, provider error | High | Yes |
| `unknown` | (default) | Medium | No |

## Labels

GitHub Issues are automatically labeled:

- `bug` - Always applied
- `priority:critical`, `priority:high`, `priority:medium`, `priority:low`
- `category:auth`, `category:network`, `category:order`, etc.
- `auto-reported` - Identifies bot-generated issues
- `auto-fix-available` - Known fix pattern exists
- `simulation` - Error occurred in simulation mode

## Best Practices

### 1. **Always Provide Context**

```typescript
// ❌ Bad - no context
await reportError(error);

// ✅ Good - rich context
await reportError(error, {
  operation: "apex_velocity_buy",
  marketId: market.id,
  balance: state.balance,
  mode: state.mode,
  cycleCount: state.cycleCount,
});
```

### 2. **Use Descriptive Operations**

```typescript
// ❌ Bad
operation: "buy"

// ✅ Good
operation: "apex_shadow_copy_whale_trade"
```

### 3. **Don't Report Expected Errors**

```typescript
// ❌ Bad - reporting validation errors
if (balance < minBalance) {
  await reportError(new Error("Balance too low"));
}

// ✅ Good - only report unexpected errors
try {
  await executeOrder();
} catch (error) {
  if (isUnexpectedError(error)) {
    await reportError(error);
  }
}
```

### 4. **Include Market/Token IDs When Relevant**

```typescript
await reportError(error, {
  operation: "buy_order",
  marketId: market.id,      // ✅
  tokenId: token.id,        // ✅
});
```

## Disabling Error Reporting

### Temporarily (don't set token)

Simply don't set `GITHUB_ERROR_REPORTER_TOKEN`. Errors will be logged locally but not reported to GitHub.

### Permanently (remove initialization)

Comment out the error reporter initialization in `start.ts`:

```typescript
// import { initErrorReporter } from "./monitoring";

// Don't initialize
// initErrorReporter(logger);
```

## FAQ

### Q: Will this spam my GitHub Issues?

No! Rate limiting ensures the same error is only reported once per hour.

### Q: What if I don't have a GitHub token?

The bot will still work fine. Errors will be logged locally but not reported to GitHub.

### Q: Can I use this with a private repo?

Yes! Make sure your GitHub token has `repo` scope for private repositories.

### Q: Will this slow down the bot?

No. Error reporting happens asynchronously and doesn't block trading operations.

### Q: Can I customize error patterns?

Yes! Edit the `ERROR_PATTERNS` array in `src/monitoring/error-reporter.ts`.

### Q: What happens on uncaught exceptions?

The error is reported, then the bot exits after 5 seconds (giving time for the report to send).

### Q: Can I create PRs automatically for fixes?

This is planned for future versions. Currently only Issues are created.

## Monitoring Your Issues

### GitHub

Visit: `https://github.com/YOUR-USERNAME/YOUR-REPO/issues?q=is%3Aissue+label%3Aauto-reported`

### API Query

```bash
curl -H "Authorization: token YOUR_TOKEN" \
  https://api.github.com/repos/YOUR-USERNAME/YOUR-REPO/issues?labels=auto-reported
```

## Future Enhancements

Planned features:
- [ ] Automatic PR creation with fixes for known patterns
- [ ] Error trend analysis and dashboards
- [ ] Integration with external monitoring services
- [ ] Custom webhook support
- [ ] Error aggregation and grouping
- [ ] Auto-close issues when errors stop occurring

---

**The bot learns from its mistakes and reports them automatically!** 🤖🚨✅
