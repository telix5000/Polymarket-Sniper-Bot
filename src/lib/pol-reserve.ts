/**
 * V2 POL Reserve - Automatic USDC → POL rebalancing
 *
 * Maintains a minimum POL balance for gas fees by swapping USDC via QuickSwap.
 */

import { Contract, type Wallet, parseUnits, formatUnits } from "ethers";
import { POLYGON } from "./constants";
import type { Logger } from "./types";
import type { PresetConfig } from "./presets";

// QuickSwap V3 Router on Polygon
const QUICKSWAP_ROUTER = "0xf5b509bB0909a69B1c207E495f687a596C168E12";

// Wrapped POL (WPOL) address on Polygon
const WPOL_ADDRESS = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";

// QuickSwap Router ABI (minimal for exactInputSingle)
const QUICKSWAP_ROUTER_ABI = [
  "function exactInputSingle(tuple(address tokenIn, address tokenOut, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 limitSqrtPrice) params) external payable returns (uint256 amountOut)",
  "function unwrapWNativeToken(uint256 amountMinimum, address recipient) external payable",
];

// ERC20 ABI for approvals
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

// WPOL ABI for balance check
const WPOL_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function withdraw(uint256 amount) external",
];

// Constants for swap calculations
const POL_PRICE_ESTIMATE_USD = 0.4; // Conservative estimate for POL price
const MIN_SWAP_USD = 5; // Minimum swap amount in USDC
const AVAILABLE_USDC_BUFFER = 0.9; // Use only 90% of available USDC

export interface PolReserveConfig {
  enabled: boolean;
  targetPol: number;
  minPol: number;
  maxSwapUsd: number;
  checkIntervalMin: number;
  slippagePct: number;
}

export interface SwapResult {
  success: boolean;
  usdcSwapped?: number;
  polReceived?: number;
  txHash?: string;
  error?: string;
}

/**
 * Load POL reserve config from environment or preset
 */
export function loadPolReserveConfig(preset: PresetConfig): PolReserveConfig {
  const envEnabled = process.env.POL_RESERVE_ENABLED;
  // NOTE: POL_RESERVE_TARGET is the preferred variable name.
  // MIN_POL_RESERVE is a legacy alias kept for backward compatibility.
  const envTarget =
    process.env.POL_RESERVE_TARGET ?? process.env.MIN_POL_RESERVE;
  const envMin = process.env.POL_RESERVE_MIN;
  const envMaxSwap = process.env.POL_RESERVE_MAX_SWAP_USD;
  const envInterval = process.env.POL_RESERVE_CHECK_INTERVAL_MIN;
  const envSlippage = process.env.POL_RESERVE_SLIPPAGE_PCT;

  return {
    enabled:
      envEnabled !== undefined
        ? envEnabled === "true"
        : preset.polReserve.enabled,
    targetPol: envTarget ? parseFloat(envTarget) : preset.polReserve.targetPol,
    minPol: envMin ? parseFloat(envMin) : preset.polReserve.minPol,
    maxSwapUsd: envMaxSwap
      ? parseFloat(envMaxSwap)
      : preset.polReserve.maxSwapUsd,
    checkIntervalMin: envInterval
      ? parseFloat(envInterval)
      : preset.polReserve.checkIntervalMin,
    slippagePct: envSlippage
      ? parseFloat(envSlippage)
      : preset.polReserve.slippagePct,
  };
}

/**
 * Check if POL rebalance is needed
 */
export function shouldRebalance(
  currentPol: number,
  minPol: number,
  enabled: boolean,
): boolean {
  if (!enabled) return false;
  return currentPol < minPol;
}

/**
 * Calculate how much USDC to swap for POL
 */
export function calculateSwapAmount(
  currentPol: number,
  targetPol: number,
  maxSwapUsd: number,
  availableUsdc: number,
  estimatedPolPrice: number = POL_PRICE_ESTIMATE_USD,
): { usdcToSwap: number; reason: string } {
  const polNeeded = targetPol - currentPol;
  if (polNeeded <= 0) {
    return { usdcToSwap: 0, reason: "NO_SWAP_NEEDED" };
  }

  // Estimate USDC needed (POL needed * price per POL)
  let usdcToSwap = Math.min(polNeeded * estimatedPolPrice, maxSwapUsd);

  // Ensure we have enough USDC (use only 90% of available)
  const maxAvailableUsdc = availableUsdc * AVAILABLE_USDC_BUFFER;
  if (usdcToSwap > maxAvailableUsdc) {
    usdcToSwap = maxAvailableUsdc;
  }

  if (usdcToSwap < MIN_SWAP_USD) {
    return { usdcToSwap: 0, reason: "SWAP_TOO_SMALL" };
  }

  return { usdcToSwap, reason: "OK" };
}

/**
 * Calculate minimum output with slippage protection
 */
