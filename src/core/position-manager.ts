/**
 * Position Manager
 *
 * Manages trading positions with full lifecycle tracking including
 * state transitions, hedging, and exit conditions.
 *
 * Extracted from start.ts for modularity.
 */

import type {
  EvMetrics,
  BiasDirection,
  PositionState,
  ExitReason,
  HedgeLeg,
  StateTransition,
  ManagedPosition,
} from "./decision-engine";

import { getOppositeTokenId } from "../lib";
import type { Position } from "../models";

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

export interface PositionManagerConfig {
  tpCents: number;
  hedgeTriggerCents: number;
  maxAdverseCents: number;
  maxHoldSeconds: number;
  hedgeRatio: number;
  maxHedgeRatio: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Position Manager Class
// ═══════════════════════════════════════════════════════════════════════════

export class PositionManager {
  private positions: Map<string, ManagedPosition> = new Map();
  private readonly config: PositionManagerConfig;
  private transitionCallbacks: ((t: StateTransition) => void)[] = [];

  constructor(config: PositionManagerConfig) {
    this.config = config;
  }

  /**
   * Register callback for state transitions
   */
  onTransition(callback: (t: StateTransition) => void): void {
    this.transitionCallbacks.push(callback);
  }

  /**
   * Open a new position
   */
  openPosition(params: {
    tokenId: string;
    marketId?: string;
    side: "LONG" | "SHORT";
    entryPriceCents: number;
    sizeUsd: number;
    referencePriceCents: number;
    evSnapshot: EvMetrics | null;
    biasDirection: BiasDirection;
  }): ManagedPosition {
    const id = `${params.tokenId}-${Date.now()}`;
    const now = Date.now();

    // Calculate targets based on side
    let takeProfitPriceCents: number;
    let hedgeTriggerPriceCents: number;
    let hardExitPriceCents: number;

    if (params.side === "LONG") {
      takeProfitPriceCents = params.entryPriceCents + this.config.tpCents;
      hedgeTriggerPriceCents =
        params.entryPriceCents - this.config.hedgeTriggerCents;
      hardExitPriceCents = params.entryPriceCents - this.config.maxAdverseCents;
    } else {
      takeProfitPriceCents = params.entryPriceCents - this.config.tpCents;
      hedgeTriggerPriceCents =
        params.entryPriceCents + this.config.hedgeTriggerCents;
      hardExitPriceCents = params.entryPriceCents + this.config.maxAdverseCents;
    }

    const position: ManagedPosition = {
      id,
      tokenId: params.tokenId,
      marketId: params.marketId,
      side: params.side,
      state: "OPEN",
      entryPriceCents: params.entryPriceCents,
      entrySizeUsd: params.sizeUsd,
      entryTime: now,
      currentPriceCents: params.entryPriceCents,
      unrealizedPnlCents: 0,
      unrealizedPnlUsd: 0,
      takeProfitPriceCents,
      hedgeTriggerPriceCents,
      hardExitPriceCents,
      hedges: [],
      totalHedgeRatio: 0,
      referencePriceCents: params.referencePriceCents,
      transitions: [],
      lastUpdateTime: now,
    };

    this.positions.set(id, position);

    // Record initial transition
    this.recordTransition(position, "OPEN", "OPEN", "POSITION_OPENED", {
      evSnapshot: params.evSnapshot,
      biasDirection: params.biasDirection,
    });

    return position;
  }

  /**
   * Set the opposite token ID for a position (for hedging)
   * This should be called after opening a position with the result of getOppositeTokenId()
   */
  setOppositeToken(positionId: string, oppositeTokenId: string): void {
    const position = this.positions.get(positionId);
    if (position) {
      position.oppositeTokenId = oppositeTokenId;
      console.log(
        `🔗 [HEDGE] Linked opposite token ${oppositeTokenId.slice(0, 16)}... for position ${positionId.slice(0, 16)}...`,
      );
    }
  }

  /**
   * Get the opposite token ID for a position
   */
  getOppositeToken(positionId: string): string | undefined {
    return this.positions.get(positionId)?.oppositeTokenId;
  }

