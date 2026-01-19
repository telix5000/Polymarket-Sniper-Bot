#!/usr/bin/env ts-node

/**
 * Comprehensive CLOB Authentication Diagnostic Tool
 *
 * This tool produces a SINGLE high-signal Auth Story diagnostic that:
 * - Verifies the correct CLOB endpoint is being used
 * - Checks for URL/environment variable overrides
 * - Tests the complete authentication flow
 * - Generates a structured Auth Story JSON summary
 * - Eliminates log spam with correlation IDs
 * - Never leaks secrets (only suffixes/hashes/lengths)
 *
 * Usage:
 *   ts-node scripts/auth_diagnostic.ts
 *   npm run auth:diag
 *
 * Environment Variables:
 *   PRIVATE_KEY     - Required: Private key for authentication
 *   CLOB_HOST       - Optional: Override CLOB endpoint (default: https://clob.polymarket.com)
 *   LOG_FORMAT      - Optional: "json" or "pretty" (default: "json")
 *   LOG_LEVEL       - Optional: "debug" | "info" | "warn" | "error" (default: "info")
 */

import { ClobClient, Chain, AssetType } from "@polymarket/clob-client";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { SignatureType } from "@polymarket/order-utils";
import { POLYMARKET_API } from "../src/constants/polymarket.constants";
import { getLogger, generateRunId } from "../src/utils/structured-logger";
import {
  initAuthStory,
  createCredentialFingerprint,
} from "../src/clob/auth-story";
import type { AuthAttempt } from "../src/clob/auth-story";
import { asClobSigner } from "../src/utils/clob-signer.util";

/**
 * Normalize private key format (with or without 0x prefix)
 */
function normalizePrivateKey(key: string): string {
  return key.startsWith("0x") ? key : `0x${key}`;
}

/**
 * Configuration check results
 */
interface ConfigCheck {
  expectedClobUrl: string;
  actualClobUrl: string;
  isCorrectUrl: boolean;
  envOverride?: string;
  constantsMatch: boolean;
}

/**
 * HTTP request details (sanitized)
 */
interface HttpRequestDetails {
  method: string;
  url: string;
  fullUrl: string;
  signedPath: string;
  hasQueryParams: boolean;
  headerNames: string[];
  timestamp: number;
}

/**
 * HTTP response details (sanitized)
 */
interface HttpResponseDetails {
  status: number;
  statusText: string;
  errorMessage?: string;
  errorType?: string;
  success: boolean;
}

/**
 * Credential derivation result
 */
interface DerivationResult {
  success: boolean;
  method: "createOrDeriveApiKey" | "deriveApiKey" | "createApiKey";
  error?: string;
  statusCode?: number;
  creds?: ApiKeyCreds;
}

/**
 * Complete diagnostic result
 */
interface DiagnosticResult {
  runId: string;
  timestamp: string;
  config: ConfigCheck;
  derivation: DerivationResult;
  request?: HttpRequestDetails;
  response?: HttpResponseDetails;
  rootCauseHypothesis: string[];
  recommendedFix?: string;
  authStoryJson?: any;
}

/**
 * Check CLOB endpoint configuration
 */
function checkClobEndpoint(): ConfigCheck {
  const logger = getLogger();
  const expectedUrl = "https://clob.polymarket.com";
  const actualUrl = POLYMARKET_API.BASE_URL;
  const envOverride = process.env.CLOB_HOST;

  const isCorrectUrl =
    actualUrl === expectedUrl && (!envOverride || envOverride === expectedUrl);
  const constantsMatch = actualUrl === expectedUrl;

  logger.info("Checking CLOB endpoint configuration", {
    category: "STARTUP",
    expectedUrl,
    actualUrl,
    envOverride: envOverride || "none",
    isCorrectUrl,
  });

  return {
    expectedClobUrl: expectedUrl,
    actualClobUrl: envOverride || actualUrl,
    isCorrectUrl,
    envOverride,
    constantsMatch,
  };
}

