/**
 * V2 VPN - WireGuard and OpenVPN support
 *
 * VPN Routing Strategy (enabled by default):
 * - RPC traffic (blockchain reads): Bypasses VPN for speed
 * - Polymarket API reads (orderbooks, markets): Bypasses VPN for speed
 * - Polymarket API writes (auth, orders): Routes through VPN for geo-blocking
 *
 * The bypass works by:
 * 1. Capturing the default gateway BEFORE VPN starts
 * 2. Starting VPN (which changes the default route)
 * 3. Adding explicit routes for bypass hosts via the pre-VPN gateway
 *
 * Environment Variables:
 * - VPN_BYPASS_RPC: Set to "false" to route RPC through VPN (default: true)
 * - VPN_BYPASS_POLYMARKET_READS: Set to "false" to route reads through VPN (default: true)
 */

import { execSync, spawn } from "child_process";
import { existsSync } from "fs";
import type { Logger } from "./types";

// Track VPN status globally
let vpnActive = false;
let vpnType: "wireguard" | "openvpn" | "none" = "none";

// Pre-VPN routing info (captured before VPN starts)
interface PreVpnRouting {
  gateway: string;
  iface: string;
}

let preVpnRouting: PreVpnRouting | null = null;

/**
 * Check if VPN is currently active
 */
export function isVpnActive(): boolean {
  return vpnActive;
}

/**
 * Get the type of VPN that's active
 */
export function getVpnType(): "wireguard" | "openvpn" | "none" {
  return vpnType;
}

/**
 * Capture pre-VPN routing info (gateway and interface)
 * MUST be called BEFORE starting VPN
 */
