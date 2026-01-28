/**
 * Market Scanner - Simplified market discovery module
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PURPOSE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The scanner exists to FIND TABLES, not to predict outcomes.
 *
 * This component does NOT place trades. It only produces candidate markets/tokens
 * for the execution engine to evaluate. The execution engine is responsible for
 * saying "no."
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ALLOWED SIGNAL TYPES (Minimal, Explainable, Robust)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1) PRICE MOVEMENT
 *    - Detect midprice movement >= ENTRY_BAND_CENTS within SCAN_WINDOW_SECONDS
 *
 * 2) LIQUIDITY PRESENCE
 *    - spread <= MIN_SPREAD_CENTS
 *    - depth >= MIN_DEPTH_USD_AT_EXIT
 *
 * 3) LEADERBOARD ACTIVITY (OPTIONAL BOOST)
 *    - At least SCAN_MIN_LEADERBOARD_TRADES from watched wallets
 *      within SCAN_LEADERBOARD_WINDOW_SECONDS
 *
 * 4) SAFE PRICE ZONE
 *    - Price within PREFERRED_ENTRY_LOW_CENTS to PREFERRED_ENTRY_HIGH_CENTS
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FORBIDDEN (DO NOT ADD)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * - No ML
 * - No prediction
 * - No sentiment
 * - No multi-factor scoring
 * - No confidence weighting
 * - No valuation heuristics
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PHILOSOPHY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Be boring. Be defensive. Be minimal.
 * Prefer false negatives over false positives.
 * If uncertain, output nothing.
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Reason why a market was selected as a candidate
 *
 * - "movement": Significant price movement detected (>= entryBandCents)
 * - "leaderboard": Activity from watched wallets (optional boost when enabled)
 *
 * Note: Liquidity is a GATE, not a REASON. Markets must have sufficient
 * liquidity to be candidates, but liquidity alone doesn't trigger selection.
 */
export type ScannerReason = "movement" | "leaderboard";

/** A candidate market/token output by the scanner */
export interface ScannerCandidate {
  /** Market ID from Polymarket */
  marketId: string;
  /** Token ID (YES or NO token) */
  tokenId: string;
  /** Why this market was selected */
  reason: ScannerReason;
  /** When this candidate was generated (Unix timestamp ms) */
  timestamp: number;
}

/** Scanner configuration */
export interface ScannerConfig {
  /** Enable/disable scanner entirely */
  enabled: boolean;

  // Price movement detection
  /** Minimum price movement in cents to trigger (default: 12) */
  entryBandCents: number;
  /** Time window for price movement detection in seconds (default: 300) */
  scanWindowSeconds: number;

  // Liquidity presence
  /** Maximum acceptable spread in cents (markets with wider spread are rejected, default: 6) */
  maxSpreadCents: number;
  /** Minimum depth in USD at exit (default: 25) */
  minDepthUsdAtExit: number;

  // Safe price zone
  /** Minimum price in cents (default: 35) */
  preferredEntryLowCents: number;
  /** Maximum price in cents (default: 65) */
  preferredEntryHighCents: number;

  // Leaderboard activity boost (optional)
  /** Enable leaderboard activity boost (default: false) */
  leaderboardBoostEnabled: boolean;
  /** Minimum trades from watched wallets (default: 1) */
  scanMinLeaderboardTrades: number;
  /** Time window for leaderboard activity in seconds (default: 300) */
  scanLeaderboardWindowSeconds: number;

  // Deduplication
  /** How long to dedupe candidates in seconds (default: 300) */
  deduplicationWindowSeconds: number;
}

/** Default scanner configuration */
export const DEFAULT_SCANNER_CONFIG: ScannerConfig = {
  enabled: true,

  // Price movement detection
  entryBandCents: 12,
  scanWindowSeconds: 300,

  // Liquidity presence
  maxSpreadCents: 6,
  minDepthUsdAtExit: 25,

  // Safe price zone
  preferredEntryLowCents: 35,
  preferredEntryHighCents: 65,

  // Leaderboard activity boost
  leaderboardBoostEnabled: false,
  scanMinLeaderboardTrades: 1,
  scanLeaderboardWindowSeconds: 300,

  // Deduplication
  deduplicationWindowSeconds: 300,
};

/** Price history entry */
interface PriceEntry {
  midCents: number;
  timestamp: number;
}

/** Leaderboard trade entry */
interface LeaderboardTradeEntry {
  tokenId: string;
  timestamp: number;
}

