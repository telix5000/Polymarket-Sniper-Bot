import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "./logger.util";

const execFileAsync = promisify(execFile);

const readEnv = (key: string): string | undefined =>
  process.env[key] ?? process.env[key.toLowerCase()];

const parseBool = (raw: string | undefined, defaultValue: boolean): boolean => {
  if (raw === undefined || raw === "") return defaultValue;
  return raw.toLowerCase() === "true";
};

/**
 * Validates that a string is a valid IPv4 address.
 * Each octet must be 0-255 with no leading zeros.
 */
const isValidIpv4 = (ip: string): boolean => {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    // Must be numeric with no leading zeros (except "0" itself)
    if (!/^\d+$/.test(part)) return false;
    const num = parseInt(part, 10);
    if (num < 0 || num > 255) return false;
    // Check for leading zeros (e.g., "01" or "001")
    if (part.length > 1 && part.startsWith("0")) return false;
    return true;
  });
};

/**
 * Result of capturing pre-VPN routing information.
 */
export interface PreVpnRouting {
  gateway: string | undefined;
  iface: string | undefined;
}

/**
 * Extracts the hostname from an RPC URL.
 * Handles http://, https://, and URLs with ports and paths.
 */
const extractHost = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return undefined;
  }
};

/**
 * Resolves a hostname to its IP address using system DNS.
 * Returns undefined if resolution fails.
 */
