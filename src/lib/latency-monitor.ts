/**
 * Latency Monitor - Track connection speed and response times
 *
 * Monitors network latency to RPC and API endpoints to:
 * - Detect abnormal lag that could cause slippage losses
 * - Dynamically adjust slippage tolerance based on current conditions
 * - Warn when network conditions are degraded
 * - Log latency metrics for debugging trade execution issues
 *
 * CRITICAL: High latency between detecting a whale trade and executing
 * your copy trade can result in significant slippage or missed fills.
 */

import axios from "axios";
import { POLYMARKET_API } from "./constants";

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface LatencyMeasurement {
  endpoint: string;
  latencyMs: number;
  timestamp: number;
  success: boolean;
  error?: string;
}

export interface LatencyStats {
  endpoint: string;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  successRate: number;
  sampleCount: number;
  lastMeasured: number;
}

export interface NetworkHealth {
  status: "healthy" | "degraded" | "critical";
  rpcLatencyMs: number;
  apiLatencyMs: number;
  recommendedSlippagePct: number;
  warnings: string[];
  /** FAIL-SAFE: If true, trading should be BLOCKED to protect user funds */
  tradingBlocked: boolean;
  /** Reason why trading is blocked (if blocked) */
  blockReason?: string;
}

export interface LatencyMonitorConfig {
  /** RPC URL for blockchain calls */
  rpcUrl: string;
  /** How often to measure latency (ms) - default: 30000 (30s) */
  measureIntervalMs: number;
  /** Number of measurements to keep for stats - default: 100 */
  historySize: number;
  /** Latency threshold for "degraded" status (ms) - default: 500 */
  degradedThresholdMs: number;
  /** Latency threshold for "critical" status (ms) - default: 2000 */
  criticalThresholdMs: number;
  /** Latency threshold to BLOCK trading entirely (ms) - default: 5000 */
  blockTradingThresholdMs: number;
  /** Success rate below which trading is BLOCKED - default: 0.5 (50%) */
  blockTradingSuccessRate: number;
  /** Base slippage percentage - default: 2 */
  baseSlippagePct: number;
  /** Max slippage percentage even under bad conditions - default: 10 */
  maxSlippagePct: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// LATENCY MONITOR
// ═══════════════════════════════════════════════════════════════════════════

export class LatencyMonitor {
  private config: LatencyMonitorConfig;
  private measurements: Map<string, LatencyMeasurement[]> = new Map();
  private measureInterval: NodeJS.Timeout | null = null;
  private running = false;

  // Endpoint keys
  private readonly RPC_KEY = "rpc";
  private readonly CLOB_KEY = "clob";
  private readonly DATA_API_KEY = "data-api";

  constructor(config: Partial<LatencyMonitorConfig> = {}) {
    this.config = {
      rpcUrl: config.rpcUrl ?? process.env.RPC_URL ?? "https://polygon-rpc.com",
      measureIntervalMs: config.measureIntervalMs ?? 30000,
      historySize: config.historySize ?? 100,
      degradedThresholdMs: config.degradedThresholdMs ?? 500,
      criticalThresholdMs: config.criticalThresholdMs ?? 2000,
      blockTradingThresholdMs: config.blockTradingThresholdMs ?? 5000, // 5 seconds = BLOCK
      blockTradingSuccessRate: config.blockTradingSuccessRate ?? 0.5, // 50% success = BLOCK
      baseSlippagePct: config.baseSlippagePct ?? 2,
      maxSlippagePct: config.maxSlippagePct ?? 10,
    };
  }

  /**
   * Start periodic latency monitoring
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Initial measurement
    this.measureAll().catch(() => {});

    // Periodic measurements
    this.measureInterval = setInterval(() => {
      this.measureAll().catch(() => {});
    }, this.config.measureIntervalMs);

    console.log(`⏱️ Latency monitor started (interval: ${this.config.measureIntervalMs / 1000}s)`);
  }

  /**
   * Stop latency monitoring
   */
  stop(): void {
    this.running = false;
    if (this.measureInterval) {
      clearInterval(this.measureInterval);
      this.measureInterval = null;
    }
  }

