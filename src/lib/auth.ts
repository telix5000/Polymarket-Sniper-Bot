/**
 * V2 Auth - CLOB client authentication
 *
 * DEFAULTS TO EOA MODE (signatureType=0) - uses wallet address directly.
 * Set POLYMARKET_SIGNATURE_TYPE and POLYMARKET_PROXY_ADDRESS for proxy/Safe mode.
 */

import { JsonRpcProvider, Wallet } from "ethers";
import { ClobClient } from "@polymarket/clob-client";
import { POLYMARKET_API, POLYGON } from "./constants";
import { applyEthersV6Shim } from "./ethers-compat";
import type { Logger } from "./types";

export interface AuthResult {
  success: boolean;
  client?: ClobClient;
  wallet?: Wallet;
  address?: string;
  effectiveAddress?: string;
  error?: string;
}

// Private key with 0x prefix should be exactly 66 chars (2 for '0x' + 64 hex chars)
const PRIVATE_KEY_LENGTH_WITH_PREFIX = 66;
// Regex to validate hex private key format
const PRIVATE_KEY_HEX_REGEX = /^0x[0-9a-fA-F]{64}$/;

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
  try {
    // Normalize private key
    const normalizedKey = privateKey?.startsWith("0x")
      ? privateKey
      : `0x${privateKey}`;

    // Validate private key format: exactly 66 chars and valid hex
    if (
      !normalizedKey ||
      normalizedKey.length !== PRIVATE_KEY_LENGTH_WITH_PREFIX ||
      !PRIVATE_KEY_HEX_REGEX.test(normalizedKey)
    ) {
      return { success: false, error: "PRIVATE_KEY is invalid or missing" };
    }
    if (!rpcUrl) {
      return { success: false, error: "RPC_URL is required" };
    }

    const provider = new JsonRpcProvider(rpcUrl);
    const rawWallet = new Wallet(normalizedKey, provider);
    // Apply ethers v6 → v5 compatibility shim for @polymarket/clob-client
    const wallet = applyEthersV6Shim(rawWallet);
    const address = wallet.address;

    // Read signature type from env - default to 0 (EOA)
    // Handle NaN by falling back to 0
    const signatureTypeStr =
      process.env.POLYMARKET_SIGNATURE_TYPE ?? process.env.CLOB_SIGNATURE_TYPE;
    const signatureType = signatureTypeStr
      ? parseInt(signatureTypeStr, 10) || 0
      : 0;

    // Read funder/proxy address - normalize to lowercase
    const funderAddressRaw =
      process.env.POLYMARKET_PROXY_ADDRESS ?? process.env.CLOB_FUNDER_ADDRESS;
    const funderAddress = funderAddressRaw?.toLowerCase();

    // Determine effective signature type:
    // If proxy mode requested but no funder address, fall back to EOA mode
    const effectiveSignatureType =
      signatureType > 0 && funderAddress ? signatureType : 0;

    // Effective address for trading/balance checks
    const effectiveAddress =
      effectiveSignatureType > 0 && funderAddress ? funderAddress : address;

    logger?.info?.(
      `Authenticating wallet ${address.slice(0, 10)}... (signatureType=${effectiveSignatureType}${effectiveSignatureType > 0 ? `, funder=${funderAddress?.slice(0, 10)}...` : " EOA mode"})`,
    );

    // Warn if proxy mode was requested but no funder - falling back to EOA
    if (signatureType > 0 && !funderAddress) {
      logger?.warn?.(
        `signatureType=${signatureType} but no POLYMARKET_PROXY_ADDRESS set. Falling back to EOA mode (signatureType=0).`,
      );
    }

    // Derive credentials first
    const tempClient = new ClobClient(
      POLYMARKET_API.CLOB,
      POLYGON.CHAIN_ID,
      wallet as any,
      undefined, // No creds yet
      effectiveSignatureType,
      effectiveSignatureType > 0 ? funderAddress : undefined,
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
      effectiveSignatureType,
      effectiveSignatureType > 0 ? funderAddress : undefined,
    );

    logger?.info?.("Authentication successful");

    // Return effectiveAddress as the primary address for balance/position lookups
    const normalizedEffectiveAddress = effectiveAddress.toLowerCase();

    return {
      success: true,
      client,
      wallet,
      address: normalizedEffectiveAddress,
      effectiveAddress: normalizedEffectiveAddress,
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

/**
 * Get auth diagnostic info for logging
 * Returns info about signature type, proxy address, and mode
 */
export interface AuthDiagnostics {
  signatureType: string;
  signatureTypeLabel: string;
  proxyAddress: string | undefined;
  isProxyMode: boolean;
}

export function getAuthDiagnostics(
  signerAddress: string,
  effectiveAddress: string,
): AuthDiagnostics {
  const signatureType =
    process.env.POLYMARKET_SIGNATURE_TYPE ??
    process.env.CLOB_SIGNATURE_TYPE ??
    "0";
  const proxyAddress =
    process.env.POLYMARKET_PROXY_ADDRESS ?? process.env.CLOB_FUNDER_ADDRESS;
  const isProxyMode =
    signerAddress.toLowerCase() !== effectiveAddress.toLowerCase();

  let signatureTypeLabel: string;
  switch (signatureType) {
    case "0":
      signatureTypeLabel = "EOA";
      break;
    case "1":
      signatureTypeLabel = "Proxy";
      break;
    case "2":
      signatureTypeLabel = "Safe";
      break;
    default:
      signatureTypeLabel = `Unknown(${signatureType})`;
      break;
  }

  return {
    signatureType,
    signatureTypeLabel,
    proxyAddress,
    isProxyMode,
  };
}