/**
 * Derive credentials using createOrDeriveApiKey
 */
async function deriveCredentials(
  wallet: Wallet,
  clobHost: string,
): Promise<DerivationResult> {
  const logger = getLogger();

  logger.info("Starting credential derivation", {
    category: "CRED_DERIVE",
    clobHost,
    method: "createOrDeriveApiKey",
  });

  try {
    const client = new ClobClient(
      clobHost,
      Chain.POLYGON,
      asClobSigner(wallet),
      undefined, // No creds yet - will be derived
      SignatureType.EOA, // Use EOA for probe (funder not needed for EOA mode)
      undefined, // No funder parameter for EOA signature type
    );

    const creds = await client.createOrDeriveApiKey();

    if (!creds || !creds.key || !creds.secret || !creds.passphrase) {
      logger.error("Incomplete credentials returned", {
        category: "CRED_DERIVE",
        hasKey: !!creds?.key,
        hasSecret: !!creds?.secret,
        hasPassphrase: !!creds?.passphrase,
      });

      return {
        success: false,
        method: "createOrDeriveApiKey",
        error: "Incomplete credentials returned",
      };
    }

    logger.info("Credentials derived successfully", {
      category: "CRED_DERIVE",
      apiKeySuffix: creds.key.slice(-6),
      secretLen: creds.secret.length,
      passphraseLen: creds.passphrase.length,
    });

    return {
      success: true,
      method: "createOrDeriveApiKey",
      creds,
    };
  } catch (error: any) {
    const status = error?.response?.status;
    const message = error?.message || String(error);

    logger.error("Credential derivation failed", {
      category: "CRED_DERIVE",
      status,
      error: message.slice(0, 200),
    });

    // Detect specific error types
    let errorType: string | undefined;
    if (status === 401 && message.includes("Invalid L1 Request headers")) {
      errorType = "INVALID_L1_HEADERS";
    } else if (
      status === 400 &&
      message.toLowerCase().includes("could not create api key")
    ) {
      errorType = "WALLET_NOT_TRADED";
    }

    return {
      success: false,
      method: "createOrDeriveApiKey",
      error: message.slice(0, 200),
      statusCode: status,
    };
  }
}

/**
 * Verify credentials with /balance-allowance
 */
async function verifyCredentials(
  wallet: Wallet,
  creds: ApiKeyCreds,
  clobHost: string,
): Promise<{ request: HttpRequestDetails; response: HttpResponseDetails }> {
  const logger = getLogger();

  logger.info("Verifying credentials", {
    category: "HTTP",
    endpoint: "/balance-allowance",
  });

  const client = new ClobClient(
    clobHost,
    Chain.POLYGON,
    asClobSigner(wallet),
    creds,
    SignatureType.EOA,
    undefined,
  );

  // Build request details for diagnostics
  const signedPath = `/balance-allowance?asset_type=${AssetType.COLLATERAL}&signature_type=${SignatureType.EOA}`;
  const fullUrl = `${clobHost}${signedPath}`;

  const request: HttpRequestDetails = {
    method: "GET",
    url: "/balance-allowance",
    fullUrl,
    signedPath,
    hasQueryParams: true,
    headerNames: [
      "POLY_ADDRESS",
      "POLY_SIGNATURE",
      "POLY_TIMESTAMP",
      "POLY_API_KEY",
      "POLY_PASSPHRASE",
    ],
    timestamp: Math.floor(Date.now() / 1000),
  };

  try {
    const result = await client.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });

    // Type guard: Check if result is an error response
    // ClobClient may return error objects instead of throwing
    type ErrorResponse = { status?: number; error?: string };
    const isErrorResponse = (obj: any): obj is ErrorResponse => {
      return (
        typeof obj === "object" &&
        obj !== null &&
        ("status" in obj || "error" in obj)
      );
    };

    if (
      isErrorResponse(result) &&
      (result.status === 401 || result.status === 403)
    ) {
      logger.error("Verification failed", {
        category: "HTTP",
        status: result.status,
        error: result.error || "Unauthorized",
      });

      return {
        request,
        response: {
          status: result.status,
          statusText: result.status === 401 ? "Unauthorized" : "Forbidden",
          errorMessage: result.error || "Unauthorized/Invalid api key",
          errorType: result.status === 401 ? "AUTH_FAILED" : "FORBIDDEN",
          success: false,
        },
      };
    }

    if (isErrorResponse(result) && result.error) {
      logger.error("Verification returned error", {
        category: "HTTP",
        error: result.error,
      });

      return {
        request,
        response: {
          status: 400,
          statusText: "Bad Request",
          errorMessage: result.error,
          success: false,
        },
      };
    }

    logger.info("Verification successful", {
      category: "HTTP",
      status: 200,
    });

    return {
      request,
      response: {
        status: 200,
        statusText: "OK",
        success: true,
      },
    };
  } catch (error: any) {
    const status = error?.response?.status || 0;
    const message = error?.message || String(error);

    logger.error("Verification exception", {
      category: "HTTP",
      status,
      error: message.slice(0, 200),
    });

    return {
      request,
      response: {
        status: status || 500,
        statusText: error?.response?.statusText || "Error",
        errorMessage: message.slice(0, 200),
        errorType:
          status === 401
            ? "AUTH_FAILED"
            : status === 403
              ? "FORBIDDEN"
              : "NETWORK_ERROR",
        success: false,
      },
    };
  }
}

