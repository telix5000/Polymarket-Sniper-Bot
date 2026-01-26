/**
 * Example: Integrating APEX Error Reporter into start.ts
 * 
 * This file shows how to integrate the error reporting system
 * into your main bot loop.
 */

import { initErrorReporter, reportError } from "./monitoring";

// ============ INITIALIZATION ============

async function main() {
  // 1. Initialize error reporter EARLY (before anything else)
  const errorReporter = initErrorReporter(logger);
  logger.info("✅ Error reporter initialized");

  // 2. Your normal startup code
  try {
    // Initialize wallet, client, etc.
    await initialize();
    
    // Start main loop
    await runMainLoop();
  } catch (error) {
    // Report fatal startup errors
    await reportError(error as Error, {
      operation: "startup",
      mode: process.env.APEX_MODE,
    });
    
    // Exit gracefully
    process.exit(1);
  }
}

// ============ MAIN TRADING LOOP ============

async function runMainLoop() {
  while (true) {
    try {
      // Your normal cycle logic
      await runCycle();
    } catch (error) {
      // Report cycle errors (non-fatal)
      await reportError(error as Error, {
        operation: "main_cycle",
        cycleCount: state.cycleCount,
        balance: state.balance,
        positionCount: state.positions.length,
        mode: state.mode,
        uptime: Date.now() - state.startTime,
      });
      
      // Log locally
      logger.error(`Cycle error: ${error}`);
      
      // Continue running (don't crash)
    }
    
    await sleep(5000);
  }
}

// ============ STRATEGY EXECUTION ============

async function executeStrategy(strategyName: string, strategyFn: () => Promise<void>) {
  try {
    await strategyFn();
  } catch (error) {
    // Report strategy-specific errors
    await reportError(error as Error, {
      operation: `strategy_${strategyName}`,
      cycleCount: state.cycleCount,
      balance: state.balance,
      mode: state.mode,
    });
    
    logger.error(`Strategy ${strategyName} failed: ${error}`);
  }
}

// Usage in main loop:
async function runCycle() {
  // Execute each strategy with error reporting
  await executeStrategy("hunter", async () => {
    const opportunities = await scanMarkets();
    await executeOpportunities(opportunities);
  });
  
  await executeStrategy("shadow", async () => {
    await runShadow();
  });
  
  await executeStrategy("velocity", async () => {
    await runVelocity();
  });
  
  // etc...
}

// ============ ORDER EXECUTION ============

async function buy(
  tokenId: string,
  outcome: "YES" | "NO",
  sizeUsd: number,
  reason: string,
): Promise<boolean> {
  try {
    const result = await postOrder({
      client: state.client,
      tokenId,
      outcome,
      side: "BUY",
      sizeUsd,
      logger,
    });
    
    if (result.success) {
      logger.info(`✅ BUY ${outcome} ${$(sizeUsd)} | ${reason}`);
      return true;
    }
    
    return false;
  } catch (error) {
    // Report order errors with full context
    await reportError(error as Error, {
      operation: "buy_order",
      tokenId,
      balance: state.balance,
      mode: state.mode,
    });
    
    logger.error(`Buy failed: ${error}`);
    return false;
  }
}

// ============ API CALLS ============

async function fetchMarketData(marketId: string) {
  try {
    const response = await fetch(`https://api.polymarket.com/markets/${marketId}`);
    const data = await response.json();
    return data;
  } catch (error) {
    // Report API errors
    await reportError(error as Error, {
      operation: "fetch_market_data",
      marketId,
    });
    
    throw error; // Re-throw if critical
  }
}

// ============ SCHEDULED TASKS ============

// Oracle daily review
setInterval(async () => {
  try {
    await runOracleReview();
  } catch (error) {
    await reportError(error as Error, {
      operation: "oracle_daily_review",
      cycleCount: state.cycleCount,
      balance: state.balance,
      uptime: Date.now() - state.startTime,
    });
  }
}, 24 * 60 * 60 * 1000);

// ============ SHUTDOWN HANDLERS ============

process.on("SIGTERM", async () => {
  logger.info("🛑 Received SIGTERM, shutting down...");
  
  try {
    await cleanup();
  } catch (error) {
    await reportError(error as Error, {
      operation: "shutdown_cleanup",
      balance: state.balance,
      uptime: Date.now() - state.startTime,
    });
  }
  
  process.exit(0);
});

// ============ BEST PRACTICES ============

/*
 * DO: Report unexpected errors
 */
try {
  await fetchPositions();
} catch (error) {
  // ✅ Report - this shouldn't fail
  await reportError(error as Error, { operation: "fetch_positions" });
}

/*
 * DON'T: Report validation errors
 */
if (balance < minBalance) {
  // ❌ Don't report - this is expected validation
  logger.warn("Balance too low");
  return;
}

/*
 * DO: Include rich context
 */
await reportError(error as Error, {
  operation: "apex_velocity_momentum_buy",  // ✅ Descriptive
  marketId: market.id,                      // ✅ Market context
  tokenId: token.id,                        // ✅ Token context
  balance: state.balance,                   // ✅ Financial context
  mode: state.mode,                         // ✅ Mode context
  cycleCount: state.cycleCount,             // ✅ Timing context
  uptime: Date.now() - state.startTime,     // ✅ Uptime context
});

/*
 * DO: Use try-catch for non-critical operations
 */
try {
  await sendTelegramNotification();
} catch (error) {
  // Non-critical - just log, don't report
  logger.warn(`Telegram notification failed: ${error}`);
}

/*
 * DO: Wrap critical sections
 */
try {
  await executeCriticalTrade();
} catch (error) {
  // ✅ Report critical errors immediately
  await reportError(error as Error, {
    operation: "critical_trade",
    marketId: market.id,
    balance: state.balance,
  });
  
  // Then handle locally
  await handleCriticalError(error);
}

// ============ ERROR STATISTICS ============

// Log error stats periodically
setInterval(() => {
  const reporter = getErrorReporter();
  if (reporter) {
    const stats = reporter.getStats();
    logger.info(`📊 Error Stats: ${stats.totalErrors} total, ${stats.uniqueErrors} unique`);
  }
}, 3600000); // Every hour

// Start the bot
main().catch(async (error) => {
  console.error("Fatal error:", error);
  
  // Try to report even fatal errors
  try {
    await reportError(error as Error, {
      operation: "fatal_error",
    });
  } catch {
    // Can't do anything if reporting fails
  }
  
  process.exit(1);
});
