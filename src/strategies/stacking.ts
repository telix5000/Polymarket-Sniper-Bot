/**
 * Stacking Strategy (Refactored)
 *
 * Allows "stacking" (doubling down) on winning positions that are up significantly
 * from their entry price. This is a momentum-based strategy that capitalizes on
 * positions that are clearly trending in the right direction.
 *
 * REFACTORED DESIGN (Jan 2025):
 * - Fetches positions directly via PolymarketClient (no PositionTracker dependency)
 * - Checks order history to detect if already stacked (looks for multiple BUYs)
 * - Simple logic: position up? not stacked before? → stack once
 * - No caching - always uses fresh API data for decisions
 *
 * LOGIC:
 * 1. Fetch fresh positions from Data API
 * 2. Position must be up at least MIN_GAIN_CENTS (default: 20¢) from entry price
 * 3. Check order history - if 2+ BUY orders exist, already stacked → skip
 * 4. Position must be profitable (not in loss)
 * 5. Reserves must allow the additional investment
 * 6. Stack amount is MAX_POSITION_USD
 *
 * ALREADY STACKED DETECTION:
 * Uses order history from API instead of in-memory maps. If a tokenId has
 * 2 or more BUY orders in its trade history, it has been stacked before.
 * This survives container restarts and is always accurate.
 *
 * ENV: POSITION_STACKING_ENABLED=true (default)
 */

import type { ClobClient } from "@polymarket/clob-client";
import type { Wallet } from "ethers";
import type { ConsoleLogger } from "../utils/logger.util";
import { PolymarketClient, type ApiPosition } from "../api/polymarket-client";
import { postOrder } from "../utils/post-order.util";
import { isLiveTradingEnabled } from "../utils/live-trading.util";
import type { ReservePlan } from "../risk";
import { LogDeduper } from "../utils/log-deduper.util";
import { notifyStack } from "../services/trade-notification.service";

/**
 * Stacking Configuration
 */
export interface StackingConfig {
  /** Enable the strategy (default: true) */
  enabled: boolean;

  /**
   * Minimum gain in cents from entry price to allow stacking (default: 20)
   * Position must be up at least this many cents from avgPriceCents
   */
  minGainCents: number;

  /**
   * Maximum USD per stack (from MAX_POSITION_USD)
   * This is the amount used when stacking a position
   */
  maxStackUsd: number;

  /**
   * Minimum profit percentage required (default: 0)
   * Additional safeguard - position must be in profit
   * Set to 0 to only use minGainCents
   */
  minProfitPct: number;

  /**
   * Maximum current price to allow stacking (default: 0.95 = 95¢)
   * Prevents stacking on positions that are already near $1
   * (those positions have limited upside)
   */
  maxCurrentPrice: number;

  /**
   * Cooldown in milliseconds after stacking before allowing another check (default: 60000)
   * Prevents rapid-fire stacking attempts on the same position
   */
  cooldownMs: number;
}

export const DEFAULT_STACKING_CONFIG: StackingConfig = {
  enabled: true,
  minGainCents: 20,
  maxStackUsd: 25,
  minProfitPct: 0,
  maxCurrentPrice: 0.95,
  cooldownMs: 60000,
};

/**
 * Tracking entry for a successfully stacked position in this session
 */
interface StackedPositionEntry {
  tokenId: string;
  conditionId: string;
  stackedAtMs: number;
  stackedAtPrice: number;
  stackedAmountUsd: number;
  entryPriceCents: number;
  gainCentsAtStack: number;
}

/**
 * Stacking Strategy
 *
 * Uses fresh API data for all decisions. No dependency on PositionTracker snapshots.
 */
export class StackingStrategy {
  private client: ClobClient;
  private apiClient: PolymarketClient;
  private logger: ConsoleLogger;
  private config: StackingConfig;
  private walletAddress: string;

  // === SINGLE-FLIGHT GUARD ===
  private inFlight = false;

  // === SESSION STACKING TRACKING ===
  // Tracks positions stacked in THIS session (fast lookup)
  // Real "already stacked" detection uses order history API
  private sessionStackedPositions: Map<string, StackedPositionEntry> =
    new Map();

  // === COOLDOWN TRACKING ===
  // Key = tokenId, value = timestamp when cooldown expires
  private cooldowns: Map<string, number> = new Map();