  /**
   * Register an external position for monitoring
   * This allows the bot to apply exit math (TP, stop loss, hedging) to positions
   * that were not opened by the bot (e.g., manual trades, pre-existing positions)
   *
   * Note: This is async because it needs to fetch the opposite token ID for hedging
   */
  async registerExternalPosition(
    pos: Position,
  ): Promise<ManagedPosition | null> {
    // Check if already tracked
    for (const [, managed] of this.positions) {
      if (managed.tokenId === pos.tokenId && managed.state !== "CLOSED") {
        return null; // Already tracking
      }
    }

    const id = `ext-${pos.tokenId}-${Date.now()}`;
    const now = Date.now();

    // Determine side based on outcome (YES = LONG, NO = SHORT)
    const side: "LONG" | "SHORT" =
      pos.outcome?.toUpperCase() === "NO" ? "SHORT" : "LONG";

    // Convert current price to cents
    const currentPriceCents = pos.curPrice * 100;

    // Use average price as entry (best guess for external positions)
    const entryPriceCents = pos.avgPrice * 100;

    // Calculate targets based on current price (since we don't know original entry intent)
    let takeProfitPriceCents: number;
    let hedgeTriggerPriceCents: number;
    let hardExitPriceCents: number;

    if (side === "LONG") {
      takeProfitPriceCents = entryPriceCents + this.config.tpCents;
      hedgeTriggerPriceCents = entryPriceCents - this.config.hedgeTriggerCents;
      hardExitPriceCents = entryPriceCents - this.config.maxAdverseCents;
    } else {
      takeProfitPriceCents = entryPriceCents - this.config.tpCents;
      hedgeTriggerPriceCents = entryPriceCents + this.config.hedgeTriggerCents;
      hardExitPriceCents = entryPriceCents + this.config.maxAdverseCents;
    }

    // Calculate P&L correctly based on side
    const pnlCents =
      pos.gainCents ||
      (side === "LONG"
        ? currentPriceCents - entryPriceCents
        : entryPriceCents - currentPriceCents);

    const position: ManagedPosition = {
      id,
      tokenId: pos.tokenId,
      marketId: pos.marketId,
      side,
      state: "OPEN",
      entryPriceCents,
      entrySizeUsd: pos.value,
      entryTime: pos.entryTime || now - 60000, // Default to 1 min ago if unknown
      currentPriceCents,
      unrealizedPnlCents: pnlCents,
      unrealizedPnlUsd: pos.pnlUsd,
      takeProfitPriceCents,
      hedgeTriggerPriceCents,
      hardExitPriceCents,
      hedges: [],
      totalHedgeRatio: 0,
      referencePriceCents: currentPriceCents,
      transitions: [],
      lastUpdateTime: now,
      isExternal: true, // Flag to identify external positions
    };

    this.positions.set(id, position);

    // Fetch opposite token ID for hedging capability
    try {
      const oppositeTokenId = await getOppositeTokenId(pos.tokenId);
      if (oppositeTokenId) {
        position.oppositeTokenId = oppositeTokenId;
        console.log(
          `📋 Registered external position: ${pos.outcome} @ ${entryPriceCents.toFixed(0)}¢ (P&L: ${pos.pnlPct >= 0 ? "+" : ""}${pos.pnlPct.toFixed(1)}%) [hedge-ready]`,
        );
      } else {
        console.log(
          `📋 Registered external position: ${pos.outcome} @ ${entryPriceCents.toFixed(0)}¢ (P&L: ${pos.pnlPct >= 0 ? "+" : ""}${pos.pnlPct.toFixed(1)}%) [no hedge]`,
        );
      }
    } catch {
      console.log(
        `📋 Registered external position: ${pos.outcome} @ ${entryPriceCents.toFixed(0)}¢ (P&L: ${pos.pnlPct >= 0 ? "+" : ""}${pos.pnlPct.toFixed(1)}%) [no hedge]`,
      );
    }

    return position;
  }

