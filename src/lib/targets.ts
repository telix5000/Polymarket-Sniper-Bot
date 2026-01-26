/**
 * V2 Targets - Copy trading address management
 */

import axios from "axios";
import { POLYMARKET_API } from "./constants";

/**
 * Fetch top traders from leaderboard
 */
export async function fetchLeaderboard(limit = 20): Promise<string[]> {
  try {
    const url = `${POLYMARKET_API.GAMMA}/leaderboard?limit=${Math.min(limit, 50)}`;
    const { data } = await axios.get(url, { timeout: 10000 });

    if (!Array.isArray(data)) return [];

    return data
      .filter((t: any) => t.address)
      .map((t: any) => t.address.toLowerCase());
  } catch {
    return [];
  }
}

/**
 * Get target addresses from env or leaderboard
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

    if (addrs.length > 0) return addrs;
  }

  const limit = parseInt(process.env.LEADERBOARD_LIMIT ?? "20", 10);
  return fetchLeaderboard(limit);
}
