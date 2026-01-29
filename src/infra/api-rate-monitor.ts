/**
 * API Rate Monitor - Track API usage and alert on limit violations
 *
 * Monitors all API calls across providers (Infura, Polymarket, GitHub) and:
 * 1. Keeps a running tally of API calls by provider/endpoint
 * 2. Warns when approaching rate limits
 * 3. Automatically opens GitHub issues when limits are exceeded
 * 4. Tracks missed trades (buys/sells/hedges) and alerts on patterns
 *
 * This provides visibility into API usage and prevents unexpected rate limiting.
 */

import { reportError, getGitHubReporter } from "./github-reporter";

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export type ApiProvider = "infura" | "polymarket_clob" | "polymarket_data" | "polymarket_gamma" | "github" | "telegram" | "other";

export type TradeType = "BUY" | "SELL" | "HEDGE";

export interface ApiCallRecord {
  provider: ApiProvider;
  endpoint: string;
  timestamp: number;
  success: boolean;
  latencyMs?: number;
  errorCode?: string;
}

export interface MissedTradeRecord {
  type: TradeType;
  tokenId: string;
  reason: string;
  timestamp: number;
  sizeUsd?: number;
}

export interface RateLimitConfig {
  /** Calls per minute threshold for warning */
  warningPerMinute: number;
  /** Calls per minute threshold for critical alert */
  criticalPerMinute: number;
  /** Calls per hour threshold for warning */
  warningPerHour: number;
  /** Calls per hour threshold for critical alert */
  criticalPerHour: number;
  /** Daily limit (if applicable) */
  dailyLimit?: number;
}

export interface ApiRateMonitorConfig {
  /** Enable monitoring (default: true) */
  enabled: boolean;
  /** Rate limits by provider */
  limits: Record<ApiProvider, RateLimitConfig>;
  /** Window for missed trade pattern detection (ms) */
  missedTradeWindowMs: number;
  /** Threshold for consecutive missed trades to trigger alert */
  missedTradeAlertThreshold: number;
  /** Cooldown between GitHub issues for same alert type (ms) */
  alertCooldownMs: number;
}

export interface ApiUsageStats {
  provider: ApiProvider;
  callsLastMinute: number;
  callsLastHour: number;
  callsToday: number;
  successRate: number;
  avgLatencyMs: number;
  status: "OK" | "WARNING" | "CRITICAL";
  message?: string;
}

export interface MissedTradeStats {
  type: TradeType;
  countLastHour: number;
  consecutiveCount: number;
  lastReason?: string;
  status: "OK" | "WARNING" | "CRITICAL";
}

// ═══════════════════════════════════════════════════════════════════════════
// DEFAULT CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Default rate limits based on known API constraints
 * Infura limits depend on tier (configured via INFURA_TIER env var)
 */
const DEFAULT_LIMITS: Record<ApiProvider, RateLimitConfig> = {
  // Infura free tier: ~10 req/sec, 100k/day
  // These are conservative defaults - adjusted based on INFURA_TIER
  infura: {
    warningPerMinute: 300,      // 5 req/sec
    criticalPerMinute: 500,     // ~8 req/sec
    warningPerHour: 10000,
    criticalPerHour: 15000,
    dailyLimit: 100000,         // Free tier
  },
  // Polymarket CLOB API - order submission
  polymarket_clob: {
    warningPerMinute: 50,
    criticalPerMinute: 80,
    warningPerHour: 1000,
    criticalPerHour: 2000,
  },
  // Polymarket Data API - market data, positions
  polymarket_data: {
    warningPerMinute: 100,
    criticalPerMinute: 150,
    warningPerHour: 3000,
    criticalPerHour: 5000,
  },
  // Polymarket Gamma API - market metadata
  polymarket_gamma: {
    warningPerMinute: 50,
    criticalPerMinute: 80,
    warningPerHour: 1000,
    criticalPerHour: 2000,
  },
  // GitHub API - error reporting
  github: {
    warningPerMinute: 5,
    criticalPerMinute: 10,
    warningPerHour: 30,
    criticalPerHour: 50,
  },
  // Telegram API - notifications
  telegram: {
    warningPerMinute: 20,
    criticalPerMinute: 30,
    warningPerHour: 200,
    criticalPerHour: 300,
  },
  // Other/unknown
  other: {
    warningPerMinute: 100,
    criticalPerMinute: 200,
    warningPerHour: 2000,
    criticalPerHour: 5000,
  },
};

