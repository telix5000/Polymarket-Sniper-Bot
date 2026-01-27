/**
 * V2 Targets - Copy trading address management
 * 
 * Fetches top traders from Polymarket leaderboard API (v1)
 * These are the wallets we track for copy trading signals
 */

import axios from "axios";
import { POLYMARKET_API } from "./constants";

/**
 * Fetch top traders from leaderboard v1 API
 * Returns proxyWallet addresses (where trades happen)
 */
export async function fetchLeaderboard(limit = 100): Promise<string[]> {
  try {
    // Use v1 leaderboard API - returns proxyWallet addresses
    const url = `${POLYMARKET_API.DATA}/v1/leaderboard?category=OVERALL&timePeriod=WEEK&orderBy=PNL&limit=${Math.min(limit, 500)}`;
    const { data } = await axios.get(url, { timeout: 15000 });

    if (!Array.isArray(data)) return [];

    return data
      .filter((t: any) => t.proxyWallet || t.address)
      .map((t: any) => (t.proxyWallet || t.address).toLowerCase());
  } catch (err) {
    console.warn(`⚠️ Leaderboard fetch failed: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

/**
 * Get target addresses from env or leaderboard
 * Priority: TARGET_ADDRESSES env > COPY_ADDRESSES env > MONITOR_ADDRESSES env > leaderboard API
 */
export async function getTargetAddresses(): Promise<string[]> {
  const env = process.env.TARGET_ADDRESSES ?? 
              process.env.COPY_ADDRESSES ?? 
              process.env.MONITOR_ADDRESSES;

  if (env) {
    const addrs = env
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .filter((a) => a.startsWith("0x") && a.length === 42);

    if (addrs.length > 0) {
      console.log(`🎯 Using ${addrs.length} target addresses from env`);
      return addrs;
    }
  }

  const limit = parseInt(process.env.LEADERBOARD_LIMIT ?? "100", 10);
  const addresses = await fetchLeaderboard(limit);
  if (addresses.length > 0) {
    console.log(`🐋 Fetched ${addresses.length} top traders from leaderboard`);
  }
  return addresses;
}