/**
 * Generate root cause hypotheses based on the diagnostic results
 */
function generateRootCauseHypotheses(result: DiagnosticResult): string[] {
  const hypotheses: string[] = [];

  // Check 1: Incorrect CLOB endpoint
  if (!result.config.isCorrectUrl) {
    hypotheses.push(
      `CLOB endpoint mismatch: Using '${result.config.actualClobUrl}' instead of '${result.config.expectedClobUrl}'`,
    );
  }

  // Check 2: Derivation failure
  if (!result.derivation.success) {
    if (result.derivation.statusCode === 401) {
      hypotheses.push(
        "401 during credential derivation: Invalid L1 auth headers or signature mismatch",
      );
    } else if (result.derivation.statusCode === 400) {
      hypotheses.push(
        "400 during credential derivation: Wallet has never traded on Polymarket (must make at least 1 trade at https://polymarket.com)",
      );
    } else {
      hypotheses.push(
        `Credential derivation failed: ${result.derivation.error || "Unknown error"}`,
      );
    }
  }

  // Check 3: Verification failure
  if (result.response && !result.response.success) {
    if (result.response.status === 401) {
      hypotheses.push(
        "401 during verification: HMAC signature mismatch, invalid credentials, or wallet address mismatch",
      );
      hypotheses.push(
        "Possible causes: Secret encoding wrong, message format incorrect, or credentials expired",
      );
    } else if (result.response.status === 403) {
      hypotheses.push(
        "403 Forbidden: Account may be restricted, banned, or geoblocked",
      );
    }
  }

  // Check 4: Query parameter issues
  if (
    result.request &&
    result.request.hasQueryParams &&
    result.response?.status === 401
  ) {
    hypotheses.push(
      "Query parameters present in signed path - verify they match exactly in HTTP request",
    );
  }

  // If no specific issues found but still failing
  if (hypotheses.length === 0 && result.response && !result.response.success) {
    hypotheses.push(
      "Authentication failed with no obvious configuration issues - check network connectivity and API status",
    );
  }

  // If everything succeeded
  if (
    result.response?.success &&
    result.derivation.success &&
    result.config.isCorrectUrl
  ) {
    hypotheses.push(
      "✅ All checks passed - authentication is working correctly",
    );
  }

  return hypotheses;
}

/**
 * Generate recommended fix based on root cause
 */