const DEFAULT_CONFIG: ApiRateMonitorConfig = {
  enabled: true,
  limits: DEFAULT_LIMITS,
  missedTradeWindowMs: 60 * 60 * 1000, // 1 hour
  missedTradeAlertThreshold: 5,         // 5 consecutive misses
  alertCooldownMs: 30 * 60 * 1000,      // 30 minutes between same alerts
};

// ═══════════════════════════════════════════════════════════════════════════
// API RATE MONITOR
// ═══════════════════════════════════════════════════════════════════════════

export class ApiRateMonitor {
  private config: ApiRateMonitorConfig;
  private calls: ApiCallRecord[] = [];
  private missedTrades: MissedTradeRecord[] = [];
  private lastAlerts: Map<string, number> = new Map();
  private consecutiveMissedByType: Map<TradeType, number> = new Map();
  private dayStartTimestamp: number;

  constructor(config: Partial<ApiRateMonitorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.dayStartTimestamp = this.getDayStart();
    
    // Adjust Infura limits based on tier
    this.adjustInfuraLimits();
  }

  /**
   * Adjust Infura rate limits based on INFURA_TIER environment variable
   */
  private adjustInfuraLimits(): void {
    const tier = (process.env.INFURA_TIER || "core").toLowerCase();
    
    switch (tier) {
      case "developer":
        this.config.limits.infura = {
          warningPerMinute: 2000,
          criticalPerMinute: 3500,
          warningPerHour: 50000,
          criticalPerHour: 80000,
          dailyLimit: 15000000,
        };
        break;
      case "team":
        this.config.limits.infura = {
          warningPerMinute: 20000,
          criticalPerMinute: 35000,
          warningPerHour: 500000,
          criticalPerHour: 800000,
          dailyLimit: 75000000,
        };
        break;
      case "growth":
        this.config.limits.infura = {
          warningPerMinute: 50000,
          criticalPerMinute: 90000,
          warningPerHour: 1000000,
          criticalPerHour: 2000000,
          dailyLimit: 200000000,
        };
        break;
      default: // core (free)
        // Use defaults
        break;
    }
  }

  /**
   * Record an API call
   */
  recordCall(params: {
    provider: ApiProvider;
    endpoint: string;
    success: boolean;
    latencyMs?: number;
    errorCode?: string;
  }): void {
    if (!this.config.enabled) return;

    const record: ApiCallRecord = {
      ...params,
      timestamp: Date.now(),
    };

    this.calls.push(record);
    this.pruneOldRecords();
    this.checkRateLimits(params.provider);
  }

  /**
   * Record a missed trade (buy/sell/hedge that failed or was blocked)
   */
  recordMissedTrade(params: {
    type: TradeType;
    tokenId: string;
    reason: string;
    sizeUsd?: number;
  }): void {
    if (!this.config.enabled) return;

    const record: MissedTradeRecord = {
      ...params,
      timestamp: Date.now(),
    };

    this.missedTrades.push(record);

    // Update consecutive count
    const current = this.consecutiveMissedByType.get(params.type) || 0;
    this.consecutiveMissedByType.set(params.type, current + 1);

    this.pruneOldMissedTrades();
    this.checkMissedTradePattern(params.type);
  }

  /**
   * Record a successful trade (resets consecutive missed count)
   */
  recordSuccessfulTrade(type: TradeType): void {
    this.consecutiveMissedByType.set(type, 0);
  }

