/**
 * V2 VPN - WireGuard and OpenVPN support
 */

import { execSync, spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import type { Logger } from "./types";

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
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.warn?.(`OpenVPN failed: ${msg}`);
    return false;
  }
}

/**
 * Setup RPC bypass for VPN (route RPC traffic outside VPN)
 */
export async function setupRpcBypass(rpcUrl: string, logger?: Logger): Promise<void> {
  if (process.env.VPN_BYPASS_RPC === "false") {
    logger?.info?.("RPC VPN bypass disabled");
    return;
  }

  try {
    const url = new URL(rpcUrl);
    const host = url.hostname;

    // Get host IP
    const ip = execSync(`getent hosts ${host} | awk '{print $1}'`, { encoding: "utf8" }).trim();
    if (!ip) return;

    // Get default gateway
    const gateway = execSync("ip route | grep default | awk '{print $3}'", { encoding: "utf8" }).trim();
    const iface = execSync("ip route | grep default | awk '{print $5}'", { encoding: "utf8" }).trim();

    if (!gateway || !iface) return;

    // Add route
    execSync(`ip route add ${ip}/32 via ${gateway} dev ${iface}`, { stdio: "pipe" });
    logger?.info?.(`RPC bypass: ${host} -> ${ip} via ${gateway}`);
  } catch {
    // Silent fail - not critical
  }
}