  /**
   * Measure latency to a specific endpoint
   */
  async measureLatency(endpoint: string, measureFn: () => Promise<void>): Promise<LatencyMeasurement> {
    const start = performance.now();
    let success = true;
    let error: string | undefined;

    try {
      await measureFn();
    } catch (err) {
      success = false;
      error = err instanceof Error ? err.message : String(err);
    }

    const latencyMs = performance.now() - start;
    const measurement: LatencyMeasurement = {
      endpoint,
      latencyMs,
      timestamp: Date.now(),
      success,
      error,
    };

    this.recordMeasurement(endpoint, measurement);
    return measurement;
  }

  /**
   * Measure all monitored endpoints
   */
  async measureAll(): Promise<void> {
    await Promise.all([
      this.measureRpc(),
      this.measureClobApi(),
      this.measureDataApi(),
    ]);
  }

  /**
   * Measure RPC latency (blockchain calls)
   */
  async measureRpc(): Promise<LatencyMeasurement> {
    return this.measureLatency(this.RPC_KEY, async () => {
      await axios.post(
        this.config.rpcUrl,
        {
          jsonrpc: "2.0",
          method: "eth_blockNumber",
          params: [],
          id: 1,
        },
        { timeout: 10000 }
      );
    });
  }

  /**
   * Measure CLOB API latency (order book, trading)
   */
  async measureClobApi(): Promise<LatencyMeasurement> {
    return this.measureLatency(this.CLOB_KEY, async () => {
      // Just hit the server info endpoint - lightweight
      await axios.get(`${POLYMARKET_API.CLOB}/`, { timeout: 10000 });
    });
  }

  /**
   * Measure Data API latency (market data)
   */
  async measureDataApi(): Promise<LatencyMeasurement> {
    return this.measureLatency(this.DATA_API_KEY, async () => {
      await axios.get(`${POLYMARKET_API.DATA}/markets?limit=1`, { timeout: 10000 });
    });
  }

  /**
   * Record a measurement and maintain history size
   */
  private recordMeasurement(endpoint: string, measurement: LatencyMeasurement): void {
    if (!this.measurements.has(endpoint)) {
      this.measurements.set(endpoint, []);
    }

    const history = this.measurements.get(endpoint)!;
    history.push(measurement);

    // Trim to history size
    while (history.length > this.config.historySize) {
      history.shift();
    }
  }

  /**
   * Get statistics for an endpoint
   */
  getStats(endpoint: string): LatencyStats | null {
    const history = this.measurements.get(endpoint);
    if (!history || history.length === 0) return null;

    const successful = history.filter((m) => m.success);
    const latencies = successful.map((m) => m.latencyMs).sort((a, b) => a - b);

    if (latencies.length === 0) {
      return {
        endpoint,
        avgMs: 0,
        minMs: 0,
        maxMs: 0,
        p50Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
        successRate: 0,
        sampleCount: history.length,
        lastMeasured: history[history.length - 1].timestamp,
      };
    }

    const sum = latencies.reduce((a, b) => a + b, 0);
    const p50Index = Math.floor(latencies.length * 0.5);
    const p95Index = Math.floor(latencies.length * 0.95);
    const p99Index = Math.floor(latencies.length * 0.99);

    return {
      endpoint,
      avgMs: sum / latencies.length,
      minMs: latencies[0],
      maxMs: latencies[latencies.length - 1],
      p50Ms: latencies[p50Index] ?? latencies[latencies.length - 1],
      p95Ms: latencies[p95Index] ?? latencies[latencies.length - 1],
      p99Ms: latencies[p99Index] ?? latencies[latencies.length - 1],
      successRate: successful.length / history.length,
      sampleCount: history.length,
      lastMeasured: history[history.length - 1].timestamp,
    };
  }

