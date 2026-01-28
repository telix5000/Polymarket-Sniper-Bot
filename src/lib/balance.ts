/**
 * V2 Balance - Wallet balance utilities with RPC throttling
 *
 * This module provides balance fetching with intelligent caching to reduce
 * Infura RPC calls. Balances are cached and only refreshed when:
 * - The configured interval expires (default: 10s)
 * - A trade is executed (via forceRefresh)
 * - A deposit/withdrawal likely occurred (via forceRefresh)
 */

import { Contract, type Wallet } from "ethers";
import { POLYGON, ERC20_ABI } from "./constants";

// ═══════════════════════════════════════════════════════════════════════════
// RAW BALANCE FETCHES (direct RPC calls)
// ═══════════════════════════════════════════════════════════════════════════

/** Result type for balance fetches that distinguishes success from errors */
export interface BalanceFetchResult {
  value: number;
  success: boolean;
  error?: string;
}

/**
 * Get USDC balance for a specific address (direct RPC call)
 * Returns result object with success flag to distinguish 0 balance from errors
 */
export async function getUsdcBalanceWithStatus(
  wallet: Wallet,
  address: string,
): Promise<BalanceFetchResult> {
  try {
    const contract = new Contract(
      POLYGON.USDC_ADDRESS,
      ERC20_ABI,
      wallet.provider,
    );
    const balance = await contract.balanceOf(address);
    return {
      value: Number(balance) / 10 ** POLYGON.USDC_DECIMALS,
      success: true,
    };
  } catch (err) {
    return {
      value: 0,
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/**
 * Get USDC balance for a specific address (direct RPC call)
 * @deprecated Use getUsdcBalanceWithStatus for error-aware balance fetching
 */
export async function getUsdcBalance(
  wallet: Wallet,
  address: string,
): Promise<number> {
  const result = await getUsdcBalanceWithStatus(wallet, address);
  return result.value;
}

/**
 * Get POL (native token) balance for a specific address (direct RPC call)
 * Returns result object with success flag to distinguish 0 balance from errors
 */
export async function getPolBalanceWithStatus(
  wallet: Wallet,
  address: string,
): Promise<BalanceFetchResult> {
  try {
    const balance = await wallet.provider?.getBalance(address);
    return {
      value: balance ? Number(balance) / 1e18 : 0,
      success: true,
    };
  } catch (err) {
    return {
      value: 0,
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/**
 * Get POL (native token) balance for a specific address (direct RPC call)
 * @deprecated Use getPolBalanceWithStatus for error-aware balance fetching
 */
export async function getPolBalance(
  wallet: Wallet,
  address: string,
): Promise<number> {
  const result = await getPolBalanceWithStatus(wallet, address);
  return result.value;
}

/**
 * Get USDC allowance for CTF Exchange
 * This checks if the address has approved USDC spending for trading
 */
export async function getUsdcAllowance(
  wallet: Wallet,
  ownerAddress: string,
): Promise<number> {
  try {
    const contract = new Contract(
      POLYGON.USDC_ADDRESS,
      ERC20_ABI,
      wallet.provider,
    );
    const allowance = await contract.allowance(
      ownerAddress,
      POLYGON.CTF_EXCHANGE,
    );
    return Number(allowance) / 10 ** POLYGON.USDC_DECIMALS;
  } catch {
    return 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BALANCE CACHE - Throttled balance fetching to reduce RPC spam
// ═══════════════════════════════════════════════════════════════════════════

/** Default balance refresh interval (10 seconds) */
export const DEFAULT_BALANCE_REFRESH_INTERVAL_MS = 10_000;

/** Cached balance data */
interface CachedBalances {
  usdc: number;
  pol: number;
  lastFetchTime: number;
  /** Whether the last fetch was successful (both USDC and POL) */
  lastFetchSuccess: boolean;
  /** Error message if last fetch failed */
  lastFetchError?: string;
}

/**
 * BalanceCache provides throttled balance fetching to reduce Infura RPC calls.
 *
 * Instead of calling eth_call and eth_getBalance every 100-200ms loop iteration,
 * this cache stores balances in memory and only refreshes when:
 * - The configured interval expires
 * - forceRefresh() is called (after trades, deposits, withdrawals)
 *
 * Usage:
 * ```ts
 * const cache = new BalanceCache(wallet, address, 10000); // 10s interval
 * const { usdc, pol } = await cache.getBalances();
 *
 * // After a trade executes:
 * await cache.forceRefresh();
 * ```
 */
export class BalanceCache {
  private wallet: Wallet;
  private address: string;
  private refreshIntervalMs: number;
  private cache: CachedBalances | null = null;
  private fetchInProgress: Promise<CachedBalances> | null = null;
  private rpcFetchCount = 0;

  /**
   * Create a new BalanceCache
   * @param wallet - Ethers wallet instance
   * @param address - Wallet address to fetch balances for
   * @param refreshIntervalMs - Minimum interval between RPC fetches (default: 10000ms)
   */
  constructor(
    wallet: Wallet,
    address: string,
    refreshIntervalMs: number = DEFAULT_BALANCE_REFRESH_INTERVAL_MS,
  ) {
    this.wallet = wallet;
    this.address = address;
    this.refreshIntervalMs = refreshIntervalMs;
  }

  /**
   * Get the total number of RPC fetches performed since creation
   */
  getRpcFetchCount(): number {
    return this.rpcFetchCount;
  }

  /**
   * Check if the cache is stale (needs refresh)
   */
  isStale(): boolean {
    if (!this.cache) return true;
    return Date.now() - this.cache.lastFetchTime >= this.refreshIntervalMs;
  }

  /**
   * Get the age of the cached data in milliseconds
   */
  getCacheAgeMs(): number {
    if (!this.cache) return Infinity;
    return Date.now() - this.cache.lastFetchTime;
  }

  /**
   * Get cached balances, refreshing from RPC if stale
   *
   * This is the main method for getting balances. It will:
   * - Return cached values if still fresh
   * - Fetch from RPC and update cache if stale
   * - Coalesce concurrent requests (only one RPC call in flight)
   *
   * @returns Object with usdc and pol balances
   */
  async getBalances(): Promise<{ usdc: number; pol: number }> {
    // Return cached values if still fresh
    if (this.cache && !this.isStale()) {
      return { usdc: this.cache.usdc, pol: this.cache.pol };
    }

    // Fetch fresh data (coalescing concurrent requests)
    const freshData = await this.fetchBalances();
    return { usdc: freshData.usdc, pol: freshData.pol };
  }

  /**
   * Force a refresh of balances from RPC, bypassing the interval check.
   *
   * Call this after:
   * - A trade executes successfully
   * - A deposit/withdrawal is detected
   * - Any operation that changes wallet balances
   *
   * @returns Fresh balances from RPC
   */
  async forceRefresh(): Promise<{ usdc: number; pol: number }> {
    // If a fetch is already in progress, wait for it to complete first
    // then do another fetch to ensure we have truly fresh data
    if (this.fetchInProgress) {
      await this.fetchInProgress;
    }
    // Now invalidate cache and force a new fetch
    this.cache = null;
    const freshData = await this.fetchBalances();
    return { usdc: freshData.usdc, pol: freshData.pol };
  }

  /**
   * Get the last known balances without making any RPC calls.
   * Returns null if no cached data is available.
   */
  getCachedBalances(): { usdc: number; pol: number } | null {
    if (!this.cache) return null;
    return { usdc: this.cache.usdc, pol: this.cache.pol };
  }

  /**
   * Internal method to fetch balances from RPC.
   * Coalesces concurrent requests to avoid redundant RPC calls.
   */
  private async fetchBalances(): Promise<CachedBalances> {
    // If a fetch is already in progress, wait for it
    if (this.fetchInProgress) {
      return this.fetchInProgress;
    }

    // Start a new fetch
    this.fetchInProgress = this.doFetchBalances();

    try {
      const result = await this.fetchInProgress;
      return result;
    } finally {
      this.fetchInProgress = null;
    }
  }

  /**
   * Actually perform the RPC fetch (parallel USDC + POL)
   * Handles errors gracefully by preserving previous cache values on failure
   */
  private async doFetchBalances(): Promise<CachedBalances> {
    const startTime = Date.now();
    this.rpcFetchCount++;

    // Fetch both balances in parallel with error status
    const [usdcResult, polResult] = await Promise.all([
      getUsdcBalanceWithStatus(this.wallet, this.address),
      getPolBalanceWithStatus(this.wallet, this.address),
    ]);

    const fetchTime = Date.now() - startTime;
    const now = Date.now();

    // Check if both fetches succeeded
    const fetchSuccess = usdcResult.success && polResult.success;
    const errors: string[] = [];
    if (!usdcResult.success) errors.push(`USDC: ${usdcResult.error}`);
    if (!polResult.success) errors.push(`POL: ${polResult.error}`);

    // If fetch failed and we have a previous cache, preserve those values
    // This prevents treating network errors as "zero balance"
    if (!fetchSuccess && this.cache) {
      console.warn(
        `⚠️ [RPC] Balance fetch #${this.rpcFetchCount} failed (${errors.join(", ")}), using previous cached values`,
      );
      // Update timestamp to prevent immediate retry, but keep old values
      this.cache = {
        usdc: this.cache.usdc,
        pol: this.cache.pol,
        lastFetchTime: now,
        lastFetchSuccess: false,
        lastFetchError: errors.join("; "),
      };
      return this.cache;
    }

    // Log the RPC fetch for visibility
    if (fetchSuccess) {
      console.log(
        `💰 [RPC] Balance fetch #${this.rpcFetchCount}: $${usdcResult.value.toFixed(2)} USDC, ${polResult.value.toFixed(4)} POL (${fetchTime}ms)`,
      );
    } else {
      // First fetch (no cache) but it failed - log warning and use zeros
      console.warn(
        `⚠️ [RPC] Balance fetch #${this.rpcFetchCount} failed (${errors.join(", ")}), no previous cache available`,
      );
    }

    // Update cache
    this.cache = {
      usdc: usdcResult.value,
      pol: polResult.value,
      lastFetchTime: now,
      lastFetchSuccess: fetchSuccess,
      lastFetchError: fetchSuccess ? undefined : errors.join("; "),
    };

    return this.cache;
  }

  /**
   * Check if the last fetch was successful
   */
  wasLastFetchSuccessful(): boolean {
    return this.cache?.lastFetchSuccess ?? false;
  }

  /**
   * Get the error from the last fetch attempt (if any)
   */
  getLastFetchError(): string | undefined {
    return this.cache?.lastFetchError;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SINGLETON CACHE INSTANCE (for use in start.ts)
// ═══════════════════════════════════════════════════════════════════════════

let globalBalanceCache: BalanceCache | null = null;

/**
 * Initialize the global balance cache singleton.
 * Must be called once at startup before using getBalanceCache().
 *
 * @param wallet - Ethers wallet instance
 * @param address - Wallet address
 * @param refreshIntervalMs - Refresh interval (default: 10000ms)
 */
export function initBalanceCache(
  wallet: Wallet,
  address: string,
  refreshIntervalMs: number = DEFAULT_BALANCE_REFRESH_INTERVAL_MS,
): BalanceCache {
  globalBalanceCache = new BalanceCache(wallet, address, refreshIntervalMs);
  console.log(
    `💰 Balance cache initialized (refresh interval: ${refreshIntervalMs}ms)`,
  );
  return globalBalanceCache;
}

/**
 * Get the global balance cache singleton.
 * Returns null if not initialized.
 */
export function getBalanceCache(): BalanceCache | null {
  return globalBalanceCache;
}
