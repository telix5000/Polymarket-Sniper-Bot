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
 *
 * CRITICAL: WRITE hosts are NEVER bypassed - this function will reject them.
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

  // CRITICAL: Never bypass WRITE hosts - they must always route through VPN
  if (WRITE_HOSTS.has(hostname)) {
    const blockEvent = {
      event: "BLOCKED_BYPASS_WRITE_HOST",
      timestamp: new Date().toISOString(),
      hostname,
      reason: "WRITE hosts must route through VPN for Cloudflare protection",
    };
    console.warn(JSON.stringify(blockEvent));
    logger?.warn?.(
      `BLOCKED: Cannot bypass WRITE host ${hostname} - must route through VPN`,
    );
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

    // Track bypassed hosts for verification
    bypassedHosts.add(hostname);

    // Emit READ_BYPASS_OK event
    const bypassEvent = {
      event: "READ_BYPASS_OK",
      timestamp: new Date().toISOString(),
      hostname,
      ip,
      gateway: effectiveGateway,
      interface: effectiveIface,
    };
    logger?.debug?.(JSON.stringify(bypassEvent));

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

// ═══════════════════════════════════════════════════════════════════════════
// EXPLICIT WRITE/READ HOST DEFINITIONS (CRITICAL for VPN routing correctness)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * WRITE HOSTS - These hosts handle state-mutating operations and MUST ALWAYS
 * route through VPN to avoid Cloudflare geo-blocking.
 *
 * Includes:
 * - Auth/credential exchange endpoints
 * - Order submission endpoints
 * - Order cancellation endpoints
 * - Any endpoint that mutates state
 */
export const WRITE_HOSTS = new Set<string>([
  "clob.polymarket.com", // CLOB API: auth, orders, cancels - CRITICAL
]);

/**
 * READ-ONLY HOSTS - These hosts are safe to bypass VPN for speed.
 * Only bypassed if explicitly enabled via env vars.
 *
 * Includes:
 * - Market data (gamma-api)
 * - Analytics/leaderboard (data-api)
 */
export const READ_ONLY_HOSTS = new Set<string>([
  "gamma-api.polymarket.com", // Gamma API - market data, volumes
  "data-api.polymarket.com", // Data API - leaderboard, whale activity
]);

/**
 * Check if a hostname is a WRITE host (must always go through VPN)
 */
export function isWriteHost(hostname: string): boolean {
  return WRITE_HOSTS.has(hostname);
}

/**
 * Check if a hostname is a READ-ONLY host (safe to bypass VPN)
 */
export function isReadOnlyHost(hostname: string): boolean {
  return READ_ONLY_HOSTS.has(hostname);
}

// ═══════════════════════════════════════════════════════════════════════════
// BYPASS ROUTE TRACKING (to verify no write hosts are bypassed)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Track which hosts have been added to bypass routes.
 * Used to verify WRITE hosts are never bypassed.
 */
const bypassedHosts = new Set<string>();

/**
 * Get list of currently bypassed hosts
 */
export function getBypassedHosts(): string[] {
  return [...bypassedHosts];
}

/**
 * Check if a host is currently bypassed
 */
export function isHostBypassed(hostname: string): boolean {
  return bypassedHosts.has(hostname);
}

/**
 * Emit VPN routing policy log at startup.
 * This is a diagnostic self-check that shows the routing configuration.
 */
export function emitRoutingPolicyLog(rpcUrl?: string, logger?: Logger): void {
  const policyEvent = {
    event: "VPN_ROUTING_POLICY",
    timestamp: new Date().toISOString(),
    vpnActive,
    vpnType,
    preVpnRouting: {
      gateway: preVpnRouting?.gateway ?? null,
      iface: preVpnRouting?.iface ?? null,
    },
    writeHosts: [...WRITE_HOSTS],
    readOnlyHosts: [...READ_ONLY_HOSTS],
    bypassedHosts: [...bypassedHosts],
    envConfig: {
      VPN_BYPASS_RPC: process.env.VPN_BYPASS_RPC ?? "true",
      VPN_BYPASS_POLYMARKET_READS:
        process.env.VPN_BYPASS_POLYMARKET_READS ?? "false",
      VPN_BYPASS_POLYMARKET_WS: process.env.VPN_BYPASS_POLYMARKET_WS ?? "true",
    },
  };

  console.log(JSON.stringify(policyEvent));

  // Check for any misrouted write hosts
  const misroutedWriteHosts = [...WRITE_HOSTS].filter((h) =>
    bypassedHosts.has(h),
  );
  if (misroutedWriteHosts.length > 0) {
    const errorEvent = {
      event: "VPN_MISROUTED_WRITE_HOST",
      timestamp: new Date().toISOString(),
      misroutedHosts: misroutedWriteHosts,
      remediation:
        "WRITE hosts must route through VPN. Remove bypass routes for these hosts.",
    };
    console.error(JSON.stringify(errorEvent));

    if (process.env.GITHUB_ACTIONS === "true") {
      console.log(
        `::error::VPN_MISROUTED_WRITE_HOST: ${misroutedWriteHosts.join(", ")} are bypassed but must route through VPN`,
      );
    }

    logger?.error?.(
      `VPN_MISROUTED_WRITE_HOST: ${misroutedWriteHosts.join(", ")} are bypassed but must route through VPN`,
    );
  }
}

/**
 * Verify that all write hosts route through VPN BEFORE placing an order.
 * This is a pre-order safety check.
 *
 * @param traceId - Trace ID for correlation in diagnostic events
 * @param logger - Optional logger
 * @returns true if all write hosts route correctly, false if any are bypassed
 */
export function verifyWritePathBeforeOrder(
  traceId: string,
  logger?: Logger,
): { ok: boolean; misroutedHosts: string[] } {
  const misroutedWriteHosts = [...WRITE_HOSTS].filter((h) =>
    bypassedHosts.has(h),
  );

  if (misroutedWriteHosts.length > 0) {
    const errorEvent = {
      event: "VPN_MISROUTED_WRITE_HOST",
      traceId,
      timestamp: new Date().toISOString(),
      action: "pre_order_check",
      misroutedHosts: misroutedWriteHosts,
      vpnActive,
      bypassedHosts: [...bypassedHosts],
      remediation:
        "Order blocked: WRITE hosts must route through VPN. Check VPN configuration.",
    };
    console.error(JSON.stringify(errorEvent));

    if (process.env.GITHUB_ACTIONS === "true") {
      console.log(
        `::error::VPN_MISROUTED_WRITE_HOST: Order blocked. ${misroutedWriteHosts.join(", ")} are bypassed.`,
      );
    }

    logger?.error?.(
      `Order blocked: WRITE hosts ${misroutedWriteHosts.join(", ")} are bypassed but must route through VPN`,
    );

    return { ok: false, misroutedHosts: misroutedWriteHosts };
  }

  return { ok: true, misroutedHosts: [] };
}

// ═══════════════════════════════════════════════════════════════════════════
// VPN ROUTING PLAN & VALIDATION (Deliverable G)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Network egress categories
 */
export type EgressCategory = "RPC" | "READ_API" | "WRITE_API" | "WEBSOCKET";

/**
 * Expected route type for a category
 */
export type ExpectedRoute = "VPN" | "BYPASS";

/**
 * Host routing configuration
 */
export interface HostRoutingInfo {
  hostname: string;
  category: EgressCategory;
  expectedRoute: ExpectedRoute;
  resolvedIps: string[];
  actualInterface?: string;
  actualGateway?: string;
  routeMatches: boolean;
}

/**
 * Full routing plan
 */
export interface RoutingPlan {
  timestamp: string;
  vpnActive: boolean;
  vpnType: "wireguard" | "openvpn" | "none";
  preVpnGateway: string;
  preVpnInterface: string;
  hosts: HostRoutingInfo[];
  allWritesRouteCorrectly: boolean;
}

/**
 * Known hosts and their categories.
 * CRITICAL: clob.polymarket.com is WRITE_API and must NEVER be bypassed.
 */
const KNOWN_HOSTS: Array<{
  hostname: string;
  category: EgressCategory;
  expectedRoute: ExpectedRoute;
}> = [
  // READ APIs - default to VPN, but can be explicitly bypassed for speed
  // Set VPN_BYPASS_POLYMARKET_READS=true to bypass VPN
  {
    hostname: "gamma-api.polymarket.com",
    category: "READ_API",
    expectedRoute: "VPN",
  },
  {
    hostname: "data-api.polymarket.com",
    category: "READ_API",
    expectedRoute: "VPN",
  },

  // WRITE APIs - MUST go through VPN
  {
    hostname: "clob.polymarket.com",
    category: "WRITE_API",
    expectedRoute: "VPN",
  },

  // WebSocket - configurable bypass
  {
    hostname: "ws-subscriptions-clob.polymarket.com",
    category: "WEBSOCKET",
    expectedRoute: "BYPASS",
  },

  // RPC - typically bypassed
  {
    hostname: "polygon-mainnet.infura.io",
    category: "RPC",
    expectedRoute: "BYPASS",
  },
];

/**
 * Resolve all IPv4 addresses for a hostname.
 * Returns multiple IPs for hosts behind load balancers (like Cloudflare).
 */
function resolveAllIpv4(hostname: string, logger?: Logger): string[] {
  if (!isValidHostname(hostname)) {
    logger?.warn?.(`Invalid hostname format: ${hostname}`);
    return [];
  }

  try {
    // Get all IPv4 addresses using getent ahostsv4
    const output = execSync(
      `getent ahostsv4 ${hostname} 2>/dev/null | awk '{print $1}' | sort -u`,
      {
        encoding: "utf8",
      },
    ).trim();

    if (!output) return [];

    const ips = output.split("\n").filter((ip) => ip && isValidIp(ip));
    return ips;
  } catch {
    return [];
  }
}

/**
 * Get the interface and gateway used to reach a specific IP.
 * Uses `ip route get` to determine the actual route.
 */
function getRouteForIp(ip: string): { interface?: string; gateway?: string } {
  if (!isValidIp(ip)) {
    return {};
  }

  try {
    // ip route get <ip> shows the route used to reach that IP
    const output = execSync(`ip route get ${ip} 2>/dev/null`, {
      encoding: "utf8",
    }).trim();

    // Parse output like: "1.2.3.4 via 10.0.0.1 dev eth0 src 192.168.1.2"
    const viaMatch = output.match(/via\s+(\d+\.\d+\.\d+\.\d+)/);
    const devMatch = output.match(/dev\s+(\S+)/);

    return {
      gateway: viaMatch?.[1],
      interface: devMatch?.[1],
    };
  } catch {
    return {};
  }
}

/**
 * Check if a route goes through VPN (i.e., NOT through the pre-VPN gateway/interface).
 */
function isRouteThroughVpn(route: {
  interface?: string;
  gateway?: string;
}): boolean {
  if (!preVpnRouting?.gateway || !preVpnRouting?.iface) {
    // Can't determine - assume VPN if we have an interface
    return !!route.interface;
  }

  // If route uses the pre-VPN gateway or interface, it's bypassing VPN
  const usesBypass =
    route.gateway === preVpnRouting.gateway ||
    route.interface === preVpnRouting.iface;

  return !usesBypass;
}

/**
 * Generate a routing plan showing all network egress destinations and their routes.
 * This should be called at startup (after VPN is configured) for diagnostics.
 *
 * @param rpcUrl - The RPC URL to include in the plan
 * @param logger - Optional logger
 * @returns Routing plan with all hosts and their routes
 */
export function generateRoutingPlan(
  rpcUrl?: string,
  logger?: Logger,
): RoutingPlan {
  const hosts: HostRoutingInfo[] = [];

  // Build host list including custom RPC
  const hostsToCheck = [...KNOWN_HOSTS];

  // Add custom RPC if provided and not already in list
  if (rpcUrl) {
    try {
      const rpcHostname = new URL(rpcUrl).hostname;
      if (!hostsToCheck.find((h) => h.hostname === rpcHostname)) {
        hostsToCheck.push({
          hostname: rpcHostname,
          category: "RPC",
          expectedRoute:
            process.env.VPN_BYPASS_RPC === "false" ? "VPN" : "BYPASS",
        });
      }
    } catch {
      // Invalid URL - skip
    }
  }

  // Check each host
  for (const hostConfig of hostsToCheck) {
    // Adjust expected route based on config
    let expectedRoute = hostConfig.expectedRoute;

    // WebSocket bypass is configurable (default: BYPASS for latency)
    // Set VPN_BYPASS_POLYMARKET_WS=false to route WS through VPN
    if (
      hostConfig.category === "WEBSOCKET" &&
      process.env.VPN_BYPASS_POLYMARKET_WS === "false"
    ) {
      expectedRoute = "VPN";
    }

    // READ API bypass is configurable (default: VPN for conservative approach)
    // Set VPN_BYPASS_POLYMARKET_READS=true to bypass VPN for READ APIs
    // NOTE: This is intentionally more conservative than WebSocket/RPC defaults
    if (
      hostConfig.category === "READ_API" &&
      process.env.VPN_BYPASS_POLYMARKET_READS === "true"
    ) {
      expectedRoute = "BYPASS";
    }

    // RPC bypass is configurable (default: BYPASS for speed)
    // Set VPN_BYPASS_RPC=false to route RPC through VPN
    if (
      hostConfig.category === "RPC" &&
      process.env.VPN_BYPASS_RPC === "false"
    ) {
      expectedRoute = "VPN";
    }

    // WRITE_API must ALWAYS go through VPN - never bypassed
    if (hostConfig.category === "WRITE_API") {
      expectedRoute = "VPN";
    }

    const resolvedIps = resolveAllIpv4(hostConfig.hostname, logger);
    const firstIp = resolvedIps[0];
    const route = firstIp ? getRouteForIp(firstIp) : {};

    const actuallyThroughVpn =
      vpnActive && firstIp ? isRouteThroughVpn(route) : false;
    const routeMatches =
      !vpnActive ||
      (expectedRoute === "VPN" && actuallyThroughVpn) ||
      (expectedRoute === "BYPASS" && !actuallyThroughVpn);

    hosts.push({
      hostname: hostConfig.hostname,
      category: hostConfig.category,
      expectedRoute,
      resolvedIps,
      actualInterface: route.interface,
      actualGateway: route.gateway,
      routeMatches,
    });
  }

  // Check if all WRITE_API hosts route correctly
  const allWritesRouteCorrectly = hosts
    .filter((h) => h.category === "WRITE_API")
    .every((h) => h.routeMatches);

  const plan: RoutingPlan = {
    timestamp: new Date().toISOString(),
    vpnActive,
    vpnType,
    preVpnGateway: preVpnRouting?.gateway ?? "",
    preVpnInterface: preVpnRouting?.iface ?? "",
    hosts,
    allWritesRouteCorrectly,
  };

  return plan;
}

/**
 * Print the routing plan to console in a human-readable format.
 * Safe for DIAG mode - does not reveal private IPs.
 */
export function printRoutingPlan(plan: RoutingPlan, logger?: Logger): void {
  console.log("");
  console.log("═".repeat(70));
  console.log("  🌐 VPN ROUTING PLAN");
  console.log("═".repeat(70));
  console.log(`  Timestamp: ${plan.timestamp}`);
  console.log(`  VPN Active: ${plan.vpnActive ? "YES" : "NO"}`);
  console.log(`  VPN Type: ${plan.vpnType}`);
  console.log("");

  console.log("  HOSTS:");
  console.log("  " + "-".repeat(66));
  console.log(
    "  " +
      "Hostname".padEnd(40) +
      "Category".padEnd(12) +
      "Expected".padEnd(10) +
      "OK",
  );
  console.log("  " + "-".repeat(66));

  for (const host of plan.hosts) {
    const ok = host.routeMatches ? "✅" : "❌";
    console.log(
      "  " +
        host.hostname.padEnd(40) +
        host.category.padEnd(12) +
        host.expectedRoute.padEnd(10) +
        ok,
    );

    // Show warning for misrouted WRITE hosts
    if (!host.routeMatches && host.category === "WRITE_API") {
      console.log(
        `     ⚠️  WRITE host not routed through VPN! Orders may be blocked.`,
      );
    }
  }

  console.log("  " + "-".repeat(66));
  console.log("");

  if (!plan.allWritesRouteCorrectly) {
    console.log("  ❌ CRITICAL: Not all WRITE hosts route through VPN!");
    console.log("     Live trading may fail due to Cloudflare geo-blocking.");
    console.log("");
  } else if (plan.vpnActive) {
    console.log("  ✅ All WRITE hosts correctly route through VPN.");
    console.log("");
  }

  console.log("═".repeat(70));
  console.log("");

  // Also emit structured JSON for DIAG
  const safeEvent = {
    event: "VPN_ROUTING_PLAN",
    vpnActive: plan.vpnActive,
    vpnType: plan.vpnType,
    allWritesRouteCorrectly: plan.allWritesRouteCorrectly,
    hostCount: plan.hosts.length,
    misroutedWriteHosts: plan.hosts
      .filter((h) => h.category === "WRITE_API" && !h.routeMatches)
      .map((h) => h.hostname),
  };
  console.log(JSON.stringify(safeEvent));

  // Emit GitHub Actions annotation if WRITE hosts are misrouted
  if (!plan.allWritesRouteCorrectly) {
    const misrouted = plan.hosts
      .filter((h) => h.category === "WRITE_API" && !h.routeMatches)
      .map((h) => h.hostname)
      .join(", ");

    if (process.env.GITHUB_ACTIONS === "true") {
      console.log(
        `::error::VPN routing error: WRITE hosts (${misrouted}) not routed through VPN. Orders may be geo-blocked.`,
      );
    }

    logger?.error?.(
      `VPN routing error: WRITE hosts (${misrouted}) not routed through VPN. Orders may be geo-blocked.`,
    );
  }
}

/**
 * Validate that all WRITE hosts are routed through VPN.
 * Returns false if any WRITE host is not properly routed.
 *
 * @param rpcUrl - Optional RPC URL to include
 * @param logger - Optional logger
 * @returns true if all WRITE hosts route through VPN
 */
export function validateWriteRouting(
  rpcUrl?: string,
  logger?: Logger,
): boolean {
  if (!vpnActive) {
    logger?.warn?.("VPN not active - cannot validate WRITE routing");
    return false;
  }

  const plan = generateRoutingPlan(rpcUrl, logger);

  if (!plan.allWritesRouteCorrectly) {
    const misrouted = plan.hosts
      .filter((h) => h.category === "WRITE_API" && !h.routeMatches)
      .map((h) => h.hostname);

    logger?.error?.(
      `WRITE hosts not routed through VPN: ${misrouted.join(", ")}. ` +
        `Live trading may fail due to geo-blocking.`,
    );
    return false;
  }

  return true;
}

/**
 * Add bypass routes for ALL resolved IPs of a hostname.
 * This handles hosts behind load balancers (like Cloudflare) that may have multiple IPs.
 *
 * CRITICAL: WRITE hosts are NEVER bypassed - this function will reject them.
 *
 * @param hostname - The hostname to bypass
 * @param logger - Optional logger
 * @returns Array of IPs that were routed, or empty array if failed
 */
export function addMultiIpBypassRoute(
  hostname: string,
  logger?: Logger,
): string[] {
  if (!isValidHostname(hostname)) {
    logger?.warn?.(`Invalid hostname format: ${hostname}`);
    return [];
  }

  // CRITICAL: Never bypass WRITE hosts - they must always route through VPN
  if (WRITE_HOSTS.has(hostname)) {
    const blockEvent = {
      event: "BLOCKED_BYPASS_WRITE_HOST",
      timestamp: new Date().toISOString(),
      hostname,
      reason: "WRITE hosts must route through VPN for Cloudflare protection",
    };
    console.warn(JSON.stringify(blockEvent));
    logger?.warn?.(
      `BLOCKED: Cannot bypass WRITE host ${hostname} - must route through VPN`,
    );
    return [];
  }

  const effectiveGateway = preVpnRouting?.gateway;
  const effectiveIface = preVpnRouting?.iface;

  if (!effectiveGateway || !effectiveIface) {
    logger?.warn?.(
      `Cannot add bypass for ${hostname}: no pre-VPN routing info available`,
    );
    return [];
  }

  const ips = resolveAllIpv4(hostname, logger);
  const addedIps: string[] = [];

  for (const ip of ips) {
    try {
      // Check if route already exists
      const existingRoute = execSync(`ip route show ${ip}/32 2>/dev/null`, {
        encoding: "utf8",
      }).trim();

      if (existingRoute) {
        // Route exists - skip
        addedIps.push(ip);
        continue;
      }

      // Add new route
      execSync(
        `ip route add ${ip}/32 via ${effectiveGateway} dev ${effectiveIface}`,
        { stdio: "pipe" },
      );

      addedIps.push(ip);
      logger?.debug?.(`Added bypass route: ${ip} via ${effectiveGateway}`);
    } catch {
      // Route may already exist or command failed
      logger?.warn?.(`Failed to add bypass route for ${ip}`);
    }
  }

  if (addedIps.length > 0) {
    // Track bypassed hosts for verification
    bypassedHosts.add(hostname);
    logger?.info?.(
      `Bypass route for ${hostname}: ${addedIps.length} IPs via ${effectiveGateway}`,
    );
  }

  return addedIps;
}

/**
 * Emit a structured route check event for diagnostics.
 */
export function emitRouteCheckEvent(
  host: string,
  ip: string,
  route: { interface?: string; gateway?: string },
  expected: ExpectedRoute,
  ok: boolean,
): void {
  const event = {
    step: "VPN_ROUTING",
    action: "route_check",
    host,
    ip,
    via: route.gateway,
    dev: route.interface,
    expected,
    ok,
    timestamp: new Date().toISOString(),
  };
  console.log(JSON.stringify(event));
}

/**
 * Check if the VPN_BYPASS_POLYMARKET_WS flag is enabled.
 * Default is false (conservative - route WS through VPN).
 */
export function isWsBypassEnabled(): boolean {
  return process.env.VPN_BYPASS_POLYMARKET_WS === "true";
}
