import assert from "node:assert";
import { describe, it, beforeEach, afterEach } from "node:test";
import { getAuthDiagnostics } from "../../../src/lib/auth";

describe("getAuthDiagnostics", () => {
  // Store original env vars
  let originalPolymarketSignatureType: string | undefined;
  let originalClobSignatureType: string | undefined;
  let originalPolymarketProxyAddress: string | undefined;
  let originalClobFunderAddress: string | undefined;

  beforeEach(() => {
    // Store original env vars
    originalPolymarketSignatureType = process.env.POLYMARKET_SIGNATURE_TYPE;
    originalClobSignatureType = process.env.CLOB_SIGNATURE_TYPE;
    originalPolymarketProxyAddress = process.env.POLYMARKET_PROXY_ADDRESS;
    originalClobFunderAddress = process.env.CLOB_FUNDER_ADDRESS;

    // Clean up env vars
    delete process.env.POLYMARKET_SIGNATURE_TYPE;
    delete process.env.CLOB_SIGNATURE_TYPE;
    delete process.env.POLYMARKET_PROXY_ADDRESS;
    delete process.env.CLOB_FUNDER_ADDRESS;
  });

  afterEach(() => {
    // Restore original env vars
    if (originalPolymarketSignatureType !== undefined) {
      process.env.POLYMARKET_SIGNATURE_TYPE = originalPolymarketSignatureType;
    } else {
      delete process.env.POLYMARKET_SIGNATURE_TYPE;
    }
    if (originalClobSignatureType !== undefined) {
      process.env.CLOB_SIGNATURE_TYPE = originalClobSignatureType;
    } else {
      delete process.env.CLOB_SIGNATURE_TYPE;
    }
    if (originalPolymarketProxyAddress !== undefined) {
      process.env.POLYMARKET_PROXY_ADDRESS = originalPolymarketProxyAddress;
    } else {
      delete process.env.POLYMARKET_PROXY_ADDRESS;
    }
    if (originalClobFunderAddress !== undefined) {
      process.env.CLOB_FUNDER_ADDRESS = originalClobFunderAddress;
    } else {
      delete process.env.CLOB_FUNDER_ADDRESS;
    }
  });

  describe("signature type labels", () => {
    it("returns EOA label for signature type 0", () => {
      process.env.POLYMARKET_SIGNATURE_TYPE = "0";
      const diag = getAuthDiagnostics("0xSigner", "0xSigner");
      assert.strictEqual(diag.signatureType, "0");
      assert.strictEqual(diag.signatureTypeLabel, "EOA");
    });

    it("returns Proxy label for signature type 1", () => {
      process.env.POLYMARKET_SIGNATURE_TYPE = "1";
      const diag = getAuthDiagnostics("0xSigner", "0xFunder");
      assert.strictEqual(diag.signatureType, "1");
      assert.strictEqual(diag.signatureTypeLabel, "Proxy");
    });

    it("returns Safe label for signature type 2", () => {
      process.env.POLYMARKET_SIGNATURE_TYPE = "2";
      const diag = getAuthDiagnostics("0xSigner", "0xFunder");
      assert.strictEqual(diag.signatureType, "2");
      assert.strictEqual(diag.signatureTypeLabel, "Safe");
    });

    it("returns Unknown label for invalid signature type", () => {
      process.env.POLYMARKET_SIGNATURE_TYPE = "3";
      const diag = getAuthDiagnostics("0xSigner", "0xFunder");
      assert.strictEqual(diag.signatureType, "3");
      assert.strictEqual(diag.signatureTypeLabel, "Unknown(3)");
    });

    it("returns Unknown label for non-numeric signature type", () => {
      process.env.POLYMARKET_SIGNATURE_TYPE = "abc";
      const diag = getAuthDiagnostics("0xSigner", "0xFunder");
      assert.strictEqual(diag.signatureType, "abc");
      assert.strictEqual(diag.signatureTypeLabel, "Unknown(abc)");
    });
  });

  describe("environment variable fallbacks", () => {
    it("defaults to signature type 0 when not set", () => {
      const diag = getAuthDiagnostics("0xSigner", "0xSigner");
      assert.strictEqual(diag.signatureType, "0");
      assert.strictEqual(diag.signatureTypeLabel, "EOA");
    });

    it("falls back to CLOB_SIGNATURE_TYPE when POLYMARKET_SIGNATURE_TYPE not set", () => {
      process.env.CLOB_SIGNATURE_TYPE = "1";
      const diag = getAuthDiagnostics("0xSigner", "0xFunder");
      assert.strictEqual(diag.signatureType, "1");
      assert.strictEqual(diag.signatureTypeLabel, "Proxy");
    });

    it("prefers POLYMARKET_SIGNATURE_TYPE over CLOB_SIGNATURE_TYPE", () => {
      process.env.POLYMARKET_SIGNATURE_TYPE = "2";
      process.env.CLOB_SIGNATURE_TYPE = "1";
      const diag = getAuthDiagnostics("0xSigner", "0xFunder");
      assert.strictEqual(diag.signatureType, "2");
    });

    it("reads proxy address from POLYMARKET_PROXY_ADDRESS", () => {
      process.env.POLYMARKET_PROXY_ADDRESS = "0xProxyAddress";
      const diag = getAuthDiagnostics("0xSigner", "0xFunder");
      assert.strictEqual(diag.proxyAddress, "0xProxyAddress");
    });

    it("falls back to CLOB_FUNDER_ADDRESS when POLYMARKET_PROXY_ADDRESS not set", () => {
      process.env.CLOB_FUNDER_ADDRESS = "0xFunderAddress";
      const diag = getAuthDiagnostics("0xSigner", "0xFunder");
      assert.strictEqual(diag.proxyAddress, "0xFunderAddress");
    });

    it("returns undefined for proxy address when not set", () => {
      const diag = getAuthDiagnostics("0xSigner", "0xSigner");
      assert.strictEqual(diag.proxyAddress, undefined);
    });
  });

  describe("proxy mode detection", () => {
    it("returns isProxyMode=false when signer equals effective address", () => {
      const diag = getAuthDiagnostics("0xSameAddress", "0xSameAddress");
      assert.strictEqual(diag.isProxyMode, false);
    });

    it("returns isProxyMode=true when signer differs from effective address", () => {
      const diag = getAuthDiagnostics("0xSignerAddress", "0xEffectiveAddress");
      assert.strictEqual(diag.isProxyMode, true);
    });

    it("is case-insensitive for address comparison", () => {
      const diag = getAuthDiagnostics("0xABCDEF", "0xabcdef");
      assert.strictEqual(diag.isProxyMode, false);
    });
  });
});