export function calculateMinOutput(
  expectedOutput: number,
  slippagePct: number,
): number {
  return expectedOutput * (1 - slippagePct / 100);
}

/**
 * Swap USDC to POL via QuickSwap
 */
export async function swapUsdcToPol(
  wallet: Wallet,
  usdcAmount: number,
  slippagePct: number,
  logger?: Logger,
): Promise<SwapResult> {
  try {
    const address = await wallet.getAddress();

    // Convert USDC amount to wei (6 decimals)
    const amountIn = parseUnits(usdcAmount.toFixed(6), POLYGON.USDC_DECIMALS);

    // Create contract instances
    const usdcContract = new Contract(POLYGON.USDC_ADDRESS, ERC20_ABI, wallet);
    const wpolContract = new Contract(WPOL_ADDRESS, WPOL_ABI, wallet);
    const routerContract = new Contract(
      QUICKSWAP_ROUTER,
      QUICKSWAP_ROUTER_ABI,
      wallet,
    );

    // Check and set allowance if needed - approve max to avoid repeated approval transactions
    const currentAllowance = await usdcContract.allowance(
      address,
      QUICKSWAP_ROUTER,
    );
    if (currentAllowance < amountIn) {
      logger?.info?.(`Approving USDC for QuickSwap...`);
      const maxUint256 =
        "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
      const approveTx = await usdcContract.approve(
        QUICKSWAP_ROUTER,
        maxUint256,
      );
      await approveTx.wait();
      logger?.info?.(`USDC approved`);
    }

    // Get WPOL balance before swap to calculate actual received
    const wpolBalanceBefore = await wpolContract.balanceOf(address);

    // Estimate expected POL output (rough estimate for slippage calc)
    const estimatedPolOut = usdcAmount / POL_PRICE_ESTIMATE_USD;
    const minAmountOut = parseUnits(
      calculateMinOutput(estimatedPolOut, slippagePct).toFixed(18),
      18,
    );

    // Set deadline to 10 minutes from now
    const deadline = Math.floor(Date.now() / 1000) + 600;

    logger?.info?.(`Swapping $${usdcAmount.toFixed(2)} USDC → POL...`);

    // Execute swap: USDC → WPOL
    const swapParams = {
      tokenIn: POLYGON.USDC_ADDRESS,
      tokenOut: WPOL_ADDRESS,
      recipient: address,
      deadline,
      amountIn,
      amountOutMinimum: minAmountOut,
      limitSqrtPrice: 0, // No price limit
    };

    const swapTx = await routerContract.exactInputSingle(swapParams);
    const receipt = await swapTx.wait();

    // Get actual WPOL received by comparing balances
    const wpolBalanceAfter = await wpolContract.balanceOf(address);
    const wpolReceived = wpolBalanceAfter - wpolBalanceBefore;
    const polReceived = Number(formatUnits(wpolReceived, 18));

    // Unwrap WPOL to native POL using the actual received amount
    // WPOL.withdraw() burns WPOL from caller's balance and sends native POL
    logger?.info?.(`Unwrapping WPOL to native POL...`);
    const unwrapTx = await wpolContract.withdraw(wpolReceived);
    await unwrapTx.wait();

    logger?.info?.(
      `✅ POL Swap complete | ${usdcAmount.toFixed(2)} USDC → ${polReceived.toFixed(2)} POL`,
    );

    return {
      success: true,
      usdcSwapped: usdcAmount,
      polReceived,
      txHash: receipt.hash,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger?.error?.(`POL swap failed: ${errorMsg}`);
    return {
      success: false,
      error: errorMsg,
    };
  }
}

/**
 * Run POL reserve check and rebalance if needed
 */
export async function runPolReserve(
  wallet: Wallet,
  address: string,
  currentPol: number,
  availableUsdc: number,
  config: PolReserveConfig,
  logger?: Logger,
): Promise<SwapResult | null> {
  if (!shouldRebalance(currentPol, config.minPol, config.enabled)) {
    return null;
  }

  logger?.warn?.(
    `⚠️ POL Low | Current: ${currentPol.toFixed(2)} POL | Target: ${config.targetPol} POL`,
  );

  const { usdcToSwap, reason } = calculateSwapAmount(
    currentPol,
    config.targetPol,
    config.maxSwapUsd,
    availableUsdc,
  );

  if (usdcToSwap === 0) {
    logger?.info?.(`POL rebalance skipped: ${reason}`);
    return null;
  }

  logger?.info?.(
    `💱 POL Rebalance | Swapping $${usdcToSwap.toFixed(2)} USDC → ~${(usdcToSwap / POL_PRICE_ESTIMATE_USD).toFixed(0)} POL`,
  );

  return swapUsdcToPol(wallet, usdcToSwap, config.slippagePct, logger);
}