  /**
   * Get current network health status
   */
  getNetworkHealth(): NetworkHealth {
    const rpcStats = this.getStats(this.RPC_KEY);
    const clobStats = this.getStats(this.CLOB_KEY);

    const rpcLatency = rpcStats?.p95Ms ?? 0;
    const apiLatency = clobStats?.p95Ms ?? 0;
    const maxLatency = Math.max(rpcLatency, apiLatency);

    const warnings: string[] = [];
    let status: "healthy" | "degraded" | "critical" = "healthy";

    // Helper to update status (never downgrade from critical)
    const setStatus = (newStatus: "degraded" | "critical") => {
      if (status === "critical") return; // Never downgrade from critical
      status = newStatus;
    };

    // Check RPC health
    if (rpcStats) {
      if (rpcStats.successRate < 0.9) {
        warnings.push(`RPC success rate low: ${(rpcStats.successRate * 100).toFixed(0)}%`);
        setStatus("degraded");
      }
      if (rpcLatency > this.config.criticalThresholdMs) {
        warnings.push(`RPC latency critical: ${rpcLatency.toFixed(0)}ms`);
        setStatus("critical");
      } else if (rpcLatency > this.config.degradedThresholdMs) {
        warnings.push(`RPC latency high: ${rpcLatency.toFixed(0)}ms`);
        setStatus("degraded");
      }
    }

    // Check CLOB API health
    if (clobStats) {
      if (clobStats.successRate < 0.9) {
        warnings.push(`CLOB API success rate low: ${(clobStats.successRate * 100).toFixed(0)}%`);
        setStatus("degraded");
      }
      if (apiLatency > this.config.criticalThresholdMs) {
        warnings.push(`CLOB API latency critical: ${apiLatency.toFixed(0)}ms`);
        setStatus("critical");
      } else if (apiLatency > this.config.degradedThresholdMs) {
        warnings.push(`CLOB API latency high: ${apiLatency.toFixed(0)}ms`);
        setStatus("degraded");
      }
    }

    // Calculate recommended slippage based on latency
    // Higher latency = more slippage needed to fill orders
    const recommendedSlippagePct = this.calculateRecommendedSlippage(maxLatency);

    // ═══════════════════════════════════════════════════════════════════════
    // FAIL-SAFE: Determine if trading should be BLOCKED to protect funds
    // ═══════════════════════════════════════════════════════════════════════
    let tradingBlocked = false;
    let blockReason: string | undefined;

    // Block if latency exceeds safety threshold
    if (maxLatency > this.config.blockTradingThresholdMs) {
      tradingBlocked = true;
      blockReason = `Latency too high (${maxLatency.toFixed(0)}ms > ${this.config.blockTradingThresholdMs}ms threshold)`;
      warnings.push(`🚨 TRADING BLOCKED: ${blockReason}`);
    }

    // Block if success rate is too low (network is unreliable)
    const rpcSuccessRate = rpcStats?.successRate ?? 1;
    const apiSuccessRate = clobStats?.successRate ?? 1;
    const minSuccessRate = Math.min(rpcSuccessRate, apiSuccessRate);
    
    if (minSuccessRate < this.config.blockTradingSuccessRate) {
      tradingBlocked = true;
      blockReason = `Network unreliable (${(minSuccessRate * 100).toFixed(0)}% success rate < ${(this.config.blockTradingSuccessRate * 100).toFixed(0)}% threshold)`;
      warnings.push(`🚨 TRADING BLOCKED: ${blockReason}`);
    }

    // Block if we have no measurements yet (can't assess risk)
    if (!rpcStats && !clobStats) {
      tradingBlocked = true;
      blockReason = "No network measurements yet - waiting for latency data";
      warnings.push(`⏳ TRADING BLOCKED: ${blockReason}`);
    }

    return {
      status,
      rpcLatencyMs: rpcLatency,
      apiLatencyMs: apiLatency,
      recommendedSlippagePct,
      warnings,
      tradingBlocked,
      blockReason,
    };
  }

  /**
   * Quick check if trading is safe - use this before any trade!
   */
  isTradingSafe(): { safe: boolean; reason?: string } {
    const health = this.getNetworkHealth();
    if (health.tradingBlocked) {
      return { safe: false, reason: health.blockReason };
    }
    return { safe: true };
  }

  /**
   * Calculate recommended slippage based on current latency
   * 
   * Logic:
   * - Base latency (< 200ms): Use base slippage
   * - High latency (200-1000ms): Linear increase
   * - Critical latency (> 1000ms): Approach max slippage
   */
  calculateRecommendedSlippage(latencyMs: number): number {
    const { baseSlippagePct, maxSlippagePct, degradedThresholdMs, criticalThresholdMs } = this.config;

    if (latencyMs <= 200) {
      return baseSlippagePct;
    }

    if (latencyMs >= criticalThresholdMs) {
      return maxSlippagePct;
    }

    // Linear interpolation between base and max
    const ratio = (latencyMs - 200) / (criticalThresholdMs - 200);
    return baseSlippagePct + ratio * (maxSlippagePct - baseSlippagePct);
  }

