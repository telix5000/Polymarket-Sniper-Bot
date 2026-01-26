import "dotenv/config";
import {
  loadMonitorConfig,
  loadArbConfig,
  loadStrategyConfig,
  parseCliOverrides,
} from "../config/loadConfig";
import { createPolymarketAuthFromEnv } from "../clob/polymarket-auth";
import { MempoolMonitorService } from "../services/mempool-monitor.service";
import { TradeExecutorService } from "../services/trade-executor.service";
import { SellSignalMonitorService } from "../services/sell-signal-monitor.service";
import {
  createTelegramService,
  TelegramService,
} from "../services/telegram.service";
import {
  initTradeNotificationService,
  setTradeNotificationPnLCallback,
  setTradeRecordCallback,
} from "../services/trade-notification.service";
import { ConsoleLogger } from "../utils/logger.util";
import { getUsdBalanceApprox, getPolBalance } from "../utils/get-balance.util";
import { startArbitrageEngine } from "../arbitrage/runtime";
import { suppressClobOrderbookErrors } from "../utils/console-filter.util";
import { startWireguard } from "../utils/wireguard.util";
import { startOpenvpn } from "../utils/openvpn.util";
import { formatClobCredsChecklist } from "../utils/clob-credentials.util";
import { ensureTradingReady } from "../polymarket/preflight";
import { getContextAwareWarnings } from "../utils/auth-diagnostic.util";
import { Orchestrator, createOrchestrator } from "../strategies/orchestrator";
import { isLiveTradingEnabled } from "../utils/live-trading.util";
import { populateTargetAddressesFromLeaderboard } from "../targets";

// Global service references for graceful shutdown
let telegramService: TelegramService | undefined;
let orchestrator: Orchestrator | undefined;
let sellSignalMonitor: SellSignalMonitorService | undefined;

