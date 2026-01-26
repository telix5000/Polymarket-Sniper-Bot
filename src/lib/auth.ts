/**
 * V2 Auth - CLOB client authentication
 *
 * DEFAULTS TO EOA MODE (signatureType=0) - uses wallet address directly.
 * Set POLYMARKET_SIGNATURE_TYPE and POLYMARKET_PROXY_ADDRESS for proxy/Safe mode.
 */

import { JsonRpcProvider, Wallet } from "ethers";
import { ClobClient } from "@polymarket/clob-client";
import { POLYMARKET_API, POLYGON } from "./constants";
import type { Logger } from "./types";

export interface AuthResult {
  success: boolean;
  client?: ClobClient;
  wallet?: Wallet;
  address?: string;
  effectiveAddress?: string;
  error?: string;
}

/**
 * Create authenticated CLOB client
 *
 * Defaults to EOA mode (signatureType=0). The wallet address from PRIVATE_KEY
 * is used directly for trading and balance checks.
 *
 * For proxy/Safe mode, set environment variables:
 *   POLYMARKET_SIGNATURE_TYPE=1 (proxy) or 2 (Safe)
 *   POLYMARKET_PROXY_ADDRESS=0x...
 */
export async function createClobClient(
  privateKey: string,
  rpcUrl: string,
  logger?: Logger,
): Promise<AuthResult> {
  // Private key with 0x prefix should be 66 chars (2 for '0x' + 64 hex chars)
  const PRIVATE_KEY_LENGTH_WITH_PREFIX = 66;

  try {
    // Normalize private key
    const normalizedKey = privateKey?.startsWith("0x")
      ? privateKey
      : `0x${privateKey}`;

    if (!normalizedKey || normalizedKey.length < PRIVATE_KEY_LENGTH_WITH_PREFIX) {
      return { success: false, error: "PRIVATE_KEY is invalid or missing" };
    }
    if (!rpcUrl) {
      return { success: false, error: "RPC_URL is required" };
    }

    const provider = new JsonRpcProvider(rpcUrl);
    const wallet = new Wallet(normalizedKey, provider);
    const address = wallet.address;

    // Read signature type from env - default to 0 (EOA)
    const signatureTypeStr =
      process.env.POLYMARKET_SIGNATURE_TYPE ?? process.env.CLOB_SIGNATURE_TYPE;
    const signatureType = signatureTypeStr ? parseInt(signatureTypeStr, 10) : 0;

    // Read funder/proxy address - only used if signature type > 0
    const funderAddress =
      process.env.POLYMARKET_PROXY_ADDRESS ?? process.env.CLOB_FUNDER_ADDRESS;

    // Effective address for trading/balance checks
    const effectiveAddress =
      signatureType > 0 && funderAddress ? funderAddress : address;

    logger?.info?.(
      `Authenticating wallet ${address.slice(0, 10)}... (signatureType=${signatureType}${signatureType > 0 ? `, funder=${funderAddress?.slice(0, 10)}...` : " EOA mode"})`,
    );

    // Warn if proxy mode without funder
    if (signatureType > 0 && !funderAddress) {
      logger?.warn?.(
        `signatureType=${signatureType} but no POLYMARKET_PROXY_ADDRESS set. Using EOA address.`,
      );
    }

    // Derive credentials first
    const tempClient = new ClobClient(
      POLYMARKET_API.CLOB,
      POLYGON.CHAIN_ID,
      wallet as any,
      undefined, // No creds yet
      signatureType,
      signatureType > 0 ? funderAddress : undefined,
    );

    // Derive API credentials
    const creds = await tempClient.createOrDeriveApiKey();

    if (!creds?.key || !creds?.secret || !creds?.passphrase) {
      return { success: false, error: "Failed to derive API credentials" };
    }

    logger?.info?.(`Credentials obtained: key=...${creds.key.slice(-6)}`);

    // Create client WITH credentials
    const client = new ClobClient(
      POLYMARKET_API.CLOB,
      POLYGON.CHAIN_ID,
      wallet as any,
      creds, // Pass the derived credentials
      signatureType,
      signatureType > 0 ? funderAddress : undefined,
    );

    logger?.info?.("Authentication successful");

    return {
      success: true,
      client,
      wallet,
      address: address.toLowerCase(),
      effectiveAddress: effectiveAddress.toLowerCase(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.error?.(`Auth failed: ${msg}`);
    return { success: false, error: msg };
  }
}

/**
 * Check if live trading is enabled
 */
export function isLiveTradingEnabled(): boolean {
  const flag = process.env.LIVE_TRADING ?? process.env.ARB_LIVE_TRADING ?? "";
  return flag === "I_UNDERSTAND_THE_RISKS";
}