  /**
   * Get current usage statistics for all providers
   */
  getUsageStats(): ApiUsageStats[] {
    const now = Date.now();
    const oneMinuteAgo = now - 60 * 1000;
    const oneHourAgo = now - 60 * 60 * 1000;

    const providers: ApiProvider[] = [
      "infura",
      "polymarket_clob",
      "polymarket_data",
      "polymarket_gamma",
      "github",
      "telegram",
    ];

    return providers.map((provider) => {
      const providerCalls = this.calls.filter((c) => c.provider === provider);
      const callsLastMinute = providerCalls.filter((c) => c.timestamp >= oneMinuteAgo).length;
      const callsLastHour = providerCalls.filter((c) => c.timestamp >= oneHourAgo).length;
      const callsToday = providerCalls.filter((c) => c.timestamp >= this.dayStartTimestamp).length;

      const successfulCalls = providerCalls.filter((c) => c.success);
      const successRate = providerCalls.length > 0
        ? (successfulCalls.length / providerCalls.length) * 100
        : 100;

      const latencies = providerCalls
        .filter((c) => c.latencyMs !== undefined)
        .map((c) => c.latencyMs!);
      const avgLatencyMs = latencies.length > 0
        ? latencies.reduce((a, b) => a + b, 0) / latencies.length
        : 0;

      const limits = this.config.limits[provider];
      let status: "OK" | "WARNING" | "CRITICAL" = "OK";
      let message: string | undefined;

      if (callsLastMinute >= limits.criticalPerMinute) {
        status = "CRITICAL";
        message = `Rate limit critical: ${callsLastMinute}/min (limit: ${limits.criticalPerMinute})`;
      } else if (callsLastMinute >= limits.warningPerMinute) {
        status = "WARNING";
        message = `Rate limit warning: ${callsLastMinute}/min (threshold: ${limits.warningPerMinute})`;
      } else if (callsLastHour >= limits.criticalPerHour) {
        status = "CRITICAL";
        message = `Hourly limit critical: ${callsLastHour}/hr (limit: ${limits.criticalPerHour})`;
      } else if (callsLastHour >= limits.warningPerHour) {
        status = "WARNING";
        message = `Hourly limit warning: ${callsLastHour}/hr (threshold: ${limits.warningPerHour})`;
      } else if (limits.dailyLimit && callsToday >= limits.dailyLimit * 0.9) {
        status = "CRITICAL";
        message = `Daily limit critical: ${callsToday} (limit: ${limits.dailyLimit})`;
      } else if (limits.dailyLimit && callsToday >= limits.dailyLimit * 0.7) {
        status = "WARNING";
        message = `Daily limit warning: ${callsToday} (70% of ${limits.dailyLimit})`;
      }

      return {
        provider,
        callsLastMinute,
        callsLastHour,
        callsToday,
        successRate,
        avgLatencyMs,
        status,
        message,
      };
    });
  }

  /**
   * Get missed trade statistics
   */
  getMissedTradeStats(): MissedTradeStats[] {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;

    const types: TradeType[] = ["BUY", "SELL", "HEDGE"];

    return types.map((type) => {
      const typeMisses = this.missedTrades.filter(
        (m) => m.type === type && m.timestamp >= oneHourAgo
      );
      const consecutiveCount = this.consecutiveMissedByType.get(type) || 0;
      const lastMiss = typeMisses[typeMisses.length - 1];

      let status: "OK" | "WARNING" | "CRITICAL" = "OK";
      if (consecutiveCount >= this.config.missedTradeAlertThreshold) {
        status = "CRITICAL";
      } else if (consecutiveCount >= Math.ceil(this.config.missedTradeAlertThreshold / 2)) {
        status = "WARNING";
      }

      return {
        type,
        countLastHour: typeMisses.length,
        consecutiveCount,
        lastReason: lastMiss?.reason,
        status,
      };
    });
  }

  /**
   * Get a summary of current monitoring status
   */
  getSummary(): {
    apiStatus: "OK" | "WARNING" | "CRITICAL";
    tradeStatus: "OK" | "WARNING" | "CRITICAL";
    issues: string[];
    totalCallsLastHour: number;
    totalMissedTradesLastHour: number;
  } {
    const apiStats = this.getUsageStats();
    const tradeStats = this.getMissedTradeStats();
    const issues: string[] = [];

    // Determine overall API status
    let apiStatus: "OK" | "WARNING" | "CRITICAL" = "OK";
    for (const stat of apiStats) {
      if (stat.status === "CRITICAL") {
        apiStatus = "CRITICAL";
        issues.push(`${stat.provider}: ${stat.message}`);
      } else if (stat.status === "WARNING" && apiStatus !== "CRITICAL") {
        apiStatus = "WARNING";
        issues.push(`${stat.provider}: ${stat.message}`);
      }
    }

    // Determine overall trade status
    let tradeStatus: "OK" | "WARNING" | "CRITICAL" = "OK";
    for (const stat of tradeStats) {
      if (stat.status === "CRITICAL") {
        tradeStatus = "CRITICAL";
        issues.push(`Missed ${stat.type}s: ${stat.consecutiveCount} consecutive (${stat.lastReason})`);
      } else if (stat.status === "WARNING" && tradeStatus !== "CRITICAL") {
        tradeStatus = "WARNING";
        issues.push(`Missed ${stat.type}s: ${stat.consecutiveCount} consecutive`);
      }
    }

    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;

    return {
      apiStatus,
      tradeStatus,
      issues,
      totalCallsLastHour: this.calls.filter((c) => c.timestamp >= oneHourAgo).length,
      totalMissedTradesLastHour: this.missedTrades.filter((m) => m.timestamp >= oneHourAgo).length,
    };
  }

