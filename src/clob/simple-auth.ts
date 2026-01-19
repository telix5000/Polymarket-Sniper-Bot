/**
 * Simple CLOB Authentication
 *
 * Clean, simple authentication following the working reference bot approach:
 * - Uses createOrDeriveApiKey() for credential management
 * - No complex fallback ladders
 * - Clear success/failure logging with ✅/❌
 * - Caches credentials for reuse
 *
 * @see https://github.com/dappboris-dev/polymarket-trading-bot
 */

import { ClobClient, Chain } from "@polymarket/clob-client";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { POLYMARKET_API } from "../constants/polymarket.constants";
import type { Logger } from "../utils/logger.util";
import { asClobSigner } from "../utils/clob-signer.util";
import {
  loadCachedCreds,
  saveCachedCreds,
  clearCachedCreds,
} from "../utils/credential-storage.util";

const CLOB_HOST = POLYMARKET_API.BASE_URL;
const CHAIN_ID = Chain.POLYGON;

/**
 * Result of authentication
 */
export interface SimpleAuthResult {
  success: boolean;
  creds?: ApiKeyCreds;
  error?: string;
  cached?: boolean;
}

/**
 * Configuration for SimpleAuth
 */
export interface SimpleAuthConfig {
  privateKey: string;
  logger?: Logger;
  /** Skip cache and always derive fresh credentials */
  skipCache?: boolean;
}

/**
 * Simple, clean authentication for Polymarket CLOB
 */
export class SimpleAuth {
  private wallet: Wallet;
  private logger?: Logger;
  private skipCache: boolean;
  private cachedCreds?: ApiKeyCreds;

  constructor(config: SimpleAuthConfig) {
    if (!config.privateKey) {
      throw new Error("Private key is required");
    }

    const pk = config.privateKey.startsWith("0x")
      ? config.privateKey
      : `0x${config.privateKey}`;

    this.wallet = new Wallet(pk);
    this.logger = config.logger;
    this.skipCache = config.skipCache ?? false;
  }

  /**
   * Get wallet address
   */
  getAddress(): string {
    return this.wallet.address;
  }

  /**
   * Log with consistent formatting
   */
  private log(
    level: "info" | "warn" | "error" | "debug",
    message: string,
  ): void {
    if (this.logger) {
      this.logger[level](message);
    }
  }

