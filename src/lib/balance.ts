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

/**
 * Get USDC balance for a specific address (direct RPC call)
 */
export async function getUsdcBalance(
  wallet: Wallet,
  address: string,
): Promise<number> {
  try {
    const contract = new Contract(
      POLYGON.USDC_ADDRESS,
      ERC20_ABI,
      wallet.provider,
    );
    const balance = await contract.balanceOf(address);
    return Number(balance) / 10 ** POLYGON.USDC_DECIMALS;
  } catch {
    return 0;
  }
}

/**
 * Get POL (native token) balance for a specific address (direct RPC call)
 */
export async function getPolBalance(
  wallet: Wallet,
  address: string,
): Promise<number> {
  try {
    const balance = await wallet.provider?.getBalance(address);
    return balance ? Number(balance) / 1e18 : 0;
  } catch {
    return 0;
  }
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
    // Invalidate cache to force fetch
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
   */
  private async doFetchBalances(): Promise<CachedBalances> {
    const startTime = Date.now();
    this.rpcFetchCount++;

    // Fetch both balances in parallel
    const [usdc, pol] = await Promise.all([
      getUsdcBalance(this.wallet, this.address),
      getPolBalance(this.wallet, this.address),
    ]);

    const fetchTime = Date.now() - startTime;
    const now = Date.now();

    // Log the RPC fetch for visibility
    console.log(
      `💰 [RPC] Balance fetch #${this.rpcFetchCount}: $${usdc.toFixed(2)} USDC, ${pol.toFixed(4)} POL (${fetchTime}ms)`,
    );

    // Update cache
    this.cache = {
      usdc,
      pol,
      lastFetchTime: now,
    };

    return this.cache;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SINGLETON CACHE INSTANCE (for use in start.ts)
// ═══════════════════════════════════════════════════════════════════════════

let globalBalanceCache: BalanceCache | null = null;

/**
 * Initialize the global balance cache singleton.
 * Must be called once at startup before using getGlobalBalanceCache().
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