  /**
   * Log current status to console
   */
  logStatus(): void {
    const summary = this.getSummary();
    const apiStats = this.getUsageStats();

    console.log("\n📊 [API MONITOR] Status Report");
    console.log("═".repeat(50));

    for (const stat of apiStats) {
      const statusIcon = stat.status === "OK" ? "✅" : stat.status === "WARNING" ? "⚠️" : "🚨";
      console.log(
        `${statusIcon} ${stat.provider}: ${stat.callsLastMinute}/min, ${stat.callsLastHour}/hr, ${stat.callsToday} today`
      );
      if (stat.message) {
        console.log(`   └─ ${stat.message}`);
      }
    }

    const tradeStats = this.getMissedTradeStats();
    console.log("\n📈 Trade Execution Status:");
    for (const stat of tradeStats) {
      const statusIcon = stat.status === "OK" ? "✅" : stat.status === "WARNING" ? "⚠️" : "🚨";
      console.log(
        `${statusIcon} ${stat.type}: ${stat.countLastHour} missed/hr, ${stat.consecutiveCount} consecutive`
      );
    }

    if (summary.issues.length > 0) {
      console.log("\n⚠️ Active Issues:");
      for (const issue of summary.issues) {
        console.log(`   • ${issue}`);
      }
    }

    console.log("═".repeat(50));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRIVATE METHODS
  // ─────────────────────────────────────────────────────────────────────────

  private checkRateLimits(provider: ApiProvider): void {
    const now = Date.now();
    const oneMinuteAgo = now - 60 * 1000;
    const oneHourAgo = now - 60 * 60 * 1000;

    const providerCalls = this.calls.filter((c) => c.provider === provider);
    const callsLastMinute = providerCalls.filter((c) => c.timestamp >= oneMinuteAgo).length;
    const callsLastHour = providerCalls.filter((c) => c.timestamp >= oneHourAgo).length;
    const callsToday = providerCalls.filter((c) => c.timestamp >= this.dayStartTimestamp).length;

    const limits = this.config.limits[provider];

    // Check for critical rate limit exceeded
    if (callsLastMinute >= limits.criticalPerMinute) {
      this.triggerAlert(
        `api_rate_critical_${provider}`,
        `🚨 API Rate Limit CRITICAL: ${provider}`,
        `The ${provider} API is being called at a critical rate that may cause failures.\n\n` +
        `**Current Usage:**\n` +
        `- Calls/minute: ${callsLastMinute} (limit: ${limits.criticalPerMinute})\n` +
        `- Calls/hour: ${callsLastHour}\n` +
        `- Calls today: ${callsToday}\n\n` +
        `**Action Required:** Review code for unnecessary API calls or increase rate limit tier.`,
        "critical"
      );
    } else if (callsLastMinute >= limits.warningPerMinute) {
      this.triggerAlert(
        `api_rate_warning_${provider}`,
        `⚠️ API Rate Limit Warning: ${provider}`,
        `The ${provider} API is approaching rate limits.\n\n` +
        `**Current Usage:**\n` +
        `- Calls/minute: ${callsLastMinute} (threshold: ${limits.warningPerMinute})\n` +
        `- Calls/hour: ${callsLastHour}\n\n` +
        `Consider optimizing API usage or upgrading tier.`,
        "warning"
      );
    }

    // Check daily limit
    if (limits.dailyLimit && callsToday >= limits.dailyLimit * 0.9) {
      this.triggerAlert(
        `api_daily_limit_${provider}`,
        `🚨 Daily API Limit Critical: ${provider}`,
        `The ${provider} API is at 90%+ of daily limit.\n\n` +
        `**Usage:** ${callsToday} / ${limits.dailyLimit} (${((callsToday / limits.dailyLimit) * 100).toFixed(1)}%)\n\n` +
        `**Action Required:** Upgrade API tier or reduce usage immediately.`,
        "critical"
      );
    }
  }

  private checkMissedTradePattern(type: TradeType): void {
    const consecutiveCount = this.consecutiveMissedByType.get(type) || 0;
    
    if (consecutiveCount >= this.config.missedTradeAlertThreshold) {
      const recentMisses = this.missedTrades
        .filter((m) => m.type === type)
        .slice(-this.config.missedTradeAlertThreshold);

      const reasons = recentMisses.map((m) => m.reason);
      const uniqueReasons = [...new Set(reasons)];
      const tokenIds = recentMisses.map((m) => m.tokenId.slice(0, 16) + "...");

      this.triggerAlert(
        `missed_trades_${type.toLowerCase()}`,
        `🚨 Consecutive Missed ${type}s Detected`,
        `The bot has failed to execute ${consecutiveCount} consecutive ${type} orders.\n\n` +
        `**Failure Reasons:**\n${uniqueReasons.map((r) => `- ${r}`).join("\n")}\n\n` +
        `**Affected Tokens:**\n${tokenIds.map((t) => `- ${t}`).join("\n")}\n\n` +
        `**Possible Causes:**\n` +
        `- Insufficient liquidity\n` +
        `- API connectivity issues\n` +
        `- Rate limiting\n` +
        `- Price movement too fast\n\n` +
        `**Action Required:** Review logs and market conditions.`,
        "critical"
      );
    }
  }

  private triggerAlert(
    alertKey: string,
    title: string,
    body: string,
    severity: "warning" | "critical"
  ): void {
    const now = Date.now();
    const lastAlert = this.lastAlerts.get(alertKey) || 0;

    // Check cooldown
    if (now - lastAlert < this.config.alertCooldownMs) {
      return;
    }

    this.lastAlerts.set(alertKey, now);

    // Log to console
    if (severity === "critical") {
      console.error(`\n🚨 [ALERT] ${title}`);
    } else {
      console.warn(`\n⚠️ [ALERT] ${title}`);
    }

    // Report to GitHub
    reportError(title, body, severity === "critical" ? "error" : "warning", {
      alertKey,
      timestamp: new Date().toISOString(),
    });
  }

  private pruneOldRecords(): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000; // Keep 24 hours
    this.calls = this.calls.filter((c) => c.timestamp >= cutoff);

    // Reset day counter if needed
    const currentDayStart = this.getDayStart();
    if (currentDayStart !== this.dayStartTimestamp) {
      this.dayStartTimestamp = currentDayStart;
    }
  }