async function main(): Promise<void> {
  const logger = new ConsoleLogger();
  suppressClobOrderbookErrors(logger);
  const openvpnStarted = await startOpenvpn(logger);
  if (!openvpnStarted) {
    await startWireguard(logger);
  }
  const cliOverrides = parseCliOverrides(process.argv.slice(2));

  // Populate TARGET_ADDRESSES from leaderboard if not set via env
  // This fetches top traders from Polymarket leaderboard dynamically
  await populateTargetAddressesFromLeaderboard(logger);

  // Load unified STRATEGY_PRESET configuration
  // This controls which strategies/components are enabled
  const strategyConfig = loadStrategyConfig(cliOverrides);

  // Legacy MODE env var - deprecated but still supported for backwards compatibility
  // When STRATEGY_PRESET is set, MODE is ignored and config-driven behavior takes over
  const legacyMode = String(
    process.env.MODE ?? process.env.mode ?? "",
  ).toLowerCase();

  // Determine what runs based on strategyConfig (preferred) or legacy MODE
  const arbEnabled = strategyConfig?.arbEnabled ?? (legacyMode === "arb" || legacyMode === "both");
  const monitorEnabled = strategyConfig?.monitorEnabled ?? (legacyMode === "mempool" || legacyMode === "both" || legacyMode === "");

  // Log startup mode
  if (strategyConfig) {
    logger.info(`🚀 Starting Polymarket (preset: ${strategyConfig.presetName})`);
    logger.info(`📊 Components: orchestrator=${strategyConfig.enabled ? "ON" : "OFF"}, arb=${arbEnabled ? "ON" : "OFF"}, monitor=${monitorEnabled ? "ON" : "OFF"}`);
  } else if (legacyMode) {
    logger.warn(`⚠️ Using legacy MODE=${legacyMode} - consider migrating to STRATEGY_PRESET`);
  } else {
    logger.info(`🚀 Starting Polymarket with default config`);
  }

  // Run authentication and preflight ONCE at top level before starting any engines
  logger.info("🔐 Authenticating with Polymarket...");
  const auth = createPolymarketAuthFromEnv(logger);

  const authResult = await auth.authenticate();
  if (!authResult.success) {
    logger.error(`❌ Authentication failed: ${authResult.error}`);
    logger.error("Cannot proceed without valid credentials");
    return;
  }
  logger.info(`✅ Authentication successful`);

  // Get authenticated CLOB client (already has wallet with provider)
  const client = await auth.getClobClient();

  // Load config to get parameters for preflight
  // Use ARB config when arbitrage is enabled, otherwise monitor config
  const env = arbEnabled
    ? loadArbConfig(cliOverrides)
    : loadMonitorConfig(cliOverrides);

  // Run preflight ONCE for all components
  logger.info("🔍 Running preflight checks...");
  const tradingReady = await ensureTradingReady({
    client,
    logger,
    privateKey: env.privateKey,
    configuredPublicKey: env.proxyWallet,
    rpcUrl: env.rpcUrl,
    detectOnly: false,
    clobCredsComplete: true,
    clobDeriveEnabled: env.clobDeriveEnabled,
    collateralTokenDecimals: env.collateralTokenDecimals,
  });

  // Start unified strategy orchestrator if STRATEGY_PRESET is configured
  // Uses reliable strategies for reliable, easy-to-debug trading
  if (strategyConfig && strategyConfig.enabled && !tradingReady.detectOnly) {
    logger.info(
      `🎯 Starting strategy orchestrator (preset: ${strategyConfig.presetName})`,
    );
    logger.info(
      `📊 Config: MAX_POSITION_USD=$${strategyConfig.endgameMaxPositionUsd}, ` +
        `HEDGING=${strategyConfig.hedgingEnabled ? "ON" : "OFF"}, ` +
        `ABSOLUTE_MAX=$${strategyConfig.hedgingAbsoluteMaxUsd}`,
    );

    // Load env config for balance fetching (needed for dynamic reserves)
    const envForBalances = loadMonitorConfig(cliOverrides);

    // Initialize Telegram notifications BEFORE creating orchestrator
    // This ensures the singleton trade-notification.service.ts is initialized
    // before strategies start executing and calling notifyBuy/notifySell
    telegramService = createTelegramService(logger);
    if (telegramService.isEnabled()) {
      // Initialize centralized trade notification service for all strategies
      initTradeNotificationService(telegramService, logger);
      logger.info(
        "📱 Telegram notifications initialized BEFORE orchestrator creation",
      );
    }

    // Create orchestrator with user's config
    orchestrator = new Orchestrator({
      client,
      logger,
      maxPositionUsd: strategyConfig.endgameMaxPositionUsd,
      riskPreset: strategyConfig.presetName as
        | "conservative"
        | "balanced"
        | "aggressive",
      // Provide wallet balance fetcher for dynamic reserves to work
      // This enables the reserve system to track USDC balance and gate BUY orders
      getWalletBalances: async () => ({
        usdcBalance: await getUsdBalanceApprox(
          client.wallet,
          envForBalances.collateralTokenAddress,
          envForBalances.collateralTokenDecimals,
        ),
      }),
      // Pass hedging config from env
      hedgingConfig: {
        enabled: strategyConfig.hedgingEnabled,
        triggerLossPct: strategyConfig.hedgingTriggerLossPct,
        maxHedgeUsd: strategyConfig.hedgingMaxHedgeUsd,
        minHedgeUsd: strategyConfig.hedgingMinHedgeUsd,
        absoluteMaxUsd: strategyConfig.hedgingAbsoluteMaxUsd,
        allowExceedMax: strategyConfig.hedgingAllowExceedMax,
        forceLiquidationPct: strategyConfig.hedgingForceLiquidationLossPct,
        emergencyLossPct: strategyConfig.hedgingEmergencyLossPct,
        // Near-close hedging behavior
        nearCloseWindowMinutes:
          strategyConfig.hedgingNearCloseWindowMinutes,
        nearClosePriceDropCents:
          strategyConfig.hedgingNearClosePriceDropCents,
        nearCloseLossPct: strategyConfig.hedgingNearCloseLossPct,
        noHedgeWindowMinutes: strategyConfig.hedgingNoHedgeWindowMinutes,
        // Hedging direction and "hedge up" settings
        direction: strategyConfig.hedgingDirection,
        hedgeUpPriceThreshold: strategyConfig.hedgingHedgeUpPriceThreshold,
        hedgeUpMaxPrice: strategyConfig.hedgingHedgeUpMaxPrice,
        hedgeUpWindowMinutes: strategyConfig.hedgingHedgeUpWindowMinutes,
        hedgeUpMaxUsd: strategyConfig.hedgingHedgeUpMaxUsd,
        hedgeUpAnytime: strategyConfig.hedgingHedgeUpAnytime,
        // Hedge exit monitoring
        hedgeExitThreshold: strategyConfig.hedgingHedgeExitThreshold,
      },
      // Quick flip module removed - functionality covered by ScalpTrade
      // Pass endgame config
      endgameConfig: {
        enabled: strategyConfig.endgameSweepEnabled,
        minPrice: strategyConfig.endgameMinPrice,
        maxPrice: strategyConfig.endgameMaxPrice,
      },
      // Pass stop-loss config from preset
      stopLossConfig: {
        minHoldSeconds: strategyConfig.stopLossMinHoldSeconds,
      },
      // Pass scalp take-profit config
      scalpConfig: {
        enabled: strategyConfig.scalpTakeProfitEnabled,
        minHoldMinutes: strategyConfig.scalpMinHoldMinutes,
        maxHoldMinutes: strategyConfig.scalpMaxHoldMinutes,
        minProfitPct: strategyConfig.scalpMinProfitPct,
        targetProfitPct: strategyConfig.scalpTargetProfitPct,
        minProfitUsd: strategyConfig.scalpMinProfitUsd,
        resolutionExclusionPrice: strategyConfig.scalpResolutionExclusionPrice,
        suddenSpikeEnabled: strategyConfig.scalpSuddenSpikeEnabled,
        suddenSpikeThresholdPct: strategyConfig.scalpSuddenSpikeThresholdPct,
        suddenSpikeWindowMinutes: strategyConfig.scalpSuddenSpikeWindowMinutes,
        lowPriceThreshold: strategyConfig.scalpLowPriceThreshold,
        lowPriceMaxHoldMinutes: strategyConfig.scalpLowPriceMaxHoldMinutes,
        legacyPositionMode: strategyConfig.scalpLegacyPositionMode,
      },
      // Pass auto-sell config for near-resolution and stale position selling
      autoSellConfig: {
        enabled: strategyConfig.autoSellEnabled,
        threshold: strategyConfig.autoSellThreshold,
        minHoldSeconds: strategyConfig.autoSellMinHoldSec,
        disputeWindowExitEnabled: strategyConfig.autoSellDisputeExitEnabled,
        disputeWindowExitPrice: strategyConfig.autoSellDisputeExitPrice,
        stalePositionHours: strategyConfig.autoSellStalePositionHours,
        quickWinEnabled: strategyConfig.autoSellQuickWinEnabled,
        quickWinMaxHoldMinutes: strategyConfig.autoSellQuickWinMaxHoldMinutes,
        quickWinProfitPct: strategyConfig.autoSellQuickWinProfitPct,
      },
      // Pass position stacking config for doubling down on winners
      positionStackingConfig: {
        enabled: strategyConfig.positionStackingEnabled,
        minGainCents: strategyConfig.positionStackingMinGainCents,
        maxCurrentPrice: strategyConfig.positionStackingMaxCurrentPrice,
      },
      // Pass auto-redeem config to respect AUTO_REDEEM_MIN_POSITION_USD env var
      autoRedeemConfig: {
        enabled: strategyConfig.autoRedeemEnabled,
        minPositionUsd: strategyConfig.autoRedeemMinPositionUsd,
        checkIntervalMs: strategyConfig.autoRedeemCheckIntervalMs,
      },
    });

    // Set trade recording callback so realized P&L is tracked in the ledger
    // This is wired REGARDLESS of Telegram config so P&L tracking works in all deployments
    // BUY trades establish cost basis, SELL trades realize P&L
    setTradeRecordCallback((trade) =>
      orchestrator!.getPnLLedger().recordTrade(trade),
    );
    logger.info(
      "📊 P&L tracking enabled - all trades will be recorded to ledger",
    );

    // Set up Telegram P&L callbacks and startup notification (if enabled)
    if (telegramService?.isEnabled()) {
      // Set P&L callback for including balance snapshots with notifications
      setTradeNotificationPnLCallback(() =>
        orchestrator!.getSummaryWithBalances(),
      );

      // Start periodic P&L updates
      telegramService.startPnlUpdates(() =>
        orchestrator!.getSummaryWithBalances(),
      );

      // Send startup notification showing enabled strategies
      // This helps users verify Telegram is working and understand what to expect
      // Check if mempool mode will also run (MODE=both or MODE=mempool)
      const mempoolWillRun = mode === "mempool" || mode === "both";
      void telegramService
        .sendStartupNotification({
          endgameSweep: strategyConfig.endgameSweepEnabled,
          positionStacking: strategyConfig.positionStackingEnabled,
          sellEarly: strategyConfig.sellEarlyEnabled,
          autoSell: strategyConfig.autoSellEnabled,
          scalpTakeProfit: strategyConfig.scalpTakeProfitEnabled,
          hedging: strategyConfig.hedgingEnabled,
          stopLoss: true, // Always enabled when orchestrator runs
          autoRedeem: strategyConfig.autoRedeemEnabled,
          frontrun: mempoolWillRun, // Frontrun/copy trading enabled when mempool mode runs
        })
        .catch((err) => {
          logger.warn(
            `[Telegram] Failed to send startup notification: ${err instanceof Error ? err.message : String(err)}`,
          );
        });

      logger.info(
        "📱 Trade notifications enabled - will notify on buys/sells/hedges/redemptions",
      );
    }

    // NOW start the orchestrator (after notifications are ready)
    await orchestrator.start();
    logger.info("✅ Simplified strategy orchestrator started successfully");

    // Set session start balance for accurate drawdown calculation
    try {
      const usdcBalance = await getUsdBalanceApprox(
        client.wallet,
        envForBalances.collateralTokenAddress,
        envForBalances.collateralTokenDecimals,
      );
      orchestrator.getRiskManager().setSessionStartBalance(usdcBalance);
      logger.info(`💰 Session start balance: $${usdcBalance.toFixed(2)}`);
    } catch (err) {
      logger.warn(
        `[Orchestrator] Could not set session balance: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else if (strategyConfig && !strategyConfig.enabled) {
    logger.info(
      `[Strategy] Preset=${strategyConfig.presetName} disabled; using individual config flags.`,
    );
  }

  // Start ARB engine if enabled (via config or legacy MODE)
  if (arbEnabled) {
    await startArbitrageEngine(cliOverrides, client, tradingReady);
  }

  // Start MEMPOOL monitor if enabled (via config or legacy MODE)
  if (monitorEnabled) {
    const mempoolEnv = loadMonitorConfig(cliOverrides);
    logger.info(formatClobCredsChecklist(mempoolEnv.clobCredsChecklist));

    if (!mempoolEnv.enabled) {
      logger.info(
        `[Monitor] Preset=${mempoolEnv.presetName} disabled; skipping monitor runtime.`,
      );
      return;
    }

    // Update config with preflight results
    mempoolEnv.clobCredsComplete = true;
    mempoolEnv.detectOnly = tradingReady.detectOnly;

    // Check if live trading is enabled (supports both ARB_LIVE_TRADING and LIVE_TRADING)
    const liveTradingEnabled = isLiveTradingEnabled();

    // Log balances at startup
    try {
      const polBalance = await getPolBalance(client.wallet);
      const usdcBalance = await getUsdBalanceApprox(
        client.wallet,
        mempoolEnv.collateralTokenAddress,
        mempoolEnv.collateralTokenDecimals,
      );
      logger.info(`💳 Wallet: ${client.wallet.address}`);
      logger.info(`⛽ POL Balance: ${polBalance.toFixed(4)} POL`);
      logger.info(`💵 USDC Balance: ${usdcBalance.toFixed(2)} USDC`);
    } catch (err) {
      logger.error("❌ Failed to fetch balances", err as Error);
    }

    // Log prominent trading status banner for MEMPOOL mode
    if (mempoolEnv.detectOnly) {
      logger.warn(
        "=====================================================================",
      );
      logger.warn("⚠️  TRADING DISABLED - Running in DETECT-ONLY mode");
      logger.warn(
        "=====================================================================",
      );
      logger.warn("The bot will monitor trades but will NOT submit orders.");
      logger.warn("");

      // Get context-aware warnings based on actual failure reasons
      const warnings = getContextAwareWarnings({
        liveTradingEnabled,
        authOk: tradingReady.authOk,
        approvalsOk: tradingReady.approvalsOk,
        geoblockPassed: tradingReady.geoblockPassed,
      });

      if (warnings.length > 0) {
        logger.warn("Active blockers:");
        warnings.forEach((warning, idx) => {
          logger.warn(`  ${idx + 1}. ${warning}`);
        });
        logger.warn("");
      }

      logger.warn("General troubleshooting:");
      logger.warn("  - Visit https://polymarket.com and connect your wallet");
      logger.warn("  - Make at least one small trade on the website");
      logger.warn(
        "  - Then restart this bot to generate valid API credentials",
      );
      logger.warn(
        "  - Or generate API keys at CLOB_DERIVE_CREDS=true (there is no web UI to manually generate CLOB API keys)",
      );
      logger.warn(
        "=====================================================================",
      );
    } else {
      logger.info(
        "=====================================================================",
      );
      logger.info(
        "✅ MEMPOOL MONITOR TRADING ENABLED - Bot will submit orders",
      );
      logger.info(
        "=====================================================================",
      );
    }

    // Initialize Telegram for mempool mode if not already initialized by orchestrator
    // This ensures copy trade (frontrun) notifications work even when running mempool-only
    if (!telegramService) {
      telegramService = createTelegramService(logger);
      if (telegramService.isEnabled()) {
        initTradeNotificationService(telegramService, logger);

        // Send startup notification for mempool/copy trading mode
        void telegramService
          .sendStartupNotification({
            frontrun: !mempoolEnv.detectOnly, // Copy trading enabled if not in detect-only mode
            // Other strategies are only available when orchestrator is also running
            endgameSweep: false,
            positionStacking: false,
            sellEarly: false,
            autoSell: false,
            scalpTakeProfit: false,
            hedging: false,
            stopLoss: false,
            autoRedeem: false,
          })
          .catch((err) => {
            logger.warn(
              `[Telegram] Failed to send startup notification: ${err instanceof Error ? err.message : String(err)}`,
            );
          });

        logger.info("📱 Telegram notifications initialized for mempool mode");
      }
    }

    const executor = new TradeExecutorService({
      client,
      proxyWallet: mempoolEnv.proxyWallet,
      logger,
      env: mempoolEnv,
      // Pass position tracker to prevent buying positions we already own (avoids stacking)
      // NOTE: Does NOT block hedging - hedges use a different tokenId (opposite outcome)
      positionTracker: orchestrator?.getPositionTracker(),
      // Pass dynamic reserves controller to gate BUY orders when reserves are insufficient
      // NOTE: Does NOT block hedging/SELL paths since they help recover reserves
      dynamicReserves: orchestrator?.getDynamicReserves(),
    });

    // Initialize SellSignalMonitorService when orchestrator exists (provides position tracking)
    // This monitors SELL signals from tracked traders and triggers protective actions
    if (orchestrator) {
      sellSignalMonitor = new SellSignalMonitorService({
        logger,
        positionTracker: orchestrator.getPositionTracker(),
        // Callbacks for protective actions - notification only, actual execution in next orchestrator cycle
        onTriggerHedge: async (position, signal) => {
          logger.info(
            `[SellSignalMonitor] 🛡️ HEDGE triggered for ${position.tokenId.slice(0, 12)}... ` +
              `(loss: ${Math.abs(position.pnlPct).toFixed(1)}%) by trader ${signal.trader.slice(0, 10)}...`,
          );
          // Return false: This is a notification callback only.
          // The actual hedge execution is handled by HedgingStrategy in the next orchestrator cycle.
          // The position will be picked up automatically since it meets the loss threshold.
          return false;
        },
        onTriggerStopLoss: async (position, signal) => {
          logger.warn(
            `[SellSignalMonitor] 🚨 STOP-LOSS triggered for ${position.tokenId.slice(0, 12)}... ` +
              `(loss: ${Math.abs(position.pnlPct).toFixed(1)}%) by trader ${signal.trader.slice(0, 10)}...`,
          );
          // Return false: This is a notification callback only.
          // The actual stop-loss execution is handled by StopLossStrategy in the next orchestrator cycle.
          // The position will be picked up automatically since it meets the loss threshold.
          return false;
        },
      });
      logger.info("📊 Sell signal monitor initialized - watching for tracked trader SELL signals");
    }

    const monitor = new MempoolMonitorService({
      client,
      logger,
      env: mempoolEnv,
      onDetectedTrade: async (signal) => {
        await executor.frontrunTrade(signal);
      },
      // Route SELL signals to SellSignalMonitorService for protective monitoring
      onDetectedSell: sellSignalMonitor
        ? async (signal) => {
            await sellSignalMonitor!.processSellSignal(signal);
          }
        : undefined,
    });

    await monitor.start();
  }
}

/**
 * Global error handlers to prevent crashes from unhandled errors.
 * These are safety nets for transient RPC errors (rate limits, network issues)
 * that might escape normal try/catch blocks.
 */

/**
 * Check if an error message indicates a transient RPC/network error
 * that shouldn't crash the bot. These errors typically resolve on retry.
 */
function isTransientRpcError(errorMsg: string): boolean {
  return (
    errorMsg.includes("Too Many Requests") ||
    errorMsg.includes("-32005") ||
    errorMsg.includes("-32000") ||
    errorMsg.includes("BAD_DATA") ||
    errorMsg.includes("missing response for request") ||
    errorMsg.includes("REPLACEMENT_UNDERPRICED") ||
    errorMsg.includes("replacement fee too low") ||
    errorMsg.includes("in-flight transaction limit") ||
    errorMsg.includes("rate limit") ||
    errorMsg.includes("ECONNRESET") ||
    errorMsg.includes("ETIMEDOUT") ||
    errorMsg.includes("socket hang up")
  );
}

/**
 * Graceful shutdown handler - clean up resources before exit
 */
function gracefulShutdown(signal: string): void {
  console.log(`\n[Shutdown] Received ${signal}, cleaning up...`);

  // Stop Telegram P&L updates
  if (telegramService) {
    telegramService.stopPnlUpdates();
    console.log("[Shutdown] Telegram notifications stopped");
  }

  // Stop orchestrator
  if (orchestrator) {
    orchestrator.stop();
    console.log("[Shutdown] Orchestrator stopped");
  }

  console.log("[Shutdown] Cleanup complete, exiting...");
  process.exit(0);
}

// Handle graceful shutdown signals
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// Handle unhandled promise rejections (async errors)
process.on("unhandledRejection", (reason) => {
  const errorMsg = reason instanceof Error ? reason.message : String(reason);

  if (isTransientRpcError(errorMsg)) {
    console.warn(
      `[UnhandledRejection] ⚠️ Transient error (bot continues): ${errorMsg}`,
    );
  } else {
    console.error(
      `[UnhandledRejection] ❌ Unhandled promise rejection:`,
      reason,
    );
    // For non-transient errors, log but don't crash
    // The specific strategy/service should handle retries
  }
});

// Handle uncaught exceptions (sync errors)
process.on("uncaughtException", (error) => {
  const errorMsg = error.message;

  if (isTransientRpcError(errorMsg)) {
    console.warn(
      `[UncaughtException] ⚠️ Transient error (bot continues): ${errorMsg}`,
    );
  } else {
    console.error(`[UncaughtException] ❌ Uncaught exception:`, error);
    // For truly fatal errors, exit after logging
    // Give time for logs to flush
    setTimeout(() => process.exit(1), 1000);
  }
});

main().catch((err) => {
  console.error("Fatal error in main():", err);
  process.exit(1);
});