function generateRecommendedFix(hypotheses: string[]): string | undefined {
  // Check if CLOB endpoint is wrong
  if (hypotheses.some((h) => h.includes("endpoint mismatch"))) {
    return "Fix the CLOB endpoint: Ensure CLOB_HOST environment variable is unset or set to 'https://clob.polymarket.com'";
  }

  // Check if wallet hasn't traded
  if (hypotheses.some((h) => h.includes("never traded"))) {
    return "Wallet must trade first: Visit https://polymarket.com, connect your wallet, and make at least one trade";
  }

  // Check if L1 auth headers are invalid
  if (hypotheses.some((h) => h.includes("Invalid L1 auth headers"))) {
    return "L1 authentication issue: Verify private key is correct and wallet address matches. Try clearing credential cache in /data/clob-creds.json";
  }

  // Check if HMAC signature is wrong
  if (hypotheses.some((h) => h.includes("HMAC signature mismatch"))) {
    return "HMAC signature issue: This is likely a bug in request signing. Verify query parameters are included in signed path and not duplicated by axios params";
  }

  // Check if everything passed
  if (hypotheses.some((h) => h.includes("All checks passed"))) {
    return "No action needed - authentication is working";
  }

  return undefined;
}

/**
 * Run complete diagnostic
 *
 * This function performs a comprehensive authentication diagnostic:
 * 1. Checks CLOB endpoint configuration
 * 2. Derives credentials using createOrDeriveApiKey()
 * 3. Verifies credentials with /balance-allowance
 * 4. Analyzes root cause of any failures
 * 5. Provides actionable recommendations
 *
 * Side effects:
 * - Makes HTTP requests to CLOB API
 * - May derive/create new API credentials
 * - Logs diagnostic information
 *
 * @returns Complete diagnostic result with analysis
 */
async function runDiagnostic(): Promise<DiagnosticResult> {
  const logger = getLogger();
  const runId = generateRunId();

  logger.info("Starting CLOB Authentication Diagnostic", {
    category: "STARTUP",
    runId,
  });

  // Step 1: Check configuration
  const config = checkClobEndpoint();

  // Step 2: Load private key
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    logger.error("PRIVATE_KEY environment variable is required", {
      category: "STARTUP",
    });
    throw new Error("PRIVATE_KEY is required");
  }

  const wallet = new Wallet(normalizePrivateKey(privateKey));
  const signerAddress = wallet.address;

  logger.info("Wallet loaded", {
    category: "STARTUP",
    signerAddress,
  });

  // Initialize Auth Story
  const authStory = initAuthStory({
    runId,
    signerAddress,
    clobHost: config.actualClobUrl,
    chainId: 137,
  });

  // Step 3: Derive credentials
  const derivation = await deriveCredentials(wallet, config.actualClobUrl);

  // Partial result if derivation failed
  if (!derivation.success || !derivation.creds) {
    const result: DiagnosticResult = {
      runId,
      timestamp: new Date().toISOString(),
      config,
      derivation,
      rootCauseHypothesis: [],
    };

    result.rootCauseHypothesis = generateRootCauseHypotheses(result);
    result.recommendedFix = generateRecommendedFix(result.rootCauseHypothesis);

    // Update auth story
    authStory.setFinalResult({
      authOk: false,
      readyToTrade: false,
      reason: `Derivation failed: ${derivation.error || "Unknown"}`,
    });
    result.authStoryJson = authStory.getStory();

    return result;
  }

  // Set credential fingerprint in auth story
  const credFingerprint = createCredentialFingerprint(derivation.creds);
  authStory.setCredentialFingerprint(credFingerprint);

  // Step 4: Verify credentials
  const { request, response } = await verifyCredentials(
    wallet,
    derivation.creds,
    config.actualClobUrl,
  );

  // Add attempt to auth story
  const attempt: AuthAttempt = {
    attemptId: "A",
    mode: "EOA",
    sigType: SignatureType.EOA,
    l1Auth: signerAddress,
    maker: signerAddress,
    funder: undefined, // EOA mode doesn't use a separate funder
    verifyEndpoint: "/balance-allowance",
    signedPath: request.signedPath,
    usedAxiosParams: false,
    httpStatus: response.status,
    errorTextShort: response.errorMessage?.slice(0, 100),
    success: response.success,
  };
  authStory.addAttempt(attempt);

  // Step 5: Build final result
  const result: DiagnosticResult = {
    runId,
    timestamp: new Date().toISOString(),
    config,
    derivation,
    request,
    response,
    rootCauseHypothesis: [],
  };

  result.rootCauseHypothesis = generateRootCauseHypotheses(result);
  result.recommendedFix = generateRecommendedFix(result.rootCauseHypothesis);

  // Update auth story final result
  authStory.setFinalResult({
    authOk: response.success,
    readyToTrade: response.success,
    reason: response.success
      ? "Authentication successful"
      : `Verification failed: ${response.errorMessage}`,
  });
  result.authStoryJson = authStory.getStory();

  return result;
}