const resolveHost = async (hostname: string): Promise<string | undefined> => {
  try {
    // Use getent which is available on most Linux systems
    const { stdout } = await execFileAsync("getent", ["ahosts", hostname]);
    // getent ahosts returns lines like "1.2.3.4 STREAM hostname"
    // We want the first valid IPv4 address
    const lines = stdout.trim().split("\n");
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 1) {
        const ip = parts[0];
        if (isValidIpv4(ip)) {
          return ip;
        }
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
};

/**
 * Gets the default gateway IP for bypassing VPN.
 * This is the gateway used before VPN is established.
 */
const getDefaultGateway = async (): Promise<string | undefined> => {
  try {
    // Get the default route's gateway
    const { stdout } = await execFileAsync("ip", [
      "route",
      "show",
      "default",
    ]);
    // Output looks like: "default via 172.17.0.1 dev eth0"
    // Extract the IP after "via" and validate it
    const match = stdout.match(/via\s+(\S+)/);
    const ip = match?.[1];
    if (ip && isValidIpv4(ip)) {
      return ip;
    }
    return undefined;
  } catch {
    return undefined;
  }
};

/**
 * Gets the interface name for the default route.
 */
const getDefaultInterface = async (): Promise<string | undefined> => {
  try {
    const { stdout } = await execFileAsync("ip", [
      "route",
      "show",
      "default",
    ]);
    // Output looks like: "default via 172.17.0.1 dev eth0"
    const match = stdout.match(/dev\s+(\S+)/);
    return match?.[1];
  } catch {
    return undefined;
  }
};

/**
 * Adds a direct route to bypass VPN for a specific IP.
 * This ensures traffic to that IP goes through the regular gateway, not the VPN tunnel.
 */
const addBypassRoute = async (
  ip: string,
  gateway: string,
  iface: string,
  logger: Logger,
): Promise<boolean> => {
  try {
    // Check if route already exists
    try {
      const { stdout } = await execFileAsync("ip", ["route", "show", ip]);
      if (stdout.trim()) {
        logger.info(`[VPN Bypass] Route to ${ip} already exists, skipping`);
        return true;
      }
    } catch {
      // No existing route, proceed to add
    }

    // Add direct route bypassing VPN
    await execFileAsync("ip", [
      "route",
      "add",
      ip,
      "via",
      gateway,
      "dev",
      iface,
    ]);
    logger.info(
      `[VPN Bypass] Added direct route for RPC: ${ip} via ${gateway} (${iface})`,
    );
    return true;
  } catch (err) {
    logger.warn(
      `[VPN Bypass] Failed to add route for ${ip}: ${(err as Error).message}`,
    );
    return false;
  }
};

/**
 * Configuration for VPN RPC bypass behavior.
 */
export interface VpnBypassConfig {
  /** Whether to bypass VPN for RPC traffic. Default: true */
  enabled: boolean;
  /** RPC URL to extract host from */
  rpcUrl: string;
}

/**
 * Reads VPN bypass configuration from environment variables.
 */
export const getVpnBypassConfig = (): VpnBypassConfig => {
  return {
    // Default to true - bypass VPN for RPC by default for better speed
    enabled: parseBool(readEnv("VPN_BYPASS_RPC"), true),
    rpcUrl: readEnv("RPC_URL") ?? "",
  };
};

/**
 * Sets up a direct route to bypass the VPN for RPC traffic.
 *
 * By default (VPN_BYPASS_RPC=true), RPC calls are routed outside the VPN tunnel
 * for better speed. VPN speed can bottleneck what would otherwise be faster
 * RPC responses. The VPN is still used for all other traffic (Polymarket API,
 * geoblocking, etc.).
 *
 * Set VPN_BYPASS_RPC=false to route RPC traffic through the VPN if your RPC
 * provider has geographic restrictions or you need additional privacy.
 *
 * This function should be called AFTER the VPN (WireGuard or OpenVPN) has started,
 * but BEFORE the VPN has captured the routing table. In practice, we capture the
 * default gateway BEFORE starting VPN, then add the bypass route AFTER VPN starts.
 *
 * @param logger - Logger instance for status messages
 * @param preVpnGateway - The default gateway captured before VPN started (optional)
 * @param preVpnInterface - The default interface captured before VPN started (optional)
 * @returns true if bypass was set up successfully (or was disabled), false on error
 */
export async function setupRpcVpnBypass(
  logger: Logger,
  preVpnGateway?: string,
  preVpnInterface?: string,
): Promise<boolean> {
  const config = getVpnBypassConfig();

  if (!config.enabled) {
    logger.info("[VPN Bypass] RPC VPN bypass disabled (VPN_BYPASS_RPC=false)");
    return true;
  }

  if (!config.rpcUrl) {
    logger.warn("[VPN Bypass] No RPC_URL set, cannot configure bypass");
    return true; // Not an error, just nothing to do
  }

  // Extract hostname from RPC URL
  const hostname = extractHost(config.rpcUrl);
  if (!hostname) {
    logger.warn(
      `[VPN Bypass] Could not parse hostname from RPC_URL: ${config.rpcUrl}`,
    );
    return false;
  }

  // Check if it's already a valid IP address
  let rpcIp: string;

  if (isValidIpv4(hostname)) {
    rpcIp = hostname;
  } else {
    // Resolve hostname to IP
    const resolved = await resolveHost(hostname);
    if (!resolved) {
      logger.warn(
        `[VPN Bypass] Could not resolve RPC hostname: ${hostname}. RPC traffic may go through VPN.`,
      );
      return false;
    }
    rpcIp = resolved;
    logger.info(`[VPN Bypass] Resolved ${hostname} -> ${rpcIp}`);
  }

  // Get gateway and interface (use pre-VPN values if provided, otherwise get current)
  const gateway = preVpnGateway ?? (await getDefaultGateway());
  const iface = preVpnInterface ?? (await getDefaultInterface());

  if (!gateway || !iface) {
    logger.warn(
      `[VPN Bypass] Could not determine default gateway/interface. RPC traffic may go through VPN.`,
    );
    return false;
  }

  // Add bypass route
  return addBypassRoute(rpcIp, gateway, iface, logger);
}

/**
 * Captures the current default gateway and interface before VPN starts.
 * This information is needed to create bypass routes after VPN is active.
 *
 * @returns Object with gateway and interface, or undefined values if capture fails
 */
export async function capturePreVpnRouting(): Promise<PreVpnRouting> {
  const gateway = await getDefaultGateway();
  const iface = await getDefaultInterface();
  return { gateway, iface };
}
