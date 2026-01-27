#!/usr/bin/env ts-node
/**
 * CLI script to print target addresses from the Polymarket leaderboard.
 * Outputs a comma-separated list (no spaces) suitable for use in env vars.
 *
 * Usage:
 *   npx ts-node scripts/printTargets.ts
 *   npm run print-targets
 *
 * Environment variables:
 *   TARGET_ADDRESSES - If set, prints these instead of fetching from leaderboard
 *   LEADERBOARD_LIMIT - Number of addresses to fetch (default: 100, max: 500)
 *   LEADERBOARD_TTL_SECONDS - Cache TTL in seconds (default: 3600)
 *   LEADERBOARD_CACHE_FILE - Cache file path (default: .leaderboard-cache.json)
 */

import "dotenv/config";
import {
  getTargetAddresses,
  getDefaultLeaderboardOptions,
} from "../src/targets";

// Silent logger for CLI (we only want the addresses output)
const silentLogger = {
  info: () => {},
  warn: () => {},
  error: (msg: string) => console.error(msg),
  debug: () => {},
};

async function main(): Promise<void> {
  try {
    const opts = getDefaultLeaderboardOptions();
    const addresses = await getTargetAddresses(opts, silentLogger);

    if (addresses.length === 0) {
      console.error(
        "No addresses found. Set TARGET_ADDRESSES or check network connectivity.",
      );
      process.exit(1);
    }

    // Output comma-separated, no spaces
    console.log(addresses.join(","));
  } catch (err) {
    console.error(
      "Error fetching addresses:",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }
}

main();