export async function capturePreVpnRouting(
  logger?: Logger,
): Promise<PreVpnRouting> {
  try {
    const gateway = execSync("ip route | grep default | awk '{print $3}'", {
      encoding: "utf8",
    }).trim();
    const iface = execSync("ip route | grep default | awk '{print $5}'", {
      encoding: "utf8",
    }).trim();

    if (gateway && iface) {
      preVpnRouting = { gateway, iface };
      logger?.info?.(`Pre-VPN routing: gateway=${gateway} iface=${iface}`);
      return preVpnRouting;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.warn?.(`Failed to capture pre-VPN routing: ${msg}`);
  }

  return { gateway: "", iface: "" };
}

/**
 * Start WireGuard if config exists
 */
export async function startWireguard(logger?: Logger): Promise<boolean> {
  const configPath = process.env.WG_CONFIG ?? "/etc/wireguard/wg0.conf";

  if (!existsSync(configPath)) {
    return false;
  }

  try {
    logger?.info?.("Starting WireGuard...");
    execSync(`wg-quick up ${configPath}`, { stdio: "pipe" });
    logger?.info?.("WireGuard connected");
    vpnActive = true;
    vpnType = "wireguard";
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.warn?.(`WireGuard failed: ${msg}`);
    return false;
  }
}

/**
 * Start OpenVPN if config exists
 */
export async function startOpenvpn(logger?: Logger): Promise<boolean> {
  const configPath = process.env.OVPN_CONFIG ?? "/etc/openvpn/client.ovpn";

  if (!existsSync(configPath)) {
    return false;
  }

  try {
    logger?.info?.("Starting OpenVPN...");

    const proc = spawn("openvpn", ["--config", configPath, "--daemon"], {
      stdio: "pipe",
      detached: true,
    });

    proc.unref();

    // Wait for connection
    await new Promise((r) => setTimeout(r, 5000));
    logger?.info?.("OpenVPN started");
    vpnActive = true;
    vpnType = "openvpn";
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.warn?.(`OpenVPN failed: ${msg}`);
    return false;
  }
}

/**
 * Add a bypass route for a hostname (routes traffic outside VPN)
 * Uses the pre-VPN gateway captured before VPN started
 */
function addBypassRoute(
  hostname: string,
  logger?: Logger,
): { ip: string; gateway: string } | null {
  // Use captured pre-VPN routing
  const effectiveGateway = preVpnRouting?.gateway;
  const effectiveIface = preVpnRouting?.iface;

  if (!effectiveGateway || !effectiveIface) {
    logger?.warn?.(
      `Cannot add bypass for ${hostname}: no pre-VPN routing info available`,
    );
    return null;
  }

  try {
    // Get host IP
    const ip = execSync(`getent hosts ${hostname} | awk '{print $1}'`, {
      encoding: "utf8",
    }).trim();
    if (!ip) {
      logger?.warn?.(`Cannot resolve IP for ${hostname}`);
      return null;
    }

    // Add route to bypass VPN (use pre-VPN gateway)
    execSync(
      `ip route add ${ip}/32 via ${effectiveGateway} dev ${effectiveIface}`,
      {
        stdio: "pipe",
      },
    );

    return { ip, gateway: effectiveGateway };
  } catch {
    // Route may already exist or command failed - not critical
    return null;
  }
}

/**
 * Setup RPC bypass for VPN (route RPC traffic outside VPN for speed)
 * Enabled by default. Set VPN_BYPASS_RPC=false to route RPC through VPN.
 */
export async function setupRpcBypass(
  rpcUrl: string,
  logger?: Logger,
): Promise<void> {
  if (process.env.VPN_BYPASS_RPC === "false") {
    logger?.info?.("RPC VPN bypass disabled - RPC routes through VPN");
    return;
  }

  if (!vpnActive) {
    // No VPN active, no need for bypass
    return;
  }

  if (!preVpnRouting?.gateway) {
    logger?.warn?.("Cannot setup RPC bypass: pre-VPN routing not captured");
    return;
  }

  try {
    const url = new URL(rpcUrl);
    const result = addBypassRoute(url.hostname, logger);
    if (result) {
      logger?.info?.(
        `RPC bypass: ${url.hostname} -> ${result.ip} via ${result.gateway}`,
      );
    }
  } catch {
    // Silent fail - not critical
  }
}

/**
 * Setup Polymarket API bypass for reads (orderbooks, markets, balances)
 * Routes read traffic outside VPN for speed while auth/orders go through VPN.
 *
 * Enabled by default. Set VPN_BYPASS_POLYMARKET_READS=false to route all
 * Polymarket traffic through VPN.
 *
 * Note: This only affects read endpoints. Auth and order endpoints still
 * route through VPN for geo-blocking avoidance.
 */
export async function setupPolymarketReadBypass(
  logger?: Logger,
): Promise<void> {
  // Check if bypass is disabled
  if (process.env.VPN_BYPASS_POLYMARKET_READS === "false") {
    logger?.info?.(
      "Polymarket read bypass disabled - all traffic through VPN",
    );
    return;
  }

  if (!vpnActive) {
    // No VPN active, no need for bypass
    return;
  }

  if (!preVpnRouting?.gateway) {
    logger?.warn?.(
      "Cannot setup Polymarket bypass: pre-VPN routing not captured",
    );
    return;
  }

  // Polymarket API hosts for reads
  const hosts = [
    "clob.polymarket.com", // CLOB API (orderbooks, markets)
    "gamma-api.polymarket.com", // Gamma API
    "strapi-matic.poly.market", // Strapi API
  ];

  for (const host of hosts) {
    const result = addBypassRoute(host, logger);
    if (result) {
      logger?.info?.(
        `Polymarket read bypass: ${host} -> ${result.ip} via ${result.gateway}`,
      );
    }
  }
}

/**
 * Check VPN requirements for live trading
 * Returns warnings if VPN is not properly configured
 */
export function checkVpnForTrading(logger?: Logger): string[] {
  const warnings: string[] = [];

  if (!vpnActive) {
    warnings.push(
      "⚠️  No VPN active - Polymarket API requests may be geo-blocked",
    );
    warnings.push(
      "   Configure WireGuard (WG_CONFIG) or OpenVPN (OVPN_CONFIG) for reliable trading",
    );
  }

  if (warnings.length > 0 && logger) {
    warnings.forEach((w) => logger.warn?.(w));
  }

  return warnings;
}