/** Market data input for evaluation */
export interface MarketDataInput {
  tokenId: string;
  marketId: string;
  /** Mid price in cents (0-100) */
  midPriceCents: number;
  /** Spread in cents */
  spreadCents: number;
  /** Bid depth in USD */
  bidDepthUsd: number;
  /** Ask depth in USD */
  askDepthUsd: number;
}

// ============================================================================
// MarketScanner Implementation
// ============================================================================

export class MarketScanner {
  private readonly config: ScannerConfig;

  // Price history per token for movement detection
  private readonly priceHistory = new Map<string, PriceEntry[]>();

  // Track access order for LRU eviction of price history
  private readonly priceHistoryAccessOrder: string[] = [];

  // Leaderboard trade history for boost detection
  private readonly leaderboardTrades: LeaderboardTradeEntry[] = [];

  // Deduplication: track recent candidates
  private readonly recentCandidates = new Map<string, number>();

  // Maximum entries to prevent unbounded memory growth
  private readonly MAX_PRICE_HISTORY_ENTRIES = 100;
  private readonly MAX_TRACKED_TOKENS = 500;
  private readonly MAX_LEADERBOARD_ENTRIES = 500;
  private readonly MAX_DEDUP_ENTRIES = 1000;

  constructor(config: Partial<ScannerConfig> = {}) {
    this.config = { ...DEFAULT_SCANNER_CONFIG, ...config };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Public API
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if the scanner is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Evaluate a market and return a candidate if it passes all filters
   *
   * @param data - Current market data
   * @returns ScannerCandidate if market passes filters, null otherwise
   */
  evaluate(data: MarketDataInput): ScannerCandidate | null {
    if (!this.config.enabled) {
      return null;
    }

    const now = Date.now();

    // Update price history
    this.recordPrice(data.tokenId, data.midPriceCents, now);

    // Check deduplication - already output this candidate recently?
    if (this.isDuplicate(data.tokenId, now)) {
      return null;
    }

    // 1. SAFE PRICE ZONE - filter first (fast rejection)
    if (!this.isInSafePriceZone(data.midPriceCents)) {
      return null;
    }

    // 2. LIQUIDITY PRESENCE - required for all candidates
    if (!this.hasLiquidity(data)) {
      return null;
    }

    // 3. PRICE MOVEMENT - detect if significant movement occurred
    const hasMovement = this.hasPriceMovement(data.tokenId, now);

    // 4. LEADERBOARD ACTIVITY (optional boost)
    const hasLeaderboardActivity = this.hasLeaderboardActivity(
      data.tokenId,
      now,
    );

    // Determine reason (priority: movement > leaderboard > liquidity)
    let reason: ScannerReason;
    if (hasMovement) {
      reason = "movement";
    } else if (hasLeaderboardActivity) {
      reason = "leaderboard";
    } else {
      // Has liquidity but no movement or leaderboard - don't output
      // This ensures we only output when there's an actionable signal
      return null;
    }

    // Create candidate
    const candidate: ScannerCandidate = {
      marketId: data.marketId,
      tokenId: data.tokenId,
      reason,
      timestamp: now,
    };

    // Mark as recently output for deduplication
    this.markAsOutput(data.tokenId, now);

    return candidate;
  }

  /**
   * Record a leaderboard trade for activity tracking
   *
   * @param tokenId - Token that was traded
   * @param timestamp - When the trade occurred (default: now)
   */
  recordLeaderboardTrade(
    tokenId: string,
    timestamp: number = Date.now(),
  ): void {
    this.leaderboardTrades.push({ tokenId, timestamp });

    // Prune old entries to prevent memory growth
    if (this.leaderboardTrades.length > this.MAX_LEADERBOARD_ENTRIES) {
      const cutoff =
        Date.now() - this.config.scanLeaderboardWindowSeconds * 1000;
      const pruned = this.leaderboardTrades.filter((t) => t.timestamp > cutoff);
      this.leaderboardTrades.length = 0;
      this.leaderboardTrades.push(
        ...pruned.slice(-this.MAX_LEADERBOARD_ENTRIES),
      );
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): Readonly<ScannerConfig> {
    return { ...this.config };
  }

  /**
   * Clear all state (for testing)
   */
  clear(): void {
    this.priceHistory.clear();
    this.priceHistoryAccessOrder.length = 0;
    this.leaderboardTrades.length = 0;
    this.recentCandidates.clear();
  }

  /**
   * Get scanner statistics
   */
  getStats(): {
    trackedTokens: number;
    leaderboardTradesInWindow: number;
    recentCandidatesCount: number;
  } {
    const now = Date.now();
    const leaderboardCutoff =
      now - this.config.scanLeaderboardWindowSeconds * 1000;

    return {
      trackedTokens: this.priceHistory.size,
      leaderboardTradesInWindow: this.leaderboardTrades.filter(
        (t) => t.timestamp > leaderboardCutoff,
      ).length,
      recentCandidatesCount: this.recentCandidates.size,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private - Signal Detection
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if price is in safe zone
   */
  private isInSafePriceZone(midPriceCents: number): boolean {
    return (
      midPriceCents >= this.config.preferredEntryLowCents &&
      midPriceCents <= this.config.preferredEntryHighCents
    );
  }

  /**
   * Check if market has sufficient liquidity
   *
   * Note: We check bid depth because exits are sells. The scanner
   * doesn't know whether execution will buy or sell, but exits
   * (taking profit or cutting losses) require selling into bids.
   */
  private hasLiquidity(data: MarketDataInput): boolean {
    // Spread must be tight enough (reject wide spreads)
    if (data.spreadCents > this.config.maxSpreadCents) {
      return false;
    }

    // Must have depth on exit side (bid side for selling)
    if (data.bidDepthUsd < this.config.minDepthUsdAtExit) {
      return false;
    }

    return true;
  }

  /**
   * Check if significant price movement occurred within window
   */
  private hasPriceMovement(tokenId: string, now: number): boolean {
    const history = this.priceHistory.get(tokenId);
    if (!history || history.length < 2) {
      return false;
    }

    const cutoff = now - this.config.scanWindowSeconds * 1000;
    const recentPrices = history.filter((p) => p.timestamp > cutoff);

    if (recentPrices.length < 2) {
      return false;
    }

    // Find min and max within window
    let min = recentPrices[0].midCents;
    let max = recentPrices[0].midCents;

    for (const entry of recentPrices) {
      if (entry.midCents < min) min = entry.midCents;
      if (entry.midCents > max) max = entry.midCents;
    }

    const movement = max - min;
    return movement >= this.config.entryBandCents;
  }

  /**
   * Check if there's recent leaderboard activity on this token
   */
  private hasLeaderboardActivity(tokenId: string, now: number): boolean {
    if (!this.config.leaderboardBoostEnabled) {
      return false;
    }

    const cutoff = now - this.config.scanLeaderboardWindowSeconds * 1000;
    const recentTrades = this.leaderboardTrades.filter(
      (t) => t.tokenId === tokenId && t.timestamp > cutoff,
    );

    return recentTrades.length >= this.config.scanMinLeaderboardTrades;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private - Price History Management
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Record a price observation
   */
  private recordPrice(
    tokenId: string,
    midCents: number,
    timestamp: number,
  ): void {
    let history = this.priceHistory.get(tokenId);
    const isNewToken = !history;

    if (!history) {
      history = [];
      this.priceHistory.set(tokenId, history);
    }

    history.push({ midCents, timestamp });

    // Prune old entries
    const cutoff = timestamp - this.config.scanWindowSeconds * 1000 * 2; // Keep 2x window
    const pruned = history.filter((p) => p.timestamp > cutoff);

    if (pruned.length > this.MAX_PRICE_HISTORY_ENTRIES) {
      this.priceHistory.set(
        tokenId,
        pruned.slice(-this.MAX_PRICE_HISTORY_ENTRIES),
      );
    } else {
      this.priceHistory.set(tokenId, pruned);
    }

    // Update LRU access order for memory protection
    this.touchToken(tokenId, isNewToken);

    // LRU eviction: remove least recently used tokens if over limit
    while (this.priceHistory.size > this.MAX_TRACKED_TOKENS) {
      const lruToken = this.priceHistoryAccessOrder.shift();
      if (lruToken) {
        this.priceHistory.delete(lruToken);
      }
    }
  }

  /**
   * Update LRU access order for a token
   */
  private touchToken(tokenId: string, isNew: boolean): void {
    if (!isNew) {
      // Remove from current position
      const idx = this.priceHistoryAccessOrder.indexOf(tokenId);
      if (idx !== -1) {
        this.priceHistoryAccessOrder.splice(idx, 1);
      }
    }
    // Add to end (most recently used)
    this.priceHistoryAccessOrder.push(tokenId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private - Deduplication
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if this token was recently output as a candidate
   */
  private isDuplicate(tokenId: string, now: number): boolean {
    const lastOutput = this.recentCandidates.get(tokenId);
    if (!lastOutput) {
      return false;
    }

    const windowMs = this.config.deduplicationWindowSeconds * 1000;
    return now - lastOutput < windowMs;
  }

  /**
   * Mark a token as recently output
   */
  private markAsOutput(tokenId: string, now: number): void {
    this.recentCandidates.set(tokenId, now);

    // Prune old entries to prevent memory growth
    if (this.recentCandidates.size > this.MAX_DEDUP_ENTRIES) {
      const cutoff = now - this.config.deduplicationWindowSeconds * 1000;
      for (const [key, timestamp] of this.recentCandidates.entries()) {
        if (timestamp < cutoff) {
          this.recentCandidates.delete(key);
        }
      }
    }
  }
}

// ============================================================================
// Configuration Loading
// ============================================================================

/**
 * Load scanner configuration from environment variables
 */
export function loadScannerConfig(): ScannerConfig {
  const envBool = (key: string, def: boolean): boolean => {
    const v = process.env[key];
    return v === undefined ? def : v.toLowerCase() === "true" || v === "1";
  };

  const envNum = (key: string, def: number): number => {
    const v = process.env[key];
    if (v === undefined) return def;
    const n = parseFloat(v);
    return isNaN(n) ? def : n;
  };

  return {
    enabled: envBool("SCANNER_ENABLED", DEFAULT_SCANNER_CONFIG.enabled),

    // Price movement detection
    entryBandCents: envNum(
      "SCANNER_ENTRY_BAND_CENTS",
      DEFAULT_SCANNER_CONFIG.entryBandCents,
    ),
    scanWindowSeconds: envNum(
      "SCANNER_WINDOW_SECONDS",
      DEFAULT_SCANNER_CONFIG.scanWindowSeconds,
    ),

    // Liquidity presence
    maxSpreadCents: envNum(
      "SCANNER_MAX_SPREAD_CENTS",
      DEFAULT_SCANNER_CONFIG.maxSpreadCents,
    ),
    minDepthUsdAtExit: envNum(
      "SCANNER_MIN_DEPTH_USD",
      DEFAULT_SCANNER_CONFIG.minDepthUsdAtExit,
    ),

    // Safe price zone
    preferredEntryLowCents: envNum(
      "SCANNER_PREFERRED_ENTRY_LOW_CENTS",
      DEFAULT_SCANNER_CONFIG.preferredEntryLowCents,
    ),
    preferredEntryHighCents: envNum(
      "SCANNER_PREFERRED_ENTRY_HIGH_CENTS",
      DEFAULT_SCANNER_CONFIG.preferredEntryHighCents,
    ),

    // Leaderboard activity boost
    leaderboardBoostEnabled: envBool(
      "SCANNER_LEADERBOARD_BOOST_ENABLED",
      DEFAULT_SCANNER_CONFIG.leaderboardBoostEnabled,
    ),
    scanMinLeaderboardTrades: envNum(
      "SCANNER_MIN_LEADERBOARD_TRADES",
      DEFAULT_SCANNER_CONFIG.scanMinLeaderboardTrades,
    ),
    scanLeaderboardWindowSeconds: envNum(
      "SCANNER_LEADERBOARD_WINDOW_SECONDS",
      DEFAULT_SCANNER_CONFIG.scanLeaderboardWindowSeconds,
    ),

    // Deduplication
    deduplicationWindowSeconds: envNum(
      "SCANNER_DEDUP_WINDOW_SECONDS",
      DEFAULT_SCANNER_CONFIG.deduplicationWindowSeconds,
    ),
  };
}

// ============================================================================
// Singleton Instance
// ============================================================================

let globalScanner: MarketScanner | null = null;

/**
 * Get the global MarketScanner instance
 */
export function getMarketScanner(): MarketScanner {
  if (!globalScanner) {
    globalScanner = new MarketScanner(loadScannerConfig());
  }
  return globalScanner;
}

/**
 * Initialize a new global MarketScanner (for testing or reset)
 */
export function initMarketScanner(
  config?: Partial<ScannerConfig>,
): MarketScanner {
  globalScanner = new MarketScanner(config);
  return globalScanner;
}

/**
 * Check if global scanner is initialized
 */
export function isMarketScannerInitialized(): boolean {
  return globalScanner !== null;
}