/**
 * Print diagnostic summary
 */
function printDiagnosticSummary(result: DiagnosticResult): void {
  const logger = getLogger();

  logger.info("========================================================", {
    category: "SUMMARY",
    runId: result.runId,
  });
  logger.info("CLOB AUTHENTICATION DIAGNOSTIC SUMMARY", {
    category: "SUMMARY",
    runId: result.runId,
  });
  logger.info("========================================================", {
    category: "SUMMARY",
    runId: result.runId,
  });

  // Configuration
  logger.info("CLOB Endpoint Check:", {
    category: "SUMMARY",
    expected: result.config.expectedClobUrl,
    actual: result.config.actualClobUrl,
    correct: result.config.isCorrectUrl ? "✅" : "❌",
    envOverride: result.config.envOverride || "none",
  });

  // Derivation
  logger.info("Credential Derivation:", {
    category: "SUMMARY",
    method: result.derivation.method,
    success: result.derivation.success ? "✅" : "❌",
    error: result.derivation.error,
    statusCode: result.derivation.statusCode,
  });

  // Request (if available)
  if (result.request) {
    logger.info("HTTP Request:", {
      category: "SUMMARY",
      method: result.request.method,
      fullUrl: result.request.fullUrl,
      signedPath: result.request.signedPath,
      hasQueryParams: result.request.hasQueryParams,
    });
  }

  // Response (if available)
  if (result.response) {
    logger.info("HTTP Response:", {
      category: "SUMMARY",
      status: result.response.status,
      statusText: result.response.statusText,
      success: result.response.success ? "✅" : "❌",
      errorMessage: result.response.errorMessage,
      errorType: result.response.errorType,
    });
  }

  // Root cause hypotheses
  logger.info("Root Cause Analysis:", {
    category: "SUMMARY",
    hypotheses: result.rootCauseHypothesis,
  });

  // Recommended fix
  if (result.recommendedFix) {
    logger.info("Recommended Fix:", {
      category: "SUMMARY",
      fix: result.recommendedFix,
    });
  }

  logger.info("========================================================", {
    category: "SUMMARY",
    runId: result.runId,
  });

  // Print Auth Story JSON for easy parsing
  logger.info("AUTH_STORY_JSON", {
    category: "SUMMARY",
    runId: result.runId,
    authStory: result.authStoryJson,
  });

  // Print diagnostic JSON for easy parsing
  logger.info("DIAGNOSTIC_JSON", {
    category: "SUMMARY",
    runId: result.runId,
    diagnostic: result,
  });
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  try {
    const result = await runDiagnostic();
    printDiagnosticSummary(result);

    // Exit code based on auth success
    const exitCode = result.response?.success ? 0 : 1;
    process.exit(exitCode);
  } catch (error: any) {
    const logger = getLogger();
    logger.error("FATAL ERROR", {
      category: "STARTUP",
      error: error?.message || String(error),
      stack: error?.stack,
    });
    process.exit(1);
  }
}

// Run diagnostic
main();
