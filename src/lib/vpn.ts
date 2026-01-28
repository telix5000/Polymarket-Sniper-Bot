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
 * Environment Variables for VPN bypass:
 * - VPN_BYPASS_RPC: Set to "false" to route RPC through VPN (default: true)
 * - VPN_BYPASS_POLYMARKET_READS: Set to "true" to route reads outside VPN (default & RECOMMENDED: false; set to true only if you explicitly want Polymarket reads to bypass the VPN) [APEX v3.0 FIX]
 *
 * WireGuard configuration (either file or env vars):
 * - WG_CONFIG: Path to existing WireGuard config file (legacy; use this if you have a .conf file to mount)
 * - WIREGUARD_CONFIG: Full WireGuard config content as string (for Docker/K8s inline configs)
 * - WIREGUARD_CONFIG_PATH: Path to write generated config (default: /etc/wireguard/{interface}.conf)
 * - WIREGUARD_ENABLED: Set to "true" to enable WireGuard via individual env vars
 * - WIREGUARD_INTERFACE_NAME: Interface name (default: wg0)
 * - WIREGUARD_ADDRESS: Interface address (e.g., 10.0.0.2/24)
 * - WIREGUARD_PRIVATE_KEY: Interface private key
 * - WIREGUARD_MTU: MTU (optional)
 * - WIREGUARD_DNS: DNS servers (optional)
 * - WIREGUARD_PEER_PUBLIC_KEY: Peer public key
 * - WIREGUARD_PEER_PRESHARED_KEY: Peer preshared key (optional)
 * - WIREGUARD_PEER_ENDPOINT: Peer endpoint (host:port)
 * - WIREGUARD_ALLOWED_IPS: Allowed IP ranges (e.g., 0.0.0.0/0)
 * - WIREGUARD_PERSISTENT_KEEPALIVE: Keepalive interval (optional)
 * - WIREGUARD_FORCE_RESTART: Set to "true" to force restart interface on start
 *
 * OpenVPN configuration (either file path or inline config via env vars):
 * - OVPN_CONFIG: Path to existing OpenVPN config file (legacy; use this if you have a .ovpn file to mount)
 * - OPENVPN_ENABLED: Set to "true" to enable OpenVPN via env vars (requires OPENVPN_CONFIG for inline configs)
 * - OPENVPN_CONFIG: Full OpenVPN config contents as a string (newer/inline mode, e.g. for Docker/K8s where you can't mount files)
 * - OPENVPN_CONFIG_PATH: Path to write generated config when using OPENVPN_CONFIG (default: /etc/openvpn/client.ovpn)
 * - OPENVPN_USERNAME: VPN username (optional; requires auth-user-pass directive in config pointing to OPENVPN_AUTH_PATH)
 * - OPENVPN_PASSWORD: VPN password (optional; requires auth-user-pass directive in config pointing to OPENVPN_AUTH_PATH)
 * - OPENVPN_AUTH_PATH: Path to auth file (default: /etc/openvpn/auth.txt)
 * - OPENVPN_EXTRA_ARGS: Extra openvpn arguments (space-separated; quoted args with spaces NOT supported)
 */

import { execSync, spawn } from "child_process";
import { existsSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
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

// Validation patterns to prevent command injection
const HOSTNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$/;
const IP_PATTERN = /^(\d{1,3}\.){3}\d{1,3}$/;
const IFACE_PATTERN = /^[a-zA-Z0-9_-]+$/;

// Allowed directories for VPN config files (to prevent path traversal)
const ALLOWED_VPN_DIRS = ["/etc/wireguard", "/etc/openvpn"];

/**
 * Validate a hostname to prevent command injection
 */
function isValidHostname(hostname: string): boolean {
  return (
    hostname.length > 0 &&
    hostname.length <= 253 &&
    HOSTNAME_PATTERN.test(hostname)
  );
}

/**
 * Validate an IP address
 */
function isValidIp(ip: string): boolean {
  if (!IP_PATTERN.test(ip)) return false;
  const parts = ip.split(".");
  return parts.every((p) => {
    const n = parseInt(p, 10);
    return n >= 0 && n <= 255;
  });
}

/**
 * Validate a network interface name
 */
function isValidIface(iface: string): boolean {
  return iface.length > 0 && iface.length <= 16 && IFACE_PATTERN.test(iface);
}

/**
 * Validate a file path to prevent path traversal attacks.
 * Returns true if path is within one of the allowed directories.
 */
function isValidVpnPath(filePath: string, logger?: Logger): boolean {
  // Check for path traversal sequences
  if (filePath.includes("..")) {
    logger?.warn?.(`Path traversal detected in VPN path: ${filePath}`);
    return false;
  }

  // Normalize the path and check it starts with an allowed directory
  const normalizedPath = filePath.replace(/\/+/g, "/");
  const isAllowed = ALLOWED_VPN_DIRS.some(
    (dir) => normalizedPath.startsWith(dir + "/") || normalizedPath === dir,
  );

  if (!isAllowed) {
    logger?.warn?.(
      `VPN path not in allowed directories: ${filePath}. Allowed: ${ALLOWED_VPN_DIRS.join(", ")}`,
    );
    return false;
  }

  return true;
}

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
    // Get both gateway and interface in a single command for efficiency
    const rawRouteInfo = execSync(
      "ip route | grep default | awk '{print $3 \" \" $5}'",
      { encoding: "utf8" },
    ).trim();

    // Select a single default route deterministically and split on whitespace
    const firstLine =
      rawRouteInfo.split("\n").find((line) => line.trim().length > 0) ?? "";
    const parts = firstLine.trim().split(/\s+/);
    const gateway = parts[0] ?? "";
    const iface = parts[1] ?? "";

    // Validate the output before storing
    if (gateway && iface && isValidIp(gateway) && isValidIface(iface)) {
      preVpnRouting = { gateway, iface };
      logger?.info?.(`Pre-VPN routing: gateway=${gateway} iface=${iface}`);
      return preVpnRouting;
    } else if (gateway || iface) {
      logger?.warn?.(`Invalid routing info: gateway=${gateway} iface=${iface}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.warn?.(`Failed to capture pre-VPN routing: ${msg}`);
  }

  return { gateway: "", iface: "" };
}

/**
 * Generate WireGuard config from environment variables
 * Returns the config path if successful, null otherwise
 */
function generateWireguardConfig(logger?: Logger): string | null {
  // Check if WireGuard is enabled via env var
  const enabled = process.env.WIREGUARD_ENABLED?.toLowerCase() === "true";
  if (!enabled) {
    return null;
  }

  // Required env vars
  const privateKey = process.env.WIREGUARD_PRIVATE_KEY;
  const address = process.env.WIREGUARD_ADDRESS;
  const peerPublicKey = process.env.WIREGUARD_PEER_PUBLIC_KEY;
  const peerEndpoint = process.env.WIREGUARD_PEER_ENDPOINT;
  const allowedIPs = process.env.WIREGUARD_ALLOWED_IPS;

  if (
    !privateKey ||
    !address ||
    !peerPublicKey ||
    !peerEndpoint ||
    !allowedIPs
  ) {
    logger?.warn?.(
      "WIREGUARD_ENABLED=true but missing required env vars: " +
        "WIREGUARD_PRIVATE_KEY, WIREGUARD_ADDRESS, WIREGUARD_PEER_PUBLIC_KEY, " +
        "WIREGUARD_PEER_ENDPOINT, WIREGUARD_ALLOWED_IPS",
    );
    return null;
  }

  // Optional env vars - validate interface name to prevent path traversal
  const interfaceName = process.env.WIREGUARD_INTERFACE_NAME ?? "wg0";
  if (!isValidIface(interfaceName)) {
    logger?.warn?.(`Invalid WireGuard interface name: ${interfaceName}`);
    return null;
  }

  const mtu = process.env.WIREGUARD_MTU;
  const dns = process.env.WIREGUARD_DNS;
  const presharedKey = process.env.WIREGUARD_PEER_PRESHARED_KEY;
  const persistentKeepalive = process.env.WIREGUARD_PERSISTENT_KEEPALIVE;

  // Detect container environment - Alpine containers often have resolvconf installed
  // but it requires an init system (systemd/OpenRC) to manage DNS state, which
  // containers typically lack. In containers, use PostUp/PostDown scripts to manage DNS directly.
  const isContainer =
    existsSync("/.dockerenv") ||
    process.env.container?.toLowerCase() === "docker" ||
    process.env.container?.toLowerCase() === "podman" ||
    !!process.env.container;

  // Build config
  let config = "[Interface]\n";
  config += `PrivateKey = ${privateKey}\n`;
  config += `Address = ${address}\n`;
  if (mtu) config += `MTU = ${mtu}\n`;

  // DNS handling: In containers, use PostUp/PostDown to write DNS directly to /etc/resolv.conf
  // instead of the DNS directive which relies on resolvconf (fails in Alpine containers).
  // On bare metal/VM, use the standard DNS directive which works with resolvconf.
  if (dns) {
    if (isContainer) {
      // Container workaround: Use PostUp/PostDown scripts to manage DNS directly
      // This avoids resolvconf which fails with "could not detect a useable init system"
      const dnsServers = dns
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      // Validate each DNS server to prevent shell injection attacks
      const validDnsServers = dnsServers.filter((server) => {
        if (!isValidIp(server)) {
          logger?.warn?.(`Invalid DNS server IP skipped: ${server}`);
          return false;
        }
        return true;
      });
      if (validDnsServers.length > 0) {
        const nameserverLines = validDnsServers
          .map((s) => `nameserver ${s}`)
          .join("\\n");
        // Use interface-specific backup file to avoid conflicts with multiple WireGuard interfaces
        const backupPath = `/etc/resolv.conf.${interfaceName}-backup`;
        // Preserve existing DNS entries by prepending VPN DNS servers to the original resolv.conf
        config += `PostUp = cp /etc/resolv.conf ${backupPath} 2>/dev/null || true; (printf '${nameserverLines}\\n'; cat ${backupPath} 2>/dev/null || cat /etc/resolv.conf) > /etc/resolv.conf.tmp && mv /etc/resolv.conf.tmp /etc/resolv.conf\n`;
        // Restore backup if it exists, otherwise fall back to a default DNS server
        config += `PostDown = if [ -f ${backupPath} ]; then cp ${backupPath} /etc/resolv.conf 2>/dev/null || true; else echo 'nameserver 8.8.8.8' > /etc/resolv.conf; fi\n`;
        logger?.info?.(
          `WIREGUARD_DNS detected in container - using PostUp/PostDown scripts instead of resolvconf`,
        );
      } else {
        logger?.warn?.(
          `WIREGUARD_DNS specified but no valid IP addresses found, skipping DNS config`,
        );
      }
    } else {
      // Non-container: Use standard DNS directive (resolvconf should work)
      config += `DNS = ${dns}\n`;
    }
  }

  config += "\n[Peer]\n";
  config += `PublicKey = ${peerPublicKey}\n`;
  if (presharedKey) config += `PresharedKey = ${presharedKey}\n`;
  config += `Endpoint = ${peerEndpoint}\n`;
  config += `AllowedIPs = ${allowedIPs}\n`;
  if (persistentKeepalive)
    config += `PersistentKeepalive = ${persistentKeepalive}\n`;

  // Write config
  const configDir = "/etc/wireguard";
  const configPath = `${configDir}/${interfaceName}.conf`;

  try {
    // Ensure directory exists
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true, mode: 0o700 });
    }

    // Write config with secure permissions
    writeFileSync(configPath, config, { mode: 0o600 });
    logger?.info?.(`Generated WireGuard config at ${configPath}`);

    return configPath;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.warn?.(`Failed to write WireGuard config: ${msg}`);
    return null;
  }
}

/**
 * Start WireGuard if config exists or can be generated from env vars
 */
export async function startWireguard(logger?: Logger): Promise<boolean> {
  // Validate interface name to prevent command injection
  const interfaceName = process.env.WIREGUARD_INTERFACE_NAME ?? "wg0";
  if (!isValidIface(interfaceName)) {
    logger?.warn?.(`Invalid WireGuard interface name: ${interfaceName}`);
    return false;
  }

  // Check for force restart
  const forceRestart =
    process.env.WIREGUARD_FORCE_RESTART?.toLowerCase() === "true";

  if (forceRestart) {
    try {
      execSync(`wg-quick down ${interfaceName} 2>/dev/null || true`, {
        stdio: "pipe",
      });
      logger?.info?.(`Force restarted WireGuard interface ${interfaceName}`);
    } catch {
      // Ignore errors if interface doesn't exist
    }
  }

  // First, try explicit config path (WG_CONFIG only - for reading existing files)
  let configPath: string | null = process.env.WG_CONFIG ?? null;

  // If no explicit path, check for config file content from env
  if (!configPath && process.env.WIREGUARD_CONFIG) {
    // Write the full config content to file
    const configDir = "/etc/wireguard";
    const targetPath = `${configDir}/${interfaceName}.conf`;

    // Check if interface is active before overwriting
    if (existsSync(targetPath) && !forceRestart) {
      try {
        execSync(`wg show ${interfaceName}`, { stdio: "pipe" });
        // Interface is active - don't overwrite
        logger?.warn?.(
          `WireGuard interface ${interfaceName} appears active; not overwriting existing config at ${targetPath}. ` +
            `Set WIREGUARD_FORCE_RESTART=true to force restart with a new configuration.`,
        );
        configPath = targetPath;
      } catch {
        // Interface not active, safe to write
        try {
          if (!existsSync(configDir)) {
            mkdirSync(configDir, { recursive: true, mode: 0o700 });
          }
          writeFileSync(targetPath, process.env.WIREGUARD_CONFIG, {
            mode: 0o600,
          });
          logger?.info?.(
            `Wrote WireGuard config from WIREGUARD_CONFIG env var`,
          );
          configPath = targetPath;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger?.warn?.(`Failed to write WIREGUARD_CONFIG: ${msg}`);
        }
      }
    } else {
      try {
        if (!existsSync(configDir)) {
          mkdirSync(configDir, { recursive: true, mode: 0o700 });
        }
        writeFileSync(targetPath, process.env.WIREGUARD_CONFIG, {
          mode: 0o600,
        });
        logger?.info?.(`Wrote WireGuard config from WIREGUARD_CONFIG env var`);
        configPath = targetPath;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger?.warn?.(`Failed to write WIREGUARD_CONFIG: ${msg}`);
      }
    }
  }

  // If still no config, try to generate from individual env vars
  if (!configPath || !existsSync(configPath)) {
    const generatedPath = generateWireguardConfig(logger);
    if (generatedPath) {
      configPath = generatedPath;
    }
  }

  // Fall back to default path
  if (!configPath) {
    configPath = "/etc/wireguard/wg0.conf";
  }

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
 * Generate OpenVPN config and auth files from environment variables
 * Returns the config path if successful, null otherwise
 */
function generateOpenvpnConfig(logger?: Logger): string | null {
  // Check if OpenVPN is enabled via env var
  const enabled = process.env.OPENVPN_ENABLED?.toLowerCase() === "true";
  if (!enabled) {
    return null;
  }

  // Check for full config content
  const configContent = process.env.OPENVPN_CONFIG;
  if (!configContent) {
    logger?.warn?.(
      "OPENVPN_ENABLED=true but OPENVPN_CONFIG env var not set. " +
        "Provide the full OpenVPN config content.",
    );
    return null;
  }

  const configDir = "/etc/openvpn";
  const configPath =
    process.env.OPENVPN_CONFIG_PATH ?? `${configDir}/client.ovpn`;
  const authPath = process.env.OPENVPN_AUTH_PATH ?? `${configDir}/auth.txt`;

  // Validate paths to prevent path traversal attacks
  if (!isValidVpnPath(configPath, logger)) {
    return null;
  }
  if (!isValidVpnPath(authPath, logger)) {
    return null;
  }

  try {
    // Ensure directory exists
    const targetDir = dirname(configPath);
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    }

    // Write config with secure permissions
    writeFileSync(configPath, configContent, { mode: 0o600 });
    logger?.info?.(`Generated OpenVPN config at ${configPath}`);

    // Handle auth file if username/password provided
    // Note: User must include "auth-user-pass <authPath>" directive in their OPENVPN_CONFIG
    // for credentials to be used by OpenVPN
    const username = process.env.OPENVPN_USERNAME;
    const password = process.env.OPENVPN_PASSWORD;
    if (username && password) {
      const authDir = dirname(authPath);
      if (!existsSync(authDir)) {
        mkdirSync(authDir, { recursive: true, mode: 0o700 });
      }
      writeFileSync(authPath, `${username}\n${password}\n`, { mode: 0o600 });
      logger?.info?.(`Generated OpenVPN auth file at ${authPath}`);
      logger?.info?.(
        `Ensure your OPENVPN_CONFIG includes: auth-user-pass ${authPath}`,
      );
    }

    return configPath;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.warn?.(`Failed to write OpenVPN config: ${msg}`);
    return null;
  }
}

/**
 * Start OpenVPN if config exists or can be generated from env vars
 */
export async function startOpenvpn(logger?: Logger): Promise<boolean> {
  // First, try explicit config path (OVPN_CONFIG only - for reading existing files)
  let configPath: string | null = process.env.OVPN_CONFIG ?? null;

  // If no explicit path, try to generate from env vars
  if (!configPath || !existsSync(configPath)) {
    const generatedPath = generateOpenvpnConfig(logger);
    if (generatedPath) {
      configPath = generatedPath;
    }
  }

  // Fall back to default path
  if (!configPath) {
    configPath = "/etc/openvpn/client.ovpn";
  }

  if (!existsSync(configPath)) {
    return false;
  }

  try {
    logger?.info?.("Starting OpenVPN...");

    // Build command arguments
    const args = ["--config", configPath, "--daemon"];

    // Add extra args if provided
    // Note: Args are split on whitespace - quoted args with spaces are NOT supported
    const extraArgs = process.env.OPENVPN_EXTRA_ARGS;
    if (extraArgs) {
      args.push(...extraArgs.split(/\s+/).filter(Boolean));
    }

    const proc = spawn("openvpn", args, {
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
  // Validate hostname to prevent command injection
  if (!isValidHostname(hostname)) {
    logger?.warn?.(`Invalid hostname format: ${hostname}`);
    return null;
  }

  // Use captured pre-VPN routing (already validated in capturePreVpnRouting)
  const effectiveGateway = preVpnRouting?.gateway;
  const effectiveIface = preVpnRouting?.iface;

  if (!effectiveGateway || !effectiveIface) {
    logger?.warn?.(
      `Cannot add bypass for ${hostname}: no pre-VPN routing info available`,
    );
    return null;
  }

  try {
    // Get host IPv4 address - hostname is validated above
    // Use ahostsv4 to deterministically get first IPv4 address
    const ip = execSync(
      `getent ahostsv4 ${hostname} | awk 'NR==1 {print $1; exit}'`,
      { encoding: "utf8" },
    ).trim();

    // Validate the resolved IP
    if (!ip || !isValidIp(ip)) {
      logger?.warn?.(`Cannot resolve valid IP for ${hostname}: got ${ip}`);
      return null;
    }

    // Add route to bypass VPN (all values validated)
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
 * Setup Polymarket API bypass for reads (gamma API, strapi)
 * Routes read-only API traffic outside VPN for speed.
 *
 * NOTE: clob.polymarket.com is NOT bypassed because it handles both
 * read operations (orderbooks, markets) AND write operations (orders, auth).
 * Write operations require VPN protection to avoid geo-blocking, and
 * IP-level routing cannot differentiate between reads and writes.
 *
 * APEX v3.0 CRITICAL FIX: Disabled by default to prevent geo-blocking.
 * Set VPN_BYPASS_POLYMARKET_READS=true to enable bypass.
 */
export async function setupPolymarketReadBypass(
  logger?: Logger,
): Promise<void> {
  // APEX v3.0 FIX: Changed default to false (disabled)
  // Check if bypass is explicitly enabled
  if (process.env.VPN_BYPASS_POLYMARKET_READS !== "true") {
    logger?.info?.(
      "Polymarket read bypass disabled (default) - all traffic through VPN",
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

  // Polymarket API hosts for reads ONLY
  // NOTE: clob.polymarket.com is intentionally EXCLUDED because it handles
  // both reads (orderbooks) AND writes (order submissions, auth).
  // Order submissions require VPN to avoid geo-blocking, and IP-level routing
  // cannot differentiate between read and write requests to the same host.
  const hosts = [
    // "clob.polymarket.com" - EXCLUDED: handles orders which need VPN protection
    "gamma-api.polymarket.com", // Gamma API (reads only) - CONFIRMED: does NOT need VPN
    "data-api.polymarket.com", // Data API (reads only) - used for whale tracking
    // "strapi-matic.poly.market" - NOT USED by this bot
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
 * Setup Gamma API bypass - this API does NOT need VPN (confirmed)
 * Called by default when VPN is active to speed up market scanning and whale tracking
 */
export async function setupReadApiBypass(logger?: Logger): Promise<void> {
  if (!vpnActive) {
    // No VPN active, no need for bypass
    return;
  }

  if (!preVpnRouting?.gateway) {
    logger?.warn?.(
      "Cannot setup read API bypass: pre-VPN routing not captured",
    );
    return;
  }

  // These APIs do NOT require VPN (confirmed by user):
  // - gamma-api.polymarket.com: Market data, volumes
  // - data-api.polymarket.com: Leaderboard, whale activity, positions
  const readOnlyApis = ["gamma-api.polymarket.com", "data-api.polymarket.com"];

  for (const host of readOnlyApis) {
    const result = addBypassRoute(host, logger);
    if (result) {
      logger?.info?.(
        `Read API bypass: ${host} -> ${result.ip} via ${result.gateway}`,
      );
    }
  }
}

// Legacy alias for backward compatibility
export const setupGammaApiBypass = setupReadApiBypass;

/**
 * Setup WebSocket bypass for CLOB market data streams
 *
 * The CLOB WebSocket (ws-subscriptions-clob.polymarket.com) is read-only
 * market data and does NOT need VPN protection. Bypassing improves latency
 * for real-time orderbook updates.
 *
 * NOTE: This bypasses the Market channel (public data). The User channel
 * uses the same host but requires authentication - still works with bypass
 * since auth is at the application layer, not IP-based.
 */
export async function setupWebSocketBypass(logger?: Logger): Promise<void> {
  if (!vpnActive) {
    // No VPN active, no need for bypass
    return;
  }

  if (!preVpnRouting?.gateway) {
    logger?.warn?.(
      "Cannot setup WebSocket bypass: pre-VPN routing not captured",
    );
    return;
  }

  // CLOB WebSocket host - handles both Market (public) and User (authenticated) channels
  // Both are read-only subscriptions that don't need geo-blocking protection
  const wsHost = "ws-subscriptions-clob.polymarket.com";

  const result = addBypassRoute(wsHost, logger);
  if (result) {
    logger?.info?.(
      `WebSocket bypass: ${wsHost} -> ${result.ip} via ${result.gateway}`,
    );
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
      "   Configure WireGuard (WIREGUARD_ENABLED=true + WIREGUARD_* vars, or WG_CONFIG path)",
    );
    warnings.push(
      "   Or OpenVPN (OPENVPN_ENABLED=true + OPENVPN_CONFIG, or OVPN_CONFIG path)",
    );
  }

  if (warnings.length > 0 && logger) {
    warnings.forEach((w) => logger.warn?.(w));
  }

  return warnings;
}