  /**
   * Update position with current price
   */
  updatePrice(
    positionId: string,
    currentPriceCents: number,
    evSnapshot: EvMetrics | null,
    biasDirection: BiasDirection,
  ): {
    action: "NONE" | "HEDGE" | "EXIT";
    reason?: ExitReason;
  } {
    const position = this.positions.get(positionId);
    if (!position || position.state === "CLOSED") {
      return { action: "NONE" };
    }

    const now = Date.now();
    position.currentPriceCents = currentPriceCents;
    position.lastUpdateTime = now;

    // Calculate unrealized P&L
    if (position.side === "LONG") {
      position.unrealizedPnlCents =
        currentPriceCents - position.entryPriceCents;
    } else {
      position.unrealizedPnlCents =
        position.entryPriceCents - currentPriceCents;
    }

    const shares = position.entrySizeUsd / (position.entryPriceCents / 100);
    position.unrealizedPnlUsd = (position.unrealizedPnlCents / 100) * shares;

    // Check exit conditions (ANY triggers exit)

    // 1. Take profit
    if (this.checkTakeProfit(position)) {
      return { action: "EXIT", reason: "TAKE_PROFIT" };
    }

    // 2. Hard exit (max adverse)
    if (this.checkHardExit(position)) {
      return { action: "EXIT", reason: "HARD_EXIT" };
    }

    // 3. Time stop
    const holdTime = (now - position.entryTime) / 1000;
    if (holdTime >= this.config.maxHoldSeconds) {
      return { action: "EXIT", reason: "TIME_STOP" };
    }

    // 4. Hedge trigger (if not already fully hedged)
    if (
      position.state === "OPEN" &&
      position.totalHedgeRatio < this.config.maxHedgeRatio &&
      this.checkHedgeTrigger(position)
    ) {
      return { action: "HEDGE" };
    }

    return { action: "NONE" };
  }

  /**
   * Check if take profit is triggered
   */
  private checkTakeProfit(position: ManagedPosition): boolean {
    if (position.side === "LONG") {
      return position.currentPriceCents >= position.takeProfitPriceCents;
    } else {
      return position.currentPriceCents <= position.takeProfitPriceCents;
    }
  }

  /**
   * Check if hard exit is triggered
   */
  private checkHardExit(position: ManagedPosition): boolean {
    if (position.side === "LONG") {
      return position.currentPriceCents <= position.hardExitPriceCents;
    } else {
      return position.currentPriceCents >= position.hardExitPriceCents;
    }
  }

  /**
   * Check if hedge trigger is hit
   */
  private checkHedgeTrigger(position: ManagedPosition): boolean {
    if (position.side === "LONG") {
      return position.currentPriceCents <= position.hedgeTriggerPriceCents;
    } else {
      return position.currentPriceCents >= position.hedgeTriggerPriceCents;
    }
  }

  /**
   * Record a hedge being placed
   */
  recordHedge(
    positionId: string,
    hedge: Omit<HedgeLeg, "pnlCents">,
    evSnapshot: EvMetrics | null,
    biasDirection: BiasDirection,
  ): void {
    const position = this.positions.get(positionId);
    if (!position) return;

    const hedgeLeg: HedgeLeg = {
      ...hedge,
      pnlCents: 0,
    };

    position.hedges.push(hedgeLeg);
    position.totalHedgeRatio += this.config.hedgeRatio;

    // Transition to HEDGED state
    if (position.state === "OPEN") {
      this.recordTransition(position, "OPEN", "HEDGED", "HEDGE_PLACED", {
        evSnapshot,
        biasDirection,
      });
      position.state = "HEDGED";
    }
  }

  /**
   * Begin exit process
   */
  beginExit(
    positionId: string,
    reason: ExitReason,
    evSnapshot: EvMetrics | null,
    biasDirection: BiasDirection,
  ): void {
    const position = this.positions.get(positionId);
    if (!position || position.state === "CLOSED") return;

    this.recordTransition(position, position.state, "EXITING", reason, {
      evSnapshot,
      biasDirection,
    });
    position.state = "EXITING";
  }

