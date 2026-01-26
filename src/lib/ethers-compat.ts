/**
 * Ethers v6 → v5 compatibility utilities
 *
 * The @polymarket/clob-client library expects the ethers v5 signer interface,
 * but this project uses ethers v6. This module provides compatibility shims.
 */

import type { Wallet } from "ethers";

/**
 * Apply ethers v6 → v5 compatibility shim.
 *
 * The @polymarket/clob-client library expects the ethers v5 signer interface
 * with `_signTypedData`, but ethers v6 uses `signTypedData` instead.
 * This shim maps the v6 method to the v5 interface.
 */
export function applyEthersV6Shim(wallet: Wallet): Wallet {
  const typedWallet = wallet as Wallet & {
    _signTypedData?: typeof wallet.signTypedData;
  };

  if (
    typeof typedWallet._signTypedData !== "function" &&
    typeof typedWallet.signTypedData === "function"
  ) {
    const signTypedDataFn = typedWallet.signTypedData.bind(typedWallet);
    typedWallet._signTypedData = signTypedDataFn;
  }

  return wallet;
}
