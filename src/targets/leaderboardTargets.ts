import axios, { AxiosError } from "axios";
import * as fs from "fs";
import * as path from "path";
import { ConsoleLogger, Logger } from "../utils/logger.util";

/**
 * Options for fetching target addresses from the Polymarket leaderboard
 */
export interface LeaderboardOptions {
  /** Number of top addresses to fetch (clamped to max 50) */
  limit: number;
  /** Leaderboard category (currently only "OVERALL" supported) */
  category: "OVERALL";
  /** Time period for leaderboard data */
  timePeriod: "MONTH";
  /** Order by field (PNL = profit and loss) */
  orderBy: "PNL";
  /** Path to cache file for persisting addresses */
  cacheFile: string;
  /** Time-to-live for cache in seconds */
  ttlSeconds: number;
}

/**
 * Structure for cached leaderboard data
 */
interface LeaderboardCache {
  fetchedAt: number;
  addresses: string[];
}

/**
 * Structure of a single leaderboard entry from the API
 */
interface LeaderboardEntry {
  proxyWallet?: string;
  [key: string]: unknown;
}

const LEADERBOARD_API_URL = "https://data-api.polymarket.com/v1/leaderboard";
const MAX_LIMIT = 50;
const BACKOFF_DELAYS_MS = [1000, 2000, 4000]; // Exponential backoff for retries

/**
 * Validates that a string is a valid EVM address (0x-prefixed, 40 hex chars)
 */
export function isValidEvmAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Normalizes and deduplicates addresses
 */
export function normalizeAddresses(addresses: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const addr of addresses) {
    const normalized = addr.toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }

  return result;
}

/**
 * Parses leaderboard API response and extracts valid proxyWallet addresses
 */
export function parseLeaderboardResponse(data: unknown): string[] {
  if (!Array.isArray(data)) {
    return [];
  }

  const addresses: string[] = [];

  for (const entry of data as LeaderboardEntry[]) {
    const wallet = entry?.proxyWallet;
    if (typeof wallet === "string" && isValidEvmAddress(wallet)) {
      addresses.push(wallet);
    }
  }

  return normalizeAddresses(addresses);
}

/**
 * Reads cached addresses from disk
 */
