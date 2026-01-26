/**
 * Polymarket Authentication
 *
 * DEFAULTS TO EOA MODE (signatureType=0) - uses wallet address directly.
 *
 * To use proxy/Safe mode, explicitly set:
 *   POLYMARKET_SIGNATURE_TYPE=1 (proxy) or 2 (Safe)
 *   POLYMARKET_PROXY_ADDRESS=0x...
 *
 * Environment Variables:
 *   PRIVATE_KEY                  - Required: Wallet private key
 *   POLYMARKET_SIGNATURE_TYPE    - Optional: 0=EOA (default), 1=Proxy, 2=Safe
 *   POLYMARKET_PROXY_ADDRESS     - Optional: Proxy/funder address (required for type 1 or 2)
 *   POLYMARKET_API_KEY           - Optional: Pre-existing API key
 *   POLYMARKET_API_SECRET        - Optional: Pre-existing API secret
 *   POLYMARKET_API_PASSPHRASE    - Optional: Pre-existing API passphrase
 *   RPC_URL                      - Optional: Polygon RPC URL
 */

import { JsonRpcProvider, Wallet } from "ethers";
import { ClobClient } from "@polymarket/clob-client";
import type { Logger } from "../lib/types";

const CLOB_HOST = "https://clob.polymarket.com";
const POLYGON_CHAIN_ID = 137;
const DEFAULT_RPC_URL = "https://polygon-rpc.com";

export interface ApiKeyCreds {
  key: string;
  secret: string;
  passphrase: string;
}

export interface AuthResult {
  success: boolean;
  derived: boolean;
  creds?: ApiKeyCreds;
  signatureType: number;
  error?: string;
}

export interface PolymarketAuthOptions {
  privateKey: string;
  signatureType?: number;
  funderAddress?: string;
  apiKey?: string;
  apiSecret?: string;
  passphrase?: string;
  rpcUrl?: string;
  logger?: Logger;
}

/**
 * Polymarket Authentication Handler
 *
 * Defaults to EOA mode (signatureType=0). Only uses proxy/funder if explicitly configured.
 */
export class PolymarketAuth {
  private readonly wallet: Wallet;
  private readonly signatureType: number;
  private readonly funderAddress?: string;
  private readonly providedCreds?: ApiKeyCreds;
  private readonly rpcUrl: string;
  private readonly logger?: Logger;

  private cachedCreds?: ApiKeyCreds;
  private cachedClient?: ClobClient;

  constructor(options: PolymarketAuthOptions) {
    if (!options.privateKey) {
      throw new Error("PolymarketAuth requires a privateKey");
    }

    // Normalize private key
    const privateKey = options.privateKey.startsWith("0x")
      ? options.privateKey
      : `0x${options.privateKey}`;

    this.rpcUrl = options.rpcUrl || DEFAULT_RPC_URL;
    const provider = new JsonRpcProvider(this.rpcUrl);
    this.wallet = new Wallet(privateKey, provider);

    // Default to EOA mode (0) - user must explicitly set for proxy/Safe
    this.signatureType = options.signatureType ?? 0;
    this.funderAddress = options.funderAddress;
    this.logger = options.logger;

    // Store provided credentials if given
    if (options.apiKey && options.apiSecret && options.passphrase) {
      this.providedCreds = {
        key: options.apiKey,
        secret: options.apiSecret,
        passphrase: options.passphrase,
      };
    }

    this.logger?.info?.(
      `[PolymarketAuth] Initialized: address=${this.wallet.address} signatureType=${this.signatureType}${this.funderAddress ? ` funder=${this.funderAddress}` : " (EOA mode)"}`,
    );
  }

  /**
   * Get the signer wallet address (EOA)
   */
  getAddress(): string {
    return this.wallet.address;
  }

  /**
   * Get the effective trading address
   * - For EOA mode (0): returns signer address
   * - For Proxy/Safe mode (1, 2): returns funder address if set, otherwise signer
   */
  getEffectiveAddress(): string {
    if (this.signatureType > 0 && this.funderAddress) {
      return this.funderAddress;
    }
    return this.wallet.address;
  }

  /**
   * Get signature type
   */
  getSignatureType(): number {
    return this.signatureType;
  }

  /**
   * Get the underlying wallet
   */
  getWallet(): Wallet {
    return this.wallet;
  }

  /**
   * Check if credentials are cached
   */
  hasCredentials(): boolean {
    return this.cachedCreds !== undefined;
  }