  /**
   * Authenticate and get API credentials
   *
   * Flow:
   * 1. Check for cached credentials (unless skipCache)
   * 2. Verify cached credentials work
   * 3. If no cache or verification fails, use createOrDeriveApiKey()
   * 4. Save new credentials to cache
   */
  async authenticate(): Promise<SimpleAuthResult> {
    const address = this.wallet.address;
    this.log("info", `[Auth] 🔐 Authenticating wallet ${address.slice(0, 10)}...`);

    // Step 1: Check cache
    if (!this.skipCache) {
      const cached = this.loadFromCache();
      if (cached) {
        this.log("info", "[Auth] 📦 Found cached credentials, verifying...");
        const valid = await this.verifyCredentials(cached);
        if (valid) {
          this.log("info", "[Auth] ✅ Cached credentials verified");
          this.cachedCreds = cached;
          return { success: true, creds: cached, cached: true };
        }
        this.log("warn", "[Auth] ⚠️  Cached credentials invalid, will re-derive");
        this.clearCache();
      }
    }

    // Step 2: Derive credentials using createOrDeriveApiKey
    this.log("info", "[Auth] 🔄 Deriving API credentials...");

    try {
      const client = new ClobClient(
        CLOB_HOST,
        CHAIN_ID,
        asClobSigner(this.wallet),
      );

      const creds = await client.createOrDeriveApiKey();

      if (!creds || !creds.key || !creds.secret || !creds.passphrase) {
        this.log("error", "[Auth] ❌ Credentials incomplete or missing");
        return {
          success: false,
          error: "Credentials incomplete - wallet may need to trade on Polymarket first",
        };
      }

      // Step 3: Verify the new credentials
      this.log("info", "[Auth] 🔍 Verifying new credentials...");
      const valid = await this.verifyCredentials(creds);

      if (!valid) {
        this.log("error", "[Auth] ❌ New credentials failed verification");
        return {
          success: false,
          error: "Derived credentials failed verification",
        };
      }

      // Step 4: Cache the credentials
      this.saveToCache(creds);
      this.cachedCreds = creds;

      const keySuffix = creds.key.slice(-6);
      this.log("info", `[Auth] ✅ Authentication successful (key: ...${keySuffix})`);

      return { success: true, creds, cached: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = (error as { response?: { status?: number } })?.response?.status;

      if (status === 400 && message.toLowerCase().includes("could not create")) {
        this.log("error", "[Auth] ❌ Wallet has never traded on Polymarket");
        this.log("info", "[Auth] 💡 Visit https://polymarket.com and make a trade first");
        return {
          success: false,
          error: "Wallet must trade on Polymarket website first",
        };
      }

      this.log("error", `[Auth] ❌ Authentication failed: ${message}`);
      return { success: false, error: message };
    }
  }

  /**
   * Get an authenticated CLOB client
   */
  async getClient(): Promise<ClobClient | null> {
    // Use cached creds if available
    if (this.cachedCreds) {
      return new ClobClient(
        CLOB_HOST,
        CHAIN_ID,
        asClobSigner(this.wallet),
        this.cachedCreds,
      );
    }

    // Authenticate first
    const result = await this.authenticate();
    if (!result.success || !result.creds) {
      return null;
    }

    return new ClobClient(
      CLOB_HOST,
      CHAIN_ID,
      asClobSigner(this.wallet),
      result.creds,
    );
  }

  /**
   * Verify credentials by making a test API call
   */
  private async verifyCredentials(creds: ApiKeyCreds): Promise<boolean> {
    try {
      const client = new ClobClient(
        CLOB_HOST,
        CHAIN_ID,
        asClobSigner(this.wallet),
        creds,
      );

      // Use getBalanceAllowance as a simple auth check
      const response = await client.getBalanceAllowance({
        asset_type: "COLLATERAL" as never,
      });

      // Check for error response (clob-client returns objects, doesn't throw)
      const errorResponse = response as { status?: number; error?: string };
      if (errorResponse.status === 401 || errorResponse.status === 403) {
        return false;
      }
      if (errorResponse.error) {
        return false;
      }

      return true;
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status === 401 || status === 403) {
        return false;
      }
      // Network errors - treat as potentially valid
      return false;
    }
  }

  /**
   * Load credentials from cache
   */
  private loadFromCache(): ApiKeyCreds | null {
    return loadCachedCreds({
      signerAddress: this.wallet.address,
      logger: this.logger,
    });
  }

  /**
   * Save credentials to cache
   */
  private saveToCache(creds: ApiKeyCreds): void {
    saveCachedCreds({
      creds,
      signerAddress: this.wallet.address,
      logger: this.logger,
    });
  }

  /**
   * Clear cached credentials
   */
  private clearCache(): void {
    clearCachedCreds(this.logger);
  }

  /**
   * Check if we have valid cached credentials (without re-authenticating)
   */
  hasCachedCredentials(): boolean {
    return this.cachedCreds !== undefined;
  }

  /**
   * Get cached credentials (if available)
   */
  getCachedCredentials(): ApiKeyCreds | undefined {
    return this.cachedCreds;
  }

  /**
   * Force clear cached credentials and re-authenticate
   */
  async reauthenticate(): Promise<SimpleAuthResult> {
    this.cachedCreds = undefined;
    this.clearCache();
    return this.authenticate();
  }
}

/**
 * Create SimpleAuth from environment variables
 */
export function createSimpleAuthFromEnv(logger?: Logger): SimpleAuth {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("PRIVATE_KEY environment variable is required");
  }

  return new SimpleAuth({ privateKey, logger });
}

/**
 * Quick authentication check - returns true if auth succeeds
 */
export async function quickAuthCheck(logger?: Logger): Promise<boolean> {
  try {
    const auth = createSimpleAuthFromEnv(logger);
    const result = await auth.authenticate();
    return result.success;
  } catch {
    return false;
  }
}