  /**
   * Get a summary string for logging
   */
  getSummary(): string {
    const health = this.getNetworkHealth();
    const statusEmoji = health.status === "healthy" ? "🟢" : health.status === "degraded" ? "🟡" : "🔴";
    
    return `${statusEmoji} Network: ${health.status.toUpperCase()} | ` +
      `RPC: ${health.rpcLatencyMs.toFixed(0)}ms | ` +
      `API: ${health.apiLatencyMs.toFixed(0)}ms | ` +
      `Slippage: ${health.recommendedSlippagePct.toFixed(1)}%`;
  }

  /**
   * Log detailed latency report
   */
  logReport(): void {
    const health = this.getNetworkHealth();
    const rpcStats = this.getStats(this.RPC_KEY);
    const clobStats = this.getStats(this.CLOB_KEY);
    const dataStats = this.getStats(this.DATA_API_KEY);

    console.log("");
    console.log("⏱️ LATENCY REPORT");
    console.log("═".repeat(50));
    console.log(`   Status: ${health.status.toUpperCase()}`);
    console.log(`   Recommended Slippage: ${health.recommendedSlippagePct.toFixed(1)}%`);
    console.log("");

    if (rpcStats) {
      console.log(`   RPC (${this.config.rpcUrl.slice(0, 30)}...)`);
      console.log(`      Avg: ${rpcStats.avgMs.toFixed(0)}ms | P95: ${rpcStats.p95Ms.toFixed(0)}ms | Success: ${(rpcStats.successRate * 100).toFixed(0)}%`);
    }

    if (clobStats) {
      console.log(`   CLOB API`);
      console.log(`      Avg: ${clobStats.avgMs.toFixed(0)}ms | P95: ${clobStats.p95Ms.toFixed(0)}ms | Success: ${(clobStats.successRate * 100).toFixed(0)}%`);
    }

    if (dataStats) {
      console.log(`   Data API`);
      console.log(`      Avg: ${dataStats.avgMs.toFixed(0)}ms | P95: ${dataStats.p95Ms.toFixed(0)}ms | Success: ${(dataStats.successRate * 100).toFixed(0)}%`);
    }

    if (health.warnings.length > 0) {
      console.log("");
      console.log("   ⚠️ Warnings:");
      for (const warning of health.warnings) {
        console.log(`      - ${warning}`);
      }
    }

    console.log("═".repeat(50));
    console.log("");
  }

  /**
   * Measure and return execution latency for a trade operation
   * Use this to wrap actual trade execution and track timing
   */
  async measureTradeExecution<T>(
    operation: string,
    fn: () => Promise<T>
  ): Promise<{ result: T; latencyMs: number }> {
    const start = performance.now();
    const result = await fn();
    const latencyMs = performance.now() - start;

    // Record as a custom measurement
    this.recordMeasurement(`trade:${operation}`, {
      endpoint: `trade:${operation}`,
      latencyMs,
      timestamp: Date.now(),
      success: true,
    });

    // Warn if trade execution was slow
    if (latencyMs > this.config.degradedThresholdMs) {
      console.warn(`⚠️ Slow ${operation}: ${latencyMs.toFixed(0)}ms - consider increasing slippage`);
    }

    return { result, latencyMs };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════════════════

let globalLatencyMonitor: LatencyMonitor | null = null;

/**
 * Get the global latency monitor instance
 */
export function getLatencyMonitor(): LatencyMonitor {
  if (!globalLatencyMonitor) {
    globalLatencyMonitor = new LatencyMonitor();
  }
  return globalLatencyMonitor;
}

/**
 * Initialize the latency monitor with custom config
 */
export function initLatencyMonitor(config: Partial<LatencyMonitorConfig>): LatencyMonitor {
  globalLatencyMonitor = new LatencyMonitor(config);
  return globalLatencyMonitor;
}