  // === LOG DEDUPLICATION ===
  private logDeduper = new LogDeduper();
  private static readonly SKIP_LOG_TTL_MS = 60_000;
  private static readonly MIN_STACK_USD = 1;

  // === PER-CYCLE STACKING BUDGET ===
  private cycleStackBudgetRemaining: number | null = null;

  constructor(config: {
    client: ClobClient;
    logger: ConsoleLogger;
    config: StackingConfig;
    walletAddress: string;
  }) {
    this.client = config.client;
    this.logger = config.logger;
    this.config = config.config;
    this.walletAddress = config.walletAddress;

    // Create API client for direct data access
    this.apiClient = new PolymarketClient({ logger: this.logger });

    this.logger.info(
      `[Stacking] Initialized: enabled=${this.config.enabled}, ` +
        `minGainCents=${this.config.minGainCents}¢, maxStackUsd=$${this.config.maxStackUsd}`,
    );
  }

  /**
   * Execute the strategy
   *
   * SINGLE-FLIGHT: Skips if already running (returns 0)
   *
   * @param reservePlan Optional reserve plan for budget-aware stacking
   */
  async execute(reservePlan?: ReservePlan): Promise<number> {
    if (!this.config.enabled) {
      return 0;
    }

    // Initialize per-cycle stacking budget from available cash
    if (reservePlan) {
      this.cycleStackBudgetRemaining = reservePlan.availableCash;

      if (reservePlan.mode === "RISK_OFF") {
        if (
          this.logDeduper.shouldLog(
            "Stacking:using_reserves",
            StackingStrategy.SKIP_LOG_TTL_MS,
          )
        ) {
          this.logger.info(
            `[Stacking] 💰 Using reserves for stacking: available=$${reservePlan.availableCash.toFixed(2)}, ` +
              `reserveRequired=$${reservePlan.reserveRequired.toFixed(2)}, shortfall=$${reservePlan.shortfall.toFixed(2)}`,
          );
        }
      }
    } else {
      this.cycleStackBudgetRemaining = null;
    }

    // Single-flight guard
    if (this.inFlight) {
      this.logger.debug("[Stacking] Skipped - already in flight");
      return 0;
    }

    this.inFlight = true;
    try {
      return await this.executeInternal();
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Internal execution logic
   */
  private async executeInternal(): Promise<number> {
    // Clean up expired cooldowns
    this.cleanupCooldowns();

    // Get positions from API client (cached, only active positions)
    // The API client handles caching and filtering out complete/redeemable
    const positions = await this.apiClient.getPositions(this.walletAddress);

    if (positions.length === 0) {
      return 0;
    }

    this.logger.debug(
      `[Stacking] 📊 ${positions.length} active positions from cache/API`,
    );

    let stackedCount = 0;

    for (const position of positions) {
      // Skip if stacked in this session
      if (this.sessionStackedPositions.has(position.tokenId)) {
        continue;
      }

      // Skip if on cooldown
      if (this.isOnCooldown(position.tokenId)) {
        continue;
      }

      // Check if position is eligible for stacking
      const eligibility = this.checkEligibility(position);
      if (!eligibility.eligible) {
        if (
          this.logDeduper.shouldLog(
            `Stacking:skip:${position.tokenId}`,
            StackingStrategy.SKIP_LOG_TTL_MS,
          )
        ) {
          this.logger.debug(
            `[Stacking] Skip ${position.tokenId.slice(0, 8)}...: ${eligibility.reason}`,
          );
        }
        continue;
      }

      // Check order history to see if already stacked (2+ BUY orders)
      const alreadyStacked = await this.apiClient.hasBeenStacked(
        this.walletAddress,
        position.tokenId,
      );

      if (alreadyStacked) {
        if (
          this.logDeduper.shouldLog(
            `Stacking:already:${position.tokenId}`,
            StackingStrategy.SKIP_LOG_TTL_MS,
          )
        ) {
          this.logger.info(
            `[Stacking] 🔒 ${position.tokenId.slice(0, 8)}... already stacked (detected via order history)`,
          );
        }
        continue;
      }

      // Attempt to stack the position
      const stacked = await this.stackPosition(position, eligibility.gainCents);
      if (stacked) {
        stackedCount++;
      }

      // Set cooldown regardless of success to prevent rapid retries
      this.setCooldown(position.tokenId);
    }

    if (stackedCount > 0) {
      this.logger.info(`[Stacking] ✅ Stacked ${stackedCount} position(s)`);
    }

    return stackedCount;
  }

  /**
   * Check if a position is eligible for stacking
   */
  private checkEligibility(position: ApiPosition): {
    eligible: boolean;
    reason: string;
    gainCents: number;
  } {
    // Must have entry price data (API provides avgPrice)
    if (position.avgPrice <= 0) {
      return {
        eligible: false,
        reason: "NO_ENTRY_PRICE",
        gainCents: 0,
      };
    }

    // Must be in profit (not losing)
    if (position.percentPnl < this.config.minProfitPct) {
      return {
        eligible: false,
        reason: `NOT_PROFITABLE_${position.percentPnl.toFixed(1)}%`,
        gainCents: 0,
      };
    }

    // Calculate gain in cents from entry
    const gainCents = position.curPriceCents - position.avgPriceCents;

    // Must be up at least minGainCents from entry
    if (gainCents < this.config.minGainCents) {
      return {
        eligible: false,
        reason: `GAIN_TOO_LOW_${gainCents.toFixed(1)}¢<${this.config.minGainCents}¢`,
        gainCents,
      };
    }

    // Must not be near $1 (limited upside)
    if (position.curPrice >= this.config.maxCurrentPrice) {
      return {
        eligible: false,
        reason: `PRICE_TOO_HIGH_${position.curPriceCents.toFixed(1)}¢>=${(this.config.maxCurrentPrice * 100).toFixed(0)}¢`,
        gainCents,
      };
    }

    return {
      eligible: true,
      reason: "ELIGIBLE",
      gainCents,
    };
  }

  /**
   * Apply budget-aware sizing to a stack amount.
   */
  private applyBudgetAwareSizing(
    computedUsd: number,
  ):
    | { skip: true; reason: string }
    | { skip: false; cappedUsd: number; isPartial: boolean } {
    if (this.cycleStackBudgetRemaining === null) {
      return { skip: false, cappedUsd: computedUsd, isPartial: false };
    }

    const minStackUsd = StackingStrategy.MIN_STACK_USD;

    if (this.cycleStackBudgetRemaining < computedUsd) {
      const cappedUsd = this.cycleStackBudgetRemaining;
      if (cappedUsd >= minStackUsd) {
        this.logger.info(
          `[Stacking] 📉 PARTIAL STACK: Capping from $${computedUsd.toFixed(2)} to $${cappedUsd.toFixed(2)} (available cash)`,
        );
        return { skip: false, cappedUsd, isPartial: true };
      }
      this.logger.info(
        `[Stacking] 📋 Stack skipped: available=$${cappedUsd.toFixed(2)} < minStack=$${minStackUsd} (insufficient funds)`,
      );
      return { skip: true, reason: "INSUFFICIENT_FUNDS" };
    }

    return { skip: false, cappedUsd: computedUsd, isPartial: false };
  }

  /**
   * Deduct an amount from the per-cycle stacking budget after a successful stack.
   */
  private deductFromCycleStackBudget(amountUsd: number): void {
    if (this.cycleStackBudgetRemaining !== null && amountUsd > 0) {
      this.cycleStackBudgetRemaining = Math.max(
        0,
        this.cycleStackBudgetRemaining - amountUsd,
      );
    }
  }

  /**
   * Stack (double down on) a position
   */
  private async stackPosition(
    position: ApiPosition,
    gainCents: number,
  ): Promise<boolean> {
    if (!isLiveTradingEnabled()) {
      this.logger.info(
        `[Stacking] Would stack ${position.tokenId.slice(0, 8)}... ` +
          `+${gainCents.toFixed(1)}¢ gain - LIVE TRADING DISABLED`,
      );
      return false;
    }

    const wallet = (this.client as { wallet?: Wallet }).wallet;
    if (!wallet) {
      this.logger.error(`[Stacking] No wallet available`);
      return false;
    }

    // Determine stack size
    let stackUsd: number;
    if (this.cycleStackBudgetRemaining !== null) {
      stackUsd = Math.min(
        this.cycleStackBudgetRemaining,
        this.config.maxStackUsd,
      );
      this.logger.info(
        `[Stacking] 📊 STACK SIZING: UNLIMITED MODE - using full available cash $${stackUsd.toFixed(2)}`,
      );
    } else {
      stackUsd = this.config.maxStackUsd;
      this.logger.info(
        `[Stacking] 📊 STACK SIZING: fallback to config limit $${stackUsd.toFixed(2)}`,
      );
    }

    // Apply budget-aware sizing
    const budgetResult = this.applyBudgetAwareSizing(stackUsd);
    if (budgetResult.skip) {
      return false;
    }

    const sizeUsd = budgetResult.cappedUsd;
    const outcome = position.outcome.toUpperCase() === "YES" ? "YES" : "NO";

    this.logger.info(
      `[Stacking] 📈 Stacking ${position.tokenId.slice(0, 8)}... ` +
        `entry=${position.avgPriceCents.toFixed(1)}¢, ` +
        `current=${position.curPriceCents.toFixed(1)}¢, ` +
        `gain=+${gainCents.toFixed(1)}¢, ` +
        `stack=$${sizeUsd.toFixed(2)} [API DATA]`,
    );

    try {
      const result = await postOrder({
        client: this.client,
        wallet,
        marketId: position.conditionId,
        tokenId: position.tokenId,
        outcome: outcome as "YES" | "NO",
        side: "BUY",
        sizeUsd,
        buySlippagePct: 2,
        logger: this.logger,
      });

      if (result.status === "submitted") {
        const effectiveStackAmountUsd =
          typeof (result as { filledAmountUsd?: number }).filledAmountUsd ===
          "number"
            ? (result as { filledAmountUsd?: number }).filledAmountUsd!
            : sizeUsd;
        this.deductFromCycleStackBudget(effectiveStackAmountUsd);

        // Record the stack in session tracking
        this.sessionStackedPositions.set(position.tokenId, {
          tokenId: position.tokenId,
          conditionId: position.conditionId,
          stackedAtMs: Date.now(),
          stackedAtPrice: position.curPrice,
          stackedAmountUsd: sizeUsd,
          entryPriceCents: position.avgPriceCents,
          gainCentsAtStack: gainCents,
        });

        // Invalidate cache for this token so next refresh gets updated position
        this.apiClient.invalidateCache(position.tokenId);

        this.logger.info(
          `[Stacking] ✅ Stacked ${position.tokenId.slice(0, 8)}... ` +
            `$${sizeUsd.toFixed(2)} at ${position.curPriceCents.toFixed(1)}¢`,
        );

        // Send telegram notification
        void notifyStack(
          position.conditionId,
          position.tokenId,
          sizeUsd / position.curPrice,
          position.curPrice,
          sizeUsd,
          {
            entryPrice: position.avgPrice,
            outcome: outcome,
          },
        ).catch(() => {});

        return true;
      }

      this.logger.warn(
        `[Stacking] ⚠️ Stack failed ${position.tokenId.slice(0, 8)}...: ${result.reason ?? "unknown"}`,
      );
      return false;
    } catch (err) {
      this.logger.error(
        `[Stacking] ❌ Stack error ${position.tokenId.slice(0, 8)}...: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Check if a token is on cooldown
   */
  private isOnCooldown(tokenId: string): boolean {
    const cooldownUntil = this.cooldowns.get(tokenId);
    if (!cooldownUntil) return false;
    return Date.now() < cooldownUntil;
  }

  /**
   * Set cooldown for a token
   */
  private setCooldown(tokenId: string): void {
    this.cooldowns.set(tokenId, Date.now() + this.config.cooldownMs);
  }

  /**
   * Clean up expired cooldowns
   */
  private cleanupCooldowns(): void {
    const now = Date.now();
    for (const [tokenId, cooldownUntil] of this.cooldowns) {
      if (now >= cooldownUntil) {
        this.cooldowns.delete(tokenId);
      }
    }
  }

  /**
   * Check if a position has already been stacked (in this session)
   */
  isPositionStacked(tokenId: string): boolean {
    return this.sessionStackedPositions.has(tokenId);
  }

  /**
   * Get all stacked positions from this session
   */
  getStackedPositions(): StackedPositionEntry[] {
    return Array.from(this.sessionStackedPositions.values());
  }

  /**
   * Get strategy stats
   */
  getStats(): {
    enabled: boolean;
    stackedCount: number;
    activeCooldowns: number;
  } {
    return {
      enabled: this.config.enabled,
      stackedCount: this.sessionStackedPositions.size,
      activeCooldowns: this.cooldowns.size,
    };
  }

  /**
   * Clear session tracking (for testing or reset)
   */
  clearStackedPositions(): void {
    this.sessionStackedPositions.clear();
    this.cooldowns.clear();
    this.logger.info("[Stacking] Cleared session stacked positions");
  }
}
