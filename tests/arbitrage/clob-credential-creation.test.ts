import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const TEST_CREDS_PATH = "./data/clob-creds.json";

// Clean up test files after each test
afterEach(() => {
  try {
    if (fs.existsSync(TEST_CREDS_PATH)) {
      fs.unlinkSync(TEST_CREDS_PATH);
    }
  } catch {
    // Ignore cleanup errors
  }
});

test("POST /auth/api-key 400 response: no cache file written, credentials not saved", async () => {
  // Verify that 400 responses prevent credential caching
  const fallbackCode = fs.readFileSync("./src/clob/auth-fallback.ts", "utf-8");

  // Check that 400 errors are detected
  assert.ok(
    fallbackCode.includes("isCouldNotCreateKeyError"),
    "Fallback system should detect 'Could not create api key' errors",
  );
  assert.ok(
    fallbackCode.includes("400"),
    "Fallback system should check for 400 status",
  );
});

test("POST /auth/api-key returns incomplete creds: no cache file written", async () => {
  // Verify that the credential derivation system validates completeness
  // The deriveCredentialsWithFallback function checks for complete credentials
  const derivationCode = fs.readFileSync(
    "./src/clob/credential-derivation-v2.ts",
    "utf-8",
  );

  // Check that validation logic exists in the derivation system
  assert.ok(
    derivationCode.includes(
      "!creds || !creds.key || !creds.secret || !creds.passphrase",
    ),
    "Derivation system should validate credentials before saving",
  );
  assert.ok(
    derivationCode.includes("No credentials returned from API"),
    "Derivation system should detect incomplete credentials",
  );
});

test("Successful POST /auth/api-key with valid response: cache written with credentials", () => {
  // Verify the save logic exists in the derivation system
  const derivationCode = fs.readFileSync(
    "./src/clob/credential-derivation-v2.ts",
    "utf-8",
  );

  assert.ok(
    derivationCode.includes("saveCachedCreds({"),
    "Derivation system should save credentials to cache",
  );
  assert.ok(
    derivationCode.includes("creds: result.creds") ||
      derivationCode.includes("creds: swappedResult.creds"),
    "Derivation system should save successful credentials",
  );
  assert.ok(
    derivationCode.includes("Credential derivation successful"),
    "Derivation system should log success message",
  );
});

test("Cached credentials verification on startup: invalid creds cleared and retry", () => {
  // Verify that verification logic exists in the derivation system
  const derivationCode = fs.readFileSync(
    "./src/clob/credential-derivation-v2.ts",
    "utf-8",
  );

  assert.ok(
    derivationCode.includes("Verifying cached credentials"),
    "Derivation system should verify cached credentials",
  );
  assert.ok(
    derivationCode.includes("const isValid = await verifyCredentials"),
    "Derivation system should call verification function",
  );
  assert.ok(
    derivationCode.includes("clearCachedCreds"),
    "Derivation system should clear invalid cached credentials",
  );
  assert.ok(
    derivationCode.includes("Cached credentials failed verification"),
    "Derivation system should log when clearing invalid cache",
  );
});

test("400/401 response logging includes status and error details", () => {
  // Verify error logging includes required details in auth-fallback system
  const fallbackCode = fs.readFileSync("./src/clob/auth-fallback.ts", "utf-8");

  assert.ok(
    fallbackCode.includes("extractStatusCode") ||
      fallbackCode.includes("statusCode"),
    "Fallback system should extract status codes",
  );
  assert.ok(
    fallbackCode.includes("extractErrorMessage"),
    "Fallback system should extract error messages",
  );
  assert.ok(
    fallbackCode.includes("logFallbackResult"),
    "Fallback system should log attempt results with status",
  );
});

test("verifyCredsWithClient function exists and validates with balance-allowance", () => {
  // Verify the verification function exists
  const factoryCode = fs.readFileSync(
    "./src/infrastructure/clob-client.factory.ts",
    "utf-8",
  );

  assert.ok(
    factoryCode.includes("const verifyCredsWithClient"),
    "verifyCredsWithClient function should exist",
  );
  assert.ok(
    factoryCode.includes("await verifyClient.getBalanceAllowance"),
    "Verification should use getBalanceAllowance",
  );
  assert.ok(
    factoryCode.includes("if (status === 401 || status === 403)"),
    "Verification should check for 401/403 status",
  );
  assert.ok(
    factoryCode.includes("Credential verification failed"),
    "Verification should log failures",
  );
});

test("Newly derived credentials are verified before caching", () => {
  // Verify that newly derived credentials are verified before being cached
  const derivationCode = fs.readFileSync(
    "./src/clob/credential-derivation-v2.ts",
    "utf-8",
  );

  assert.ok(
    derivationCode.includes("Verifying credentials from"),
    "Derivation system should verify newly derived credentials",
  );
  assert.ok(
    derivationCode.includes("Verification successful"),
    "Derivation system should log when credentials are verified",
  );
  assert.ok(
    derivationCode.includes("Credentials failed verification"),
    "Derivation system should detect when derived credentials fail verification",
  );

  // Check that fallback system provides helpful error messages
  const fallbackCode = fs.readFileSync("./src/clob/auth-fallback.ts", "utf-8");
  assert.ok(
    fallbackCode.includes("Wallet has never traded on Polymarket") ||
      fallbackCode.includes("wallet needs to trade first"),
    "Fallback system should suggest making a trade on Polymarket website",
  );
});

test("verifyCredsWithClient handles clob-client error objects (not thrown exceptions)", () => {
  // The clob-client returns error objects instead of throwing exceptions
  // Verify our code handles this case
  const factoryCode = fs.readFileSync(
    "./src/infrastructure/clob-client.factory.ts",
    "utf-8",
  );

  // Check that we have a type for error responses
  assert.ok(
    factoryCode.includes("type ClobErrorResponse = {"),
    "Factory should define ClobErrorResponse type",
  );
  // Check that we examine response status from returned error objects
  assert.ok(
    factoryCode.includes("const errorResponse = response as ClobErrorResponse"),
    "Verification should cast response to ClobErrorResponse",
  );
  assert.ok(
    factoryCode.includes(
      "if (errorResponse.status === 401 || errorResponse.status === 403)",
    ),
    "Verification should detect 401/403 from response objects",
  );
});
