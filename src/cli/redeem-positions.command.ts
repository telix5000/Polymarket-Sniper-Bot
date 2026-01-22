/**
 * CLI command to manually redeem resolved (winning/losing) positions
 *
 * Usage:
 *   npx ts-node src/cli/redeem-positions.command.ts
 *
 * Environment variables:
 *   PRIVATE_KEY - Required: Your wallet private key
 *   RPC_URL - Required: Polygon RPC endpoint
 *
 * This command:
 *   1. Fetches all your positions from Polymarket
 *   2. Identifies positions marked as redeemable (resolved markets)
 *   3. Calls the CTF contract to redeem them for USDC
 */

import "dotenv/config";
import { createPolymarketAuthFromEnv } from "../clob/polymarket-auth";
import { ConsoleLogger } from "../utils/logger.util";
import { PositionTracker } from "../strategies/position-tracker";
import { AutoRedeemStrategy } from "../strategies/auto-redeem";

async function run(): Promise<void> {
  const logger = new ConsoleLogger();
  logger.info("🔄 Starting position redemption...\n");

  // Authenticate
  logger.info("🔐 Authenticating with Polymarket...");
  const auth = createPolymarketAuthFromEnv(logger);
  const authResult = await auth.authenticate();

  if (!authResult.success) {
    logger.error(`❌ Authentication failed: ${authResult.error}`);
    process.exit(1);
  }
  logger.info("✅ Authentication successful\n");

  // Get authenticated CLOB client
  const client = await auth.getClobClient();
  logger.info(`💳 Wallet: ${client.wallet.address}\n`);

  // Initialize position tracker
  logger.info("📊 Fetching positions...");
  const positionTracker = new PositionTracker({
    client,
    logger,
    refreshIntervalMs: 30000,
  });

  // Manually refresh to get initial positions
  await positionTracker.refresh();

  const allPositions = positionTracker.getPositions();
  const redeemablePositions = allPositions.filter(
    (pos) => pos.redeemable === true,
  );

  logger.info(`📈 Total positions: ${allPositions.length}`);
  logger.info(`💰 Redeemable positions: ${redeemablePositions.length}\n`);

  if (redeemablePositions.length === 0) {
    logger.info(
      "✅ No positions to redeem. All markets are still active or already claimed.\n",
    );
    process.exit(0);
  }

  // Display redeemable positions
  logger.info("📋 Redeemable positions found:");
  for (const pos of redeemablePositions) {
    const value = pos.size * pos.currentPrice;
    const winLoss = pos.currentPrice >= 0.5 ? "WIN" : "LOSS";
    logger.info(
      `  - Market: ${pos.marketId.substring(0, 16)}... | Side: ${pos.side} | Size: ${pos.size.toFixed(2)} | Value: $${value.toFixed(2)} (${winLoss})`,
    );
  }
  logger.info("");

  // Initialize auto-redeem strategy
  const autoRedeemStrategy = new AutoRedeemStrategy({
    client,
    logger,
    positionTracker,
    config: {
      enabled: true,
      minPositionUsd: 0, // Redeem all positions (no minimum)
    },
  });

  // Execute redemptions
  logger.info("🔄 Executing redemptions...\n");
  const results = await autoRedeemStrategy.forceRedeemAll();

  // Summary
  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  logger.info("\n📊 Redemption Summary:");
  logger.info(`  ✅ Successful: ${successful.length}`);
  logger.info(`  ❌ Failed: ${failed.length}`);

  if (successful.length > 0) {
    logger.info("\n✅ Successfully redeemed:");
    for (const result of successful) {
      logger.info(
        `  - Market: ${result.marketId.substring(0, 16)}... | Amount: $${result.amountRedeemed ?? "?"} | TX: ${result.transactionHash}`,
      );
    }
  }

  if (failed.length > 0) {
    logger.info("\n❌ Failed redemptions:");
    for (const result of failed) {
      logger.info(
        `  - Market: ${result.marketId.substring(0, 16)}... | Error: ${result.error}`,
      );
    }
  }

  logger.info("\n✅ Done!");
  process.exit(successful.length > 0 ? 0 : 1);
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