function readCache(cacheFile: string): LeaderboardCache | null {
  try {
    if (!fs.existsSync(cacheFile)) {
      return null;
    }
    const content = fs.readFileSync(cacheFile, "utf-8");
    const data = JSON.parse(content) as LeaderboardCache;

    // Validate cache structure
    if (
      typeof data.fetchedAt !== "number" ||
      !Array.isArray(data.addresses) ||
      !data.addresses.every((a) => typeof a === "string")
    ) {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

/**
 * Writes addresses to cache file
 */
function writeCache(cacheFile: string, addresses: string[]): void {
  try {
    // Ensure directory exists
    const dir = path.dirname(cacheFile);
    if (dir && dir !== "." && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const cache: LeaderboardCache = {
      fetchedAt: Date.now(),
      addresses,
    };
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), "utf-8");
  } catch {
    // Silently fail cache write - not critical
  }
}

/**
 * Checks if cache is still fresh based on TTL
 */
function isCacheFresh(cache: LeaderboardCache, ttlSeconds: number): boolean {
  const ageMs = Date.now() - cache.fetchedAt;
  return ageMs < ttlSeconds * 1000;
}

/**
 * Delays execution for the specified milliseconds
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Determines if an error is retryable (rate limit or server error)
 */
function isRetryableError(error: AxiosError): boolean {
  const status = error.response?.status;
  return (
    status === 403 || status === 429 || (status !== undefined && status >= 500)
  );
}

/**
 * Fetches target addresses from the Polymarket leaderboard with caching support.
 *
 * @param opts - Configuration options
 * @param logger - Optional logger instance
 * @returns Array of lowercase, validated EVM addresses
 *
 * Behavior:
 * - Returns cached addresses if cache is fresh (within TTL)
 * - Fetches from API if cache is stale or missing
 * - Falls back to stale cache if API fails
 * - Returns empty array if both cache and API fail
 */
export async function getTargetAddressesFromLeaderboard(
  opts: LeaderboardOptions,
  logger: Logger = new ConsoleLogger(),
): Promise<string[]> {
  const { limit, category, timePeriod, orderBy, cacheFile, ttlSeconds } = opts;

  // Clamp limit to max 50
  const effectiveLimit = Math.min(Math.max(1, limit), MAX_LIMIT);

  // Check cache first
  const cache = readCache(cacheFile);
  if (cache && isCacheFresh(cache, ttlSeconds)) {
    logger.info(
      `[Leaderboard] Using cached addresses (${cache.addresses.length} total, ` +
        `first 3: ${cache.addresses.slice(0, 3).join(", ")}), source: cache`,
    );
    return cache.addresses;
  }

  // Try to fetch from API with retries
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= BACKOFF_DELAYS_MS.length; attempt++) {
    try {
      const url = new URL(LEADERBOARD_API_URL);
      url.searchParams.set("category", category);
      url.searchParams.set("timePeriod", timePeriod);
      url.searchParams.set("orderBy", orderBy);
      url.searchParams.set("limit", String(effectiveLimit));

      const response = await axios.get(url.toString(), {
        timeout: 10000,
        headers: {
          Accept: "application/json",
        },
      });

      const addresses = parseLeaderboardResponse(response.data);

      if (addresses.length > 0) {
        // Write to cache on successful fetch
        writeCache(cacheFile, addresses);
        logger.info(
          `[Leaderboard] Fetched ${addresses.length} addresses from API ` +
            `(first 3: ${addresses.slice(0, 3).join(", ")}), source: live`,
        );
        return addresses;
      }

      // Empty response - treat as failure and try cache
      logger.warn(
        "[Leaderboard] API returned empty response, falling back to cache",
      );
      break;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Check if we should retry
      if (
        err instanceof AxiosError &&
        isRetryableError(err) &&
        attempt < BACKOFF_DELAYS_MS.length
      ) {
        const delayMs = BACKOFF_DELAYS_MS[attempt];
        logger.warn(
          `[Leaderboard] API error (${err.response?.status || "network"}), ` +
            `retrying in ${delayMs}ms (attempt ${attempt + 1}/${BACKOFF_DELAYS_MS.length + 1})`,
        );
        await delay(delayMs);
        continue;
      }

      logger.warn(
        `[Leaderboard] API fetch failed: ${lastError.message}, falling back to cache`,
      );
      break;
    }
  }

  // Fall back to stale cache if available
  if (cache && cache.addresses.length > 0) {
    logger.info(
      `[Leaderboard] Using stale cached addresses (${cache.addresses.length} total, ` +
        `first 3: ${cache.addresses.slice(0, 3).join(", ")}), source: stale-cache`,
    );
    return cache.addresses;
  }

  // Both failed
  logger.error(
    "[Leaderboard] Failed to fetch addresses and no cache available. " +
      "Set TARGET_ADDRESSES env var or ensure network connectivity.",
  );
  return [];
}

/**
 * Gets target addresses with env override support.
 * If TARGET_ADDRESSES env var is set, uses that instead of fetching from leaderboard.
 *
 * @param opts - Leaderboard options (used if env var not set)
 * @param logger - Optional logger instance
 * @returns Array of lowercase, validated EVM addresses
 */
export async function getTargetAddresses(
  opts: LeaderboardOptions,
  logger: Logger = new ConsoleLogger(),
): Promise<string[]> {
  // Check for env override
  const envAddresses =
    process.env.TARGET_ADDRESSES ?? process.env.target_addresses;

  if (envAddresses && envAddresses.trim().length > 0) {
    const addresses = envAddresses
      .split(",")
      .map((a) => a.trim())
      .filter((a) => a.length > 0);

    // Validate and normalize
    const validAddresses = addresses.filter((a) => isValidEvmAddress(a));
    const normalized = normalizeAddresses(validAddresses);

    if (normalized.length > 0) {
      logger.info(
        `[Leaderboard] Using ${normalized.length} addresses from env ` +
          `(first 3: ${normalized.slice(0, 3).join(", ")}), source: env`,
      );
      return normalized;
    }

    logger.warn(
      "[Leaderboard] TARGET_ADDRESSES env var set but contains no valid addresses",
    );
  }

  // Fetch from leaderboard
  return getTargetAddressesFromLeaderboard(opts, logger);
}

/**
 * Creates default leaderboard options from environment variables
 */
export function getDefaultLeaderboardOptions(): LeaderboardOptions {
  const readEnv = (key: string, defaultValue: string): string =>
    process.env[key] ?? process.env[key.toLowerCase()] ?? defaultValue;

  const readNumber = (key: string, defaultValue: number): number => {
    const value = readEnv(key, String(defaultValue));
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
  };

  return {
    limit: readNumber("LEADERBOARD_LIMIT", 20),
    category: "OVERALL",
    timePeriod: "MONTH",
    orderBy: "PNL",
    cacheFile: readEnv("LEADERBOARD_CACHE_FILE", ".leaderboard-cache.json"),
    ttlSeconds: readNumber("LEADERBOARD_TTL_SECONDS", 3600), // 1 hour default
  };
}

/**
 * Populates TARGET_ADDRESSES env var from leaderboard if not already set.
 * Call this at startup before loading config.
 *
 * @param logger - Optional logger instance
 * @returns The addresses that were loaded (for logging/verification)
 */
export async function populateTargetAddressesFromLeaderboard(
  logger: Logger = new ConsoleLogger(),
): Promise<string[]> {
  const envAddresses =
    process.env.TARGET_ADDRESSES ?? process.env.target_addresses;

  // If TARGET_ADDRESSES is already set, skip leaderboard fetch
  if (envAddresses && envAddresses.trim().length > 0) {
    const addresses = envAddresses
      .split(",")
      .map((a) => a.trim())
      .filter((a) => a.length > 0 && isValidEvmAddress(a));
    const normalized = normalizeAddresses(addresses);

    if (normalized.length > 0) {
      logger.info(
        `[Leaderboard] Using ${normalized.length} addresses from env ` +
          `(first 3: ${normalized.slice(0, 3).join(", ")}), source: env`,
      );
      return normalized;
    }
  }

  // Fetch from leaderboard
  const opts = getDefaultLeaderboardOptions();
  const addresses = await getTargetAddressesFromLeaderboard(opts, logger);

  if (addresses.length > 0) {
    // Set env var for downstream config loading (comma-separated, no spaces)
    process.env.TARGET_ADDRESSES = addresses.join(",");
  }

  return addresses;
}