  /**
   * Get API credentials (from cache, provided, or derive)
   */
  async getApiCredentials(): Promise<ApiKeyCreds> {
    // Return cached
    if (this.cachedCreds) {
      return this.cachedCreds;
    }

    // Use provided credentials
    if (this.providedCreds) {
      this.cachedCreds = this.providedCreds;
      return this.cachedCreds;
    }

    // Derive credentials via CLOB API
    this.logger?.info?.("[PolymarketAuth] Deriving API credentials...");

    const client = new ClobClient(
      CLOB_HOST,
      POLYGON_CHAIN_ID,
      this.wallet as any,
      undefined, // creds - will derive
      this.signatureType,
      this.funderAddress,
    );

    try {
      // Try to derive existing key first, then create if needed
      const creds = await client.createOrDeriveApiKey();

      if (!creds?.key || !creds?.secret || !creds?.passphrase) {
        throw new Error("Failed to derive API credentials - empty response");
      }

      this.cachedCreds = {
        key: creds.key,
        secret: creds.secret,
        passphrase: creds.passphrase,
      };

      this.logger?.info?.(
        `[PolymarketAuth] API credentials obtained: key=...${creds.key.slice(-6)}`,
      );

      return this.cachedCreds;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.error?.(
        `[PolymarketAuth] Failed to derive credentials: ${msg}`,
      );
      throw err;
    }
  }

  /**
   * Authenticate and return result
   */
  async authenticate(): Promise<AuthResult> {
    try {
      const hadCreds = this.providedCreds !== undefined;
      const creds = await this.getApiCredentials();

      return {
        success: true,
        derived: !hadCreds,
        creds,
        signatureType: this.signatureType,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        derived: false,
        signatureType: this.signatureType,
        error: msg,
      };
    }
  }

  /**
   * Get authenticated CLOB client
   */
  async getClobClient(): Promise<ClobClient> {
    if (this.cachedClient) {
      return this.cachedClient;
    }

    const creds = await this.getApiCredentials();

    this.cachedClient = new ClobClient(
      CLOB_HOST,
      POLYGON_CHAIN_ID,
      this.wallet as any,
      creds,
      this.signatureType,
      this.funderAddress,
    );

    return this.cachedClient;
  }

  /**
   * Reset cached credentials and client
   */
  reset(): void {
    this.cachedCreds = undefined;
    this.cachedClient = undefined;
  }
}

/**
 * Create PolymarketAuth from environment variables
 *
 * DEFAULTS TO EOA MODE. Set POLYMARKET_SIGNATURE_TYPE and POLYMARKET_PROXY_ADDRESS
 * to use proxy/Safe mode.
 */
export function createPolymarketAuthFromEnv(logger?: Logger): PolymarketAuth {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("PRIVATE_KEY environment variable is required");
  }

  // Read signature type - default to 0 (EOA)
  // Handle NaN by falling back to 0
  const signatureTypeStr =
    process.env.POLYMARKET_SIGNATURE_TYPE ?? process.env.CLOB_SIGNATURE_TYPE;
  const signatureType = signatureTypeStr
    ? parseInt(signatureTypeStr, 10) || 0
    : 0;

  // Read funder/proxy address - only used if signature type > 0
  const funderAddress =
    process.env.POLYMARKET_PROXY_ADDRESS ?? process.env.CLOB_FUNDER_ADDRESS;

  // Warn if signature type requires funder but none provided
  if (signatureType > 0 && !funderAddress) {
    logger?.warn?.(
      `[PolymarketAuth] signatureType=${signatureType} but no POLYMARKET_PROXY_ADDRESS set. ` +
        `This may cause issues. Set POLYMARKET_PROXY_ADDRESS or use signatureType=0 for EOA mode.`,
    );
  }

  // Read API credentials (optional - will derive if not provided)
  const apiKey =
    process.env.POLYMARKET_API_KEY ??
    process.env.POLY_API_KEY ??
    process.env.CLOB_API_KEY;
  const apiSecret =
    process.env.POLYMARKET_API_SECRET ??
    process.env.POLY_SECRET ??
    process.env.CLOB_API_SECRET;
  const passphrase =
    process.env.POLYMARKET_API_PASSPHRASE ??
    process.env.POLY_PASSPHRASE ??
    process.env.CLOB_API_PASSPHRASE;

  const rpcUrl = process.env.RPC_URL;

  // Only pass funderAddress for non-EOA modes (signatureType > 0)
  // This ensures EOA mode uses the signer address directly
  const effectiveFunderAddress = signatureType > 0 ? funderAddress : undefined;

  return new PolymarketAuth({
    privateKey,
    signatureType,
    funderAddress: effectiveFunderAddress,
    apiKey,
    apiSecret,
    passphrase,
    rpcUrl,
    logger,
  });
}

/**
 * Alias for backwards compatibility with legacy code
 */
export const createPolymarketAuthFromEnvWithAutoDetect =
  createPolymarketAuthFromEnv;