  /**
   * Complete exit and close position
   */
  closePosition(
    positionId: string,
    exitPriceCents: number,
    evSnapshot: EvMetrics | null,
    biasDirection: BiasDirection,
  ): ManagedPosition | null {
    const position = this.positions.get(positionId);
    if (!position) return null;

    // Calculate final P&L
    if (position.side === "LONG") {
      position.unrealizedPnlCents = exitPriceCents - position.entryPriceCents;
    } else {
      position.unrealizedPnlCents = position.entryPriceCents - exitPriceCents;
    }

    const shares = position.entrySizeUsd / (position.entryPriceCents / 100);
    position.unrealizedPnlUsd = (position.unrealizedPnlCents / 100) * shares;
    position.currentPriceCents = exitPriceCents;

    this.recordTransition(
      position,
      position.state,
      "CLOSED",
      "POSITION_CLOSED",
      {
        evSnapshot,
        biasDirection,
      },
    );
    position.state = "CLOSED";

    return position;
  }

  /**
   * Record a state transition
   */
  private recordTransition(
    position: ManagedPosition,
    fromState: PositionState,
    toState: PositionState,
    reason: string,
    context: {
      evSnapshot: EvMetrics | null;
      biasDirection: BiasDirection;
    },
  ): void {
    const transition: StateTransition = {
      positionId: position.id,
      fromState,
      toState,
      reason,
      timestamp: Date.now(),
      pnlCents: position.unrealizedPnlCents,
      pnlUsd: position.unrealizedPnlUsd,
      evSnapshot: context.evSnapshot,
      biasDirection: context.biasDirection,
    };

    position.transitions.push(transition);

    // Fire callbacks
    for (const callback of this.transitionCallbacks) {
      callback(transition);
    }
  }

  /**
   * Get position by ID
   */
  getPosition(positionId: string): ManagedPosition | undefined {
    return this.positions.get(positionId);
  }

  /**
   * Get all open positions
   */
  getOpenPositions(): ManagedPosition[] {
    return Array.from(this.positions.values()).filter(
      (p) => p.state !== "CLOSED",
    );
  }

  /**
   * Get positions by token
   */
  getPositionsByToken(tokenId: string): ManagedPosition[] {
    return Array.from(this.positions.values()).filter(
      (p) => p.tokenId === tokenId && p.state !== "CLOSED",
    );
  }

  /**
   * Get positions by market
   */
  getPositionsByMarket(marketId: string): ManagedPosition[] {
    return Array.from(this.positions.values()).filter(
      (p) => p.marketId === marketId && p.state !== "CLOSED",
    );
  }

  /**
   * Get total deployed USD
   */
  getTotalDeployedUsd(): number {
    return this.getOpenPositions().reduce((sum, p) => sum + p.entrySizeUsd, 0);
  }

  /**
   * Remove closed positions older than specified age
   */
  pruneClosedPositions(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    let pruned = 0;

    for (const [id, position] of this.positions.entries()) {
      if (position.state === "CLOSED" && position.lastUpdateTime < cutoff) {
        this.positions.delete(id);
        pruned++;
      }
    }

    return pruned;
  }

  /**
   * Clear all positions (for testing)
   */
  clear(): void {
    this.positions.clear();
  }

  /**
   * Convert position to JSON log entry
   */
  positionToLogEntry(position: ManagedPosition): object {
    return {
      type: "position",
      timestamp: new Date().toISOString(),
      id: position.id,
      tokenId: position.tokenId.slice(0, 12) + "...",
      marketId: position.marketId,
      side: position.side,
      state: position.state,
      entryPriceCents: position.entryPriceCents,
      currentPriceCents: position.currentPriceCents,
      unrealizedPnlCents: parseFloat(position.unrealizedPnlCents.toFixed(2)),
      unrealizedPnlUsd: parseFloat(position.unrealizedPnlUsd.toFixed(2)),
      takeProfitCents: position.takeProfitPriceCents,
      hedgeTriggerCents: position.hedgeTriggerPriceCents,
      hardExitCents: position.hardExitPriceCents,
      hedgeCount: position.hedges.length,
      totalHedgeRatio: parseFloat(position.totalHedgeRatio.toFixed(2)),
      holdTimeSeconds: Math.round((Date.now() - position.entryTime) / 1000),
    };
  }
}