  private pruneOldMissedTrades(): void {
    const cutoff = Date.now() - this.config.missedTradeWindowMs;
    this.missedTrades = this.missedTrades.filter((m) => m.timestamp >= cutoff);
  }

  private getDayStart(): number {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }

  /**
   * Reset all counters (for testing)
   */
  reset(): void {
    this.calls = [];
    this.missedTrades = [];
    this.lastAlerts.clear();
    this.consecutiveMissedByType.clear();
    this.dayStartTimestamp = this.getDayStart();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════════════════

let instance: ApiRateMonitor | null = null;

/**
 * Initialize the global API rate monitor
 */
export function initApiRateMonitor(config?: Partial<ApiRateMonitorConfig>): ApiRateMonitor {
  instance = new ApiRateMonitor(config);
  return instance;
}

/**
 * Get the global API rate monitor instance
 */
export function getApiRateMonitor(): ApiRateMonitor | null {
  return instance;
}

/**
 * Convenience function to record an API call
 */
export function recordApiCall(params: {
  provider: ApiProvider;
  endpoint: string;
  success: boolean;
  latencyMs?: number;
  errorCode?: string;
}): void {
  instance?.recordCall(params);
}

/**
 * Convenience function to record a missed trade
 */
export function recordMissedTrade(params: {
  type: TradeType;
  tokenId: string;
  reason: string;
  sizeUsd?: number;
}): void {
  instance?.recordMissedTrade(params);
}

/**
 * Convenience function to record a successful trade
 */
export function recordSuccessfulTrade(type: TradeType): void {
  instance?.recordSuccessfulTrade(type);
}

/**
 * Detect provider from URL
 */
export function detectProvider(url: string): ApiProvider {
  if (url.includes("infura.io")) return "infura";
  if (url.includes("clob.polymarket.com")) return "polymarket_clob";
  if (url.includes("data-api.polymarket.com")) return "polymarket_data";
  if (url.includes("gamma-api.polymarket.com")) return "polymarket_gamma";
  if (url.includes("api.github.com")) return "github";
  if (url.includes("api.telegram.org")) return "telegram";
  return "other";
}
