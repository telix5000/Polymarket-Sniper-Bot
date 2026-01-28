/**
 * Tests to verify the ethers v6 → v5 compatibility shim works correctly
 */
import { test, describe } from "node:test";
import assert from "node:assert";
import { Wallet } from "ethers";
import { applyEthersV6Shim } from "../../../src/lib/ethers-compat";

describe("applyEthersV6Shim", () => {
  test("wallet does not have _signTypedData before shim", () => {
    const testPrivateKey = "0x" + "1".repeat(64);
    const wallet = new Wallet(testPrivateKey);

    // ethers v6 wallet should NOT have _signTypedData by default
    const typedWallet = wallet as Wallet & { _signTypedData?: unknown };
    assert.notStrictEqual(typeof typedWallet._signTypedData, "function");
  });

  test("wallet has _signTypedData after shim", () => {
    const testPrivateKey = "0x" + "1".repeat(64);
    const wallet = new Wallet(testPrivateKey);

    // Apply the shim
    const shimmedWallet = applyEthersV6Shim(wallet);
    const typedWallet = shimmedWallet as Wallet & { _signTypedData?: unknown };

    // After shim, _signTypedData should exist and be a function
    assert.strictEqual(typeof typedWallet._signTypedData, "function");
  });

  test("shim does not modify wallet if _signTypedData already exists", () => {
    const testPrivateKey = "0x" + "1".repeat(64);
    const wallet = new Wallet(testPrivateKey);

    // Manually add a mock _signTypedData
    const customFn = async () => "custom";
    const typedWallet = wallet as Wallet & {
      _signTypedData?: () => Promise<string>;
    };
    typedWallet._signTypedData = customFn;

    // Apply the shim
    const shimmedWallet = applyEthersV6Shim(typedWallet);
    const resultWallet = shimmedWallet as Wallet & {
      _signTypedData?: () => Promise<string>;
    };

    // The custom function should still be there (shim should not overwrite)
    assert.strictEqual(resultWallet._signTypedData, customFn);
  });

  test("shimmed _signTypedData returns same as signTypedData", async () => {
    const testPrivateKey = "0x" + "1".repeat(64);
    const wallet = new Wallet(testPrivateKey);

    // Apply the shim
    const shimmedWallet = applyEthersV6Shim(wallet);
    const typedWallet = shimmedWallet as Wallet & {
      _signTypedData?: typeof wallet.signTypedData;
    };

    // Test data for EIP-712 signing
    const domain = {
      name: "Test",
      version: "1",
      chainId: 1,
    };

    const types = {
      Message: [{ name: "content", type: "string" }],
    };

    const value = {
      content: "Hello World",
    };

    // Both methods should produce the same signature
    const signTypedDataResult = await wallet.signTypedData(
      domain,
      types,
      value,
    );
    const _signTypedDataResult = await typedWallet._signTypedData!(
      domain,
      types,
      value,
    );

    assert.strictEqual(_signTypedDataResult, signTypedDataResult);
  });
});
