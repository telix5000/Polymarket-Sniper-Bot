/**
 * V2 Leaderboard Targets
 * Fetch top traders from Polymarket leaderboard for copy trading
 */

import axios from "axios";
import { POLYMARKET_API } from "./constants";

export interface LeaderboardTrader {
  address: string;
  rank: number;
  profit: number;
}

/**
 * Fetch top traders from Polymarket leaderboard
 */
export async function fetchLeaderboardAddresses(limit: number = 20): Promise<string[]> {
  try {
    const url = `${POLYMARKET_API.GAMMA_API}/leaderboard?limit=${Math.min(limit, 50)}`;
    const { data } = await axios.get(url, { timeout: 10000 });

    if (!Array.isArray(data)) {
      console.warn("[Leaderboard] Unexpected response format");
      return [];
    }

    const addresses = data
      .filter((t: any) => t.address && typeof t.address === "string")
      .map((t: any) => t.address.toLowerCase());

    console.log(`[Leaderboard] Fetched ${addresses.length} top traders`);
    return addresses;
  } catch (err) {
    console.error(`[Leaderboard] Fetch error: ${err}`);
    return [];
  }
}

/**
 * Parse target addresses from environment or fetch from leaderboard
 */
export async function getTargetAddresses(): Promise<string[]> {
  // Check environment first
  const envAddresses = process.env.TARGET_ADDRESSES ?? 
                       process.env.COPY_ADDRESSES ?? 
                       process.env.MONITOR_ADDRESSES;

  if (envAddresses) {
    const addresses = envAddresses
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .filter((a) => a.startsWith("0x") && a.length === 42);

    if (addresses.length > 0) {
      console.log(`[Targets] Using ${addresses.length} addresses from environment`);
      return addresses;
    }
  }

  // Fallback to leaderboard
  const limit = parseInt(process.env.LEADERBOARD_LIMIT ?? "20", 10);
  return fetchLeaderboardAddresses(limit);
}
