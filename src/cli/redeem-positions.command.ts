/**
 * CLI command to manually redeem resolved (winning/losing) positions
 *
 * Usage:
 *   npm run redeem [--min-value=X] [--exclude-losses]
 *
 * Options:
 *   --exclude-losses  Exclude $0 positions (losers) from redemption. Default: false (losses included)
 *   --min-value=X     Minimum position value in USD to redeem. Default: 0 (no minimum)
 *
 * Environment variables:
 *   PRIVATE_KEY - Required: Your wallet private key
 *   RPC_URL - Required: Polygon RPC endpoint
 *
 * This command:
 *   1. Fetches all your positions from Polymarket
 *   2. Identifies positions marked as redeemable (resolved markets)
 *   3. Performs on-chain preflight check (payoutDenominator > 0)
 *   4. Calls the CTF contract to redeem them for USDC
 *
 * By default:
 *   - All positions are redeemed (no minimum value threshold)
 *   - $0 losers are INCLUDED (redeemed for cleanup)
 *   - Positions not yet resolved on-chain are SKIPPED
 *   - Use --exclude-losses to skip $0 positions if you want to save gas
 *
 * Examples:
 *   npm run redeem                           # Redeem all (default)
 *   npm run redeem --min-value=0.0001        # Only positions >= $0.0001
 *   npm run redeem --exclude-losses          # Exclude $0 losers
 */

import "dotenv/config";
import { createPolymarketAuthFromEnv } from "../clob/polymarket-auth";
import { ConsoleLogger } from "../utils/logger.util";
import { AutoRedeemStrategy } from "../strategies/auto-redeem";

// Parse CLI arguments and npm config environment variables
function parseArgs(): { includeLosses: boolean; minValueUsd: number } {
  const args = process.argv.slice(2);
  let includeLosses = true; // Default: include losses for cleanup
  let minValueUsd = 0; // Default: no minimum threshold, redeem anything

  // First, check npm config environment variables (set when using npm run redeem --min-value=X)
  // npm converts --min-value=X to npm_config_min_value=X environment variable
  const npmConfigMinValue = process.env.npm_config_min_value;
  if (npmConfigMinValue !== undefined && npmConfigMinValue !== "") {
    const value = parseFloat(npmConfigMinValue);
    if (!isNaN(value) && value >= 0) {
      minValueUsd = value;
    }
  }

  // Check for --exclude-losses in npm config (npm run redeem --exclude-losses)
  if (process.env.npm_config_exclude_losses === "true") {
    includeLosses = false;
  }

  // Then check CLI args (these take precedence if both are provided)
  for (const arg of args) {
    if (arg === "--exclude-losses" || arg === "--no-include-losses") {
      includeLosses = false;
    } else if (arg === "--include-losses") {
      // Keep for backward compatibility (now a no-op since it's the default)
      includeLosses = true;
    } else if (arg.startsWith("--min-value=")) {
      const value = parseFloat(arg.split("=")[1]);
      if (!isNaN(value) && value >= 0) {
        minValueUsd = value;
      }
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
Usage: npm run redeem [--min-value=X] [--exclude-losses]

Options:
  --exclude-losses    Exclude $0 positions (losers) from redemption (saves gas)
  --min-value=X       Minimum position value in USD to redeem (default: 0, no minimum)
  --help, -h          Show this help message

Examples:
  # Redeem all positions including $0 losers (default)
  npm run redeem

  # Only redeem positions worth at least 0.0001 USD
  npm run redeem --min-value=0.0001

  # Only redeem positions worth at least $1
  npm run redeem --min-value=1

  # Exclude $0 losers (save gas, skip cleanup)
  npm run redeem --exclude-losses

  # Combine options
  npm run redeem --min-value=0.001 --exclude-losses
`);
      process.exit(0);
    }
  }

  return { includeLosses, minValueUsd };
}

async function run(): Promise<void> {
  const { includeLosses, minValueUsd } = parseArgs();

  const logger = new ConsoleLogger();
  logger.info("🔄 Starting position redemption...\n");
  logger.info(
    `📋 Options: includeLosses=${includeLosses}, minValueUsd=$${minValueUsd}\n`,
  );

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

  // Initialize auto-redeem strategy
  // AutoRedeem fetches positions directly from Data API and checks on-chain
  // payoutDenominator - it does NOT use PositionTracker.
  logger.info("📊 Initializing redemption (fetches positions directly)...");
  const autoRedeemStrategy = new AutoRedeemStrategy({
    client,
    logger,
    config: {
      enabled: true,
      minPositionUsd: minValueUsd,
      checkIntervalMs: 30000, // Not used in CLI, but required by type
    },
  });

  // Execute redemptions with on-chain preflight checks
  logger.info("🔄 Executing redemptions (with on-chain preflight checks)...\n");
  const results = await autoRedeemStrategy.forceRedeemAll(includeLosses);

  // Categorized summary
  const successful = results.filter((r) => r.success);
  const skippedNotResolved = results.filter(
    (r) => r.skippedReason === "NOT_RESOLVED_ONCHAIN",
  );
  const skippedBelowMin = results.filter(
    (r) => r.skippedReason === "BELOW_MIN_VALUE",
  );
  const failed = results.filter((r) => !r.success && !r.skippedReason);

  // Detailed results
  if (successful.length > 0) {
    logger.info("\n✅ Successfully redeemed:");
    for (const result of successful) {
      logger.info(
        `  - Market: ${result.marketId.substring(0, 16)}... | Value: $${result.positionValueUsd?.toFixed(2) ?? "?"} | TX: ${result.transactionHash}`,
      );
    }
  }

  if (skippedNotResolved.length > 0) {
    logger.info("\n⏭️ Skipped (not resolved on-chain yet):");
    for (const result of skippedNotResolved) {
      logger.info(
        `  - Market: ${result.marketId.substring(0, 16)}... | Value: $${result.positionValueUsd?.toFixed(2) ?? "?"}`,
      );
    }
  }

  if (skippedBelowMin.length > 0) {
    logger.info("\n⏭️ Skipped ($0 losers / below min value):");
    for (const result of skippedBelowMin) {
      logger.info(
        `  - Market: ${result.marketId.substring(0, 16)}... | Value: $${result.positionValueUsd?.toFixed(4) ?? "?"}`,
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
  // Exit with success if any were redeemed, or if everything was intentionally skipped
  const exitCode =
    successful.length > 0 ||
    (failed.length === 0 &&
      skippedNotResolved.length + skippedBelowMin.length > 0)
      ? 0
      : 1;
  process.exit(exitCode);
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
