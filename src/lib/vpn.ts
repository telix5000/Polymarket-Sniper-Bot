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

// ═══════════════════════════════════════════════════════════════════════════
// VPN BYPASS DEFAULT VALUES (CRITICAL - AUTHORITATIVE)
// ═══════════════════════════════════════════════════════════════════════════
// These defaults are applied when env vars are UNSET.
// The only thing guaranteed by env vars is whether VPN is enabled.

/**
 * Default VPN bypass settings when environment variables are not explicitly set.
 *
 * IMPORTANT: These are the AUTHORITATIVE defaults per the VPN routing strategy:
 * - VPN_BYPASS_RPC = true: RPC traffic bypasses VPN for speed
 * - VPN_BYPASS_POLYMARKET_READS = false: API reads route through VPN for safety
 * - VPN_BYPASS_POLYMARKET_WS = true: WebSocket bypasses VPN for latency
 */
export const VPN_BYPASS_DEFAULTS = {
  VPN_BYPASS_RPC: true,
  VPN_BYPASS_POLYMARKET_READS: false,
  VPN_BYPASS_POLYMARKET_WS: true,
} as const;

/**
 * Get a boolean environment variable with a default value.
 *
 * This helper is critical for VPN bypass configuration where env vars
 * may not be set and we need to apply safe defaults.
 *
 * @param name - Environment variable name
 * @param defaultValue - Value to return if env var is unset or empty
 * @param logger - Optional logger for warnings about invalid values
 * @returns The resolved boolean value
 */
export function getEnvBool(
  name: string,
  defaultValue: boolean,
  logger?: Logger,
): boolean {
  const value = process.env[name];

  // If undefined or empty string, return the default
  if (value === undefined || value === "") {
    return defaultValue;
  }

  // Check for explicit true/false (case-insensitive)
  const normalized = value.toLowerCase().trim();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }

  // Invalid value - log warning and return default
  const warningMsg = `Invalid boolean value for ${name}: "${value}". Expected "true" or "false". Using default: ${defaultValue}`;
  console.warn(`⚠️ ${warningMsg}`);
  logger?.warn?.(warningMsg);

  return defaultValue;
}

// Track VPN status globally
let vpnActive = false;
let vpnType: "wireguard" | "openvpn" | "none" = "none";

// Pre-VPN routing info (captured before VPN starts)
interface PreVpnRouting {
  gateway: string;
  iface: string;
}

let preVpnRouting: PreVpnRouting | null = null;

// ═══════════════════════════════════════════════════════════════════════════
// VPN ROUTING POLICY EVENTS (Diagnostic Improvement - Part A)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Write route check result for a single host
 */
export interface WriteRouteCheckResult {
  hostname: string;
  resolvedIp: string | null;
  outgoingInterface: string | null;
  outgoingGateway: string | null;
  routeThroughVpn: boolean;
  mismatch: boolean; // true if vpnActive=true but not routed through VPN
}

/**
 * VPN Routing Policy PRE event structure
 * Emitted BEFORE VPN starts
 */
export interface VpnRoutingPolicyPreEvent {
  event: "VPN_ROUTING_POLICY_PRE";
  timestamp: string;
  preVpnRouting: {
    gateway: string | null;
    iface: string | null;
  };
  vpnConfigured: {
    wireguard: boolean;
    openvpn: boolean;
  };
}

/**
 * Source of a bypass setting value
 */
export type BypassSettingSource = "DEFAULT" | "ENV";

/**
 * Bypass setting with source tracking
 */
export interface BypassSetting {
  value: boolean;
  source: BypassSettingSource;
}

/**
 * VPN Routing Policy EFFECTIVE event structure
 * Emitted AFTER VPN is up AND bypass routes are applied
 */
export interface VpnRoutingPolicyEffectiveEvent {
  event: "VPN_ROUTING_POLICY_EFFECTIVE";
  timestamp: string;
  vpnActive: boolean;
  vpnType: "wireguard" | "openvpn" | "none";
  preVpnRouting: {
    gateway: string | null;
    iface: string | null;
  };
  /**
   * The defaults that were applied when env vars were unset.
   * Shows what values are being used by default (not from env).
   */
  defaultsApplied: {
    VPN_BYPASS_RPC: boolean;
    VPN_BYPASS_POLYMARKET_READS: boolean;
    VPN_BYPASS_POLYMARKET_WS: boolean;
  };
  /**
   * Explicit env var overrides that were set.
   * Only includes vars that were explicitly set (not defaults).
   */
  envOverrides: Record<string, string>;
  /**
   * Effective settings with source tracking (DEFAULT vs ENV).
   * Shows the actual value used AND where it came from.
   */
  effectiveSettings: {
    VPN_BYPASS_RPC: BypassSetting;
    VPN_BYPASS_POLYMARKET_READS: BypassSetting;
    VPN_BYPASS_POLYMARKET_WS: BypassSetting;
  };
  bypassedHosts: string[];
  writeHosts: string[];
  writeRouteCheck: WriteRouteCheckResult[];
}

/**
 * Emit VPN_ROUTING_POLICY_PRE event BEFORE starting VPN.
 * This captures the pre-VPN routing state for diagnostics.
 */
export function emitRoutingPolicyPreEvent(
  logger?: Logger,
): VpnRoutingPolicyPreEvent {
  const wgConfigured =
    process.env.WIREGUARD_ENABLED === "true" ||
    !!process.env.WG_CONFIG ||
    !!process.env.WIREGUARD_CONFIG;
  const ovpnConfigured =
    process.env.OPENVPN_ENABLED === "true" ||
    !!process.env.OVPN_CONFIG ||
    !!process.env.OPENVPN_CONFIG;

  const event: VpnRoutingPolicyPreEvent = {
    event: "VPN_ROUTING_POLICY_PRE",
    timestamp: new Date().toISOString(),
    preVpnRouting: {
      gateway: preVpnRouting?.gateway ?? null,
      iface: preVpnRouting?.iface ?? null,
    },
    vpnConfigured: {
      wireguard: wgConfigured,
      openvpn: ovpnConfigured,
    },
  };

  console.log(JSON.stringify(event));
  logger?.info?.(
    `VPN_ROUTING_POLICY_PRE: preVpnGateway=${event.preVpnRouting.gateway}, preVpnIface=${event.preVpnRouting.iface}`,
  );

  return event;
}

/**
 * Verify write path routing for a specific hostname.
 * Uses `ip route get` to check actual routing.
 */
export function checkWriteHostRoute(
  hostname: string,
  logger?: Logger,
): WriteRouteCheckResult {
  const result: WriteRouteCheckResult = {
    hostname,
    resolvedIp: null,
    outgoingInterface: null,
    outgoingGateway: null,
    routeThroughVpn: false,
    mismatch: false,
  };

  // Validate hostname
  if (!isValidHostname(hostname)) {
    logger?.warn?.(`Invalid hostname for route check: ${hostname}`);
    return result;
  }

  try {
    // Resolve hostname to IP using getent ahostsv4
    const ip = execSync(
      `getent ahostsv4 ${hostname} | awk 'NR==1 {print $1; exit}'`,
      { encoding: "utf8" },
    ).trim();

    if (!ip || !isValidIp(ip)) {
      logger?.warn?.(`Cannot resolve IP for ${hostname}: got "${ip}"`);
      return result;
    }

    result.resolvedIp = ip;

    // Get the actual route using `ip route get`
    const routeOutput = execSync(`ip route get ${ip} 2>/dev/null`, {
      encoding: "utf8",
    }).trim();

    // Parse output: "1.2.3.4 via 10.0.0.1 dev eth0 src 192.168.1.2"
    const viaMatch = routeOutput.match(/via\s+(\d+\.\d+\.\d+\.\d+)/);
    const devMatch = routeOutput.match(/dev\s+(\S+)/);

    result.outgoingGateway = viaMatch?.[1] ?? null;
    result.outgoingInterface = devMatch?.[1] ?? null;

    // Determine if route goes through VPN
    // If the route uses the pre-VPN gateway/interface, it's bypassing VPN
    if (preVpnRouting?.gateway && preVpnRouting?.iface) {
      const usesBypass =
        result.outgoingGateway === preVpnRouting.gateway ||
        result.outgoingInterface === preVpnRouting.iface;
      result.routeThroughVpn = !usesBypass;
    } else {
      // Can't determine - assume VPN if we have a different interface
      result.routeThroughVpn = !!result.outgoingInterface;
    }

    // Check for mismatch: VPN is active but write host is not routed through VPN
    if (vpnActive && !result.routeThroughVpn) {
      result.mismatch = true;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.warn?.(`Failed to check route for ${hostname}: ${msg}`);
  }

  return result;
}

/**
 * Result of attempting to auto-fix a write route mismatch
 */
interface WriteRouteAutoFixResult {
  attempted: boolean;
  success: boolean;
  error?: string;
}

/**
 * Attempt to automatically fix a write route mismatch by adding a specific
 * route for the write host IP through the VPN interface.
 *
 * This is a defensive measure to ensure writes go through VPN even if the
 * default route isn't correctly set.
 *
 * @param check - The write route check result with mismatch=true
 * @param logger - Optional logger
 * @returns Result indicating whether fix was attempted and succeeded
 */
function attemptWriteRouteAutoFix(
  check: WriteRouteCheckResult,
  logger?: Logger,
): WriteRouteAutoFixResult {
  // Can't fix if we don't have the IP or VPN isn't active
  if (!check.resolvedIp || !vpnActive) {
    return {
      attempted: false,
      success: false,
      error: "Missing IP or VPN not active",
    };
  }

  // Validate IP to prevent injection
  if (!isValidIp(check.resolvedIp)) {
    return { attempted: false, success: false, error: "Invalid IP format" };
  }

  // Determine VPN interface name
  const vpnIface = getVpnInterfaceName();
  if (!vpnIface) {
    return {
      attempted: false,
      success: false,
      error: "Cannot determine VPN interface name",
    };
  }

  // Validate interface name
  if (!isValidIface(vpnIface)) {
    return {
      attempted: false,
      success: false,
      error: "Invalid VPN interface name",
    };
  }

  try {
    // Add a specific route for this IP through the VPN interface
    // Using `ip route replace` to handle case where route already exists
    const cmd = `ip route replace ${check.resolvedIp}/32 dev ${vpnIface}`;
    execSync(cmd, { stdio: "pipe" });

    const fixEvent = {
      event: "WRITE_ROUTE_AUTO_FIX_OK",
      timestamp: new Date().toISOString(),
      hostname: check.hostname,
      ip: check.resolvedIp,
      vpnInterface: vpnIface,
      command: cmd,
    };
    console.log(JSON.stringify(fixEvent));
    logger?.info?.(
      `WRITE_ROUTE_AUTO_FIX: Added route for ${check.hostname} (${check.resolvedIp}) via ${vpnIface}`,
    );

    return { attempted: true, success: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);

    const failEvent = {
      event: "WRITE_ROUTE_AUTO_FIX_FAILED",
      timestamp: new Date().toISOString(),
      hostname: check.hostname,
      ip: check.resolvedIp,
      vpnInterface: vpnIface,
      error: errMsg,
    };
    console.error(JSON.stringify(failEvent));
    logger?.error?.(
      `WRITE_ROUTE_AUTO_FIX_FAILED: Could not add route for ${check.hostname}: ${errMsg}`,
    );

    return { attempted: true, success: false, error: errMsg };
  }
}

/**
 * Get the VPN interface name based on vpnType and configuration.
 * Returns null if VPN is not active or interface cannot be determined.
 */
function getVpnInterfaceName(): string | null {
  if (!vpnActive) {
    return null;
  }

  if (vpnType === "wireguard") {
    // WireGuard interface name from env or default
    return process.env.WIREGUARD_INTERFACE_NAME ?? "wg0";
  }

  if (vpnType === "openvpn") {
    // OpenVPN typically uses tun0 by default
    // Try to find the tun interface by listing all interfaces and filtering
    try {
      // Use ip link show without shell pipe - safer approach
      const output = execSync("ip link show", {
        encoding: "utf8",
      }).trim();
      // Parse output to find tun interfaces (lines like "123: tun0: <...")
      const tunMatch = output.match(/\d+:\s+(tun\d+):/);
      if (tunMatch && tunMatch[1]) {
        const tunIface = tunMatch[1];
        // Validate the interface name to prevent injection
        if (isValidIface(tunIface)) {
          return tunIface;
        }
      }
    } catch {
      // Fall back to tun0
    }
    return "tun0";
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// PROACTIVE WRITE HOST VPN ROUTING (CRITICAL FIX FOR WRITE_ROUTE_MISMATCH)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Result of ensuring a single write host is routed through VPN
 */
export interface WriteHostRouteResult {
  hostname: string;
  ips: string[];
  routesAdded: number;
  routesFailed: number;
  success: boolean;
  error?: string;
}

/**
 * Result of ensuring all write hosts are routed through VPN
 */
export interface EnsureWriteRoutesResult {
  attempted: boolean;
  success: boolean;
  results: WriteHostRouteResult[];
  vpnInterface: string | null;
}

/**
 * Proactively ensure all WRITE hosts route through VPN interface.
 *
 * This function MUST be called AFTER VPN is started to guarantee that
 * clob.polymarket.com (and any other WRITE hosts) route through the
 * VPN interface, not through the pre-VPN gateway.
 *
 * The problem: When VPN starts with AllowedIPs=0.0.0.0/0, it should route
 * all traffic through VPN. However, DNS caching or stale routes can cause
 * specific hosts to continue using the pre-VPN gateway.
 *
 * The solution: Explicitly add routes for all resolved IPs of WRITE hosts
 * through the VPN interface after VPN starts.
 *
 * @param logger - Optional logger for diagnostics
 * @returns Result indicating success/failure and details per host
 */
export function ensureWriteHostVpnRoutes(
  logger?: Logger,
): EnsureWriteRoutesResult {
  // Can't ensure routes if VPN isn't active
  if (!vpnActive) {
    logger?.info?.("ensureWriteHostVpnRoutes: VPN not active, skipping");
    return {
      attempted: false,
      success: true, // Not a failure - just nothing to do
      results: [],
      vpnInterface: null,
    };
  }

  const vpnIface = getVpnInterfaceName();
  if (!vpnIface) {
    logger?.error?.("ensureWriteHostVpnRoutes: Cannot determine VPN interface");
    return {
      attempted: true,
      success: false,
      results: [],
      vpnInterface: null,
    };
  }

  if (!isValidIface(vpnIface)) {
    logger?.error?.(
      `ensureWriteHostVpnRoutes: Invalid VPN interface name: ${vpnIface}`,
    );
    return {
      attempted: true,
      success: false,
      results: [],
      vpnInterface: vpnIface,
    };
  }

  const results: WriteHostRouteResult[] = [];
  let allSuccess = true;

  // Process each WRITE host
  for (const hostname of WRITE_HOSTS) {
    const hostResult = addVpnRoutesForHost(hostname, vpnIface, logger);
    results.push(hostResult);
    if (!hostResult.success) {
      allSuccess = false;
    }
  }

  // Emit structured event
  const eventPayload = {
    event: "WRITE_HOST_VPN_ROUTES_ENSURED",
    timestamp: new Date().toISOString(),
    vpnActive,
    vpnType,
    vpnInterface: vpnIface,
    success: allSuccess,
    results: results.map((r) => ({
      hostname: r.hostname,
      ips: r.ips,
      routesAdded: r.routesAdded,
      routesFailed: r.routesFailed,
      success: r.success,
    })),
  };
  console.log(JSON.stringify(eventPayload));

  if (allSuccess) {
    logger?.info?.(
      `ensureWriteHostVpnRoutes: All ${results.length} WRITE hosts route through ${vpnIface}`,
    );
  } else {
    const failedHosts = results.filter((r) => !r.success).map((r) => r.hostname);
    logger?.error?.(
      `ensureWriteHostVpnRoutes: Failed to route hosts through VPN: ${failedHosts.join(", ")}`,
    );
  }

  return {
    attempted: true,
    success: allSuccess,
    results,
    vpnInterface: vpnIface,
  };
}

/**
 * Add VPN routes for all resolved IPs of a single hostname.
 *
 * @param hostname - The hostname to route through VPN
 * @param vpnIface - The VPN interface name (e.g., wg0, tun0)
 * @param logger - Optional logger
 * @returns Result indicating success and IPs routed
 */
function addVpnRoutesForHost(
  hostname: string,
  vpnIface: string,
  logger?: Logger,
): WriteHostRouteResult {
  // Validate hostname
  if (!isValidHostname(hostname)) {
    logger?.warn?.(`addVpnRoutesForHost: Invalid hostname: ${hostname}`);
    return {
      hostname,
      ips: [],
      routesAdded: 0,
      routesFailed: 0,
      success: false,
      error: "Invalid hostname format",
    };
  }

  // Resolve all IPs for the hostname
  const ips = resolveAllIpv4ForWriteHost(hostname, logger);
  if (ips.length === 0) {
    logger?.warn?.(
      `addVpnRoutesForHost: No IPs resolved for ${hostname}`,
    );
    return {
      hostname,
      ips: [],
      routesAdded: 0,
      routesFailed: 0,
      success: false,
      error: "No IPs resolved",
    };
  }

  let routesAdded = 0;
  let routesFailed = 0;

  for (const ip of ips) {
    // Validate IP
    if (!isValidIp(ip)) {
      logger?.warn?.(
        `addVpnRoutesForHost: Invalid IP ${ip} for ${hostname}, skipping`,
      );
      routesFailed++;
      continue;
    }

    try {
      // Use `ip route replace` to add or update the route
      // This ensures the route goes through the VPN interface
      const cmd = `ip route replace ${ip}/32 dev ${vpnIface}`;
      execSync(cmd, { stdio: "pipe" });
      routesAdded++;
      logger?.debug?.(
        `addVpnRoutesForHost: Added route ${ip} -> ${vpnIface} for ${hostname}`,
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger?.warn?.(
        `addVpnRoutesForHost: Failed to add route for ${ip}: ${errMsg}`,
      );
      routesFailed++;
    }
  }

  const success = routesAdded > 0 && routesFailed === 0;

  return {
    hostname,
    ips,
    routesAdded,
    routesFailed,
    success,
    error: routesFailed > 0 ? `${routesFailed} routes failed` : undefined,
  };
}

/**
 * Resolve all IPv4 addresses for a WRITE host.
 * Uses getent ahostsv4 to get all resolved IPs for hosts behind load balancers.
 */
function resolveAllIpv4ForWriteHost(
  hostname: string,
  logger?: Logger,
): string[] {
  if (!isValidHostname(hostname)) {
    return [];
  }

  try {
    // Get all IPv4 addresses using getent ahostsv4
    const output = execSync(
      `getent ahostsv4 ${hostname} 2>/dev/null | awk '{print $1}' | sort -u`,
      { encoding: "utf8" },
    ).trim();

    if (!output) return [];

    const ips = output.split("\n").filter((ip) => ip && isValidIp(ip));
    logger?.debug?.(
      `resolveAllIpv4ForWriteHost: ${hostname} -> ${ips.join(", ")}`,
    );
    return ips;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger?.warn?.(
      `resolveAllIpv4ForWriteHost: Failed to resolve ${hostname}: ${errMsg}`,
    );
    return [];
  }
}

/**
 * Emit VPN_ROUTING_POLICY_EFFECTIVE event AFTER VPN is up and bypass routes are applied.
 * This is the FINAL effective routing state.
 */
export function emitRoutingPolicyEffectiveEvent(
  logger?: Logger,
): VpnRoutingPolicyEffectiveEvent {
  // Check routes for all write hosts
  const writeRouteChecks: WriteRouteCheckResult[] = [];
  for (const hostname of WRITE_HOSTS) {
    const check = checkWriteHostRoute(hostname, logger);
    writeRouteChecks.push(check);

    // Emit warning and WRITE_ROUTE_MISMATCH event if misrouted
    if (check.mismatch) {
      // Attempt auto-fix for write route mismatch
      const fixResult = attemptWriteRouteAutoFix(check, logger);

      const mismatchEvent = {
        event: "WRITE_ROUTE_MISMATCH",
        timestamp: new Date().toISOString(),
        hostname: check.hostname,
        resolvedIp: check.resolvedIp,
        outgoingInterface: check.outgoingInterface,
        outgoingGateway: check.outgoingGateway,
        vpnActive,
        preVpnGateway: preVpnRouting?.gateway ?? null,
        preVpnIface: preVpnRouting?.iface ?? null,
        autoFixAttempted: fixResult.attempted,
        autoFixSuccess: fixResult.success,
        message: `WRITE host ${hostname} is NOT routed through VPN but vpnActive=true`,
      };
      console.warn(JSON.stringify(mismatchEvent));
      logger?.warn?.(
        `WRITE_ROUTE_MISMATCH: ${hostname} (${check.resolvedIp}) routes via ${check.outgoingInterface}/${check.outgoingGateway} but VPN is active`,
      );

      if (fixResult.attempted) {
        if (fixResult.success) {
          logger?.info?.(
            `WRITE_ROUTE_AUTO_FIX_OK: Successfully added route for ${hostname} via VPN`,
          );
          // Re-check the route after fix
          const recheckResult = checkWriteHostRoute(hostname, logger);
          check.mismatch = recheckResult.mismatch;
          check.outgoingInterface = recheckResult.outgoingInterface;
          check.outgoingGateway = recheckResult.outgoingGateway;
          check.routeThroughVpn = recheckResult.routeThroughVpn;
          check.resolvedIp = recheckResult.resolvedIp;
        } else {
          logger?.error?.(
            `WRITE_ROUTE_AUTO_FIX_FAILED: Could not fix route for ${hostname}. ${fixResult.error}`,
          );
        }
      }

      if (process.env.GITHUB_ACTIONS === "true") {
        console.log(
          `::warning::WRITE_ROUTE_MISMATCH: ${hostname} not routed through VPN despite vpnActive=true`,
        );
      }
    }
  }

  // Determine which env vars are explicitly set vs using defaults
  const envOverrides: Record<string, string> = {};
  if (process.env.VPN_BYPASS_RPC !== undefined) {
    envOverrides.VPN_BYPASS_RPC = process.env.VPN_BYPASS_RPC;
  }
  if (process.env.VPN_BYPASS_POLYMARKET_READS !== undefined) {
    envOverrides.VPN_BYPASS_POLYMARKET_READS =
      process.env.VPN_BYPASS_POLYMARKET_READS;
  }
  if (process.env.VPN_BYPASS_POLYMARKET_WS !== undefined) {
    envOverrides.VPN_BYPASS_POLYMARKET_WS =
      process.env.VPN_BYPASS_POLYMARKET_WS;
  }

  // Build effective settings with source tracking
  const effectiveSettings: VpnRoutingPolicyEffectiveEvent["effectiveSettings"] =
    {
      VPN_BYPASS_RPC: {
        value: getEnvBool(
          "VPN_BYPASS_RPC",
          VPN_BYPASS_DEFAULTS.VPN_BYPASS_RPC,
          logger,
        ),
        source:
          process.env.VPN_BYPASS_RPC !== undefined ? "ENV" : "DEFAULT",
      },
      VPN_BYPASS_POLYMARKET_READS: {
        value: getEnvBool(
          "VPN_BYPASS_POLYMARKET_READS",
          VPN_BYPASS_DEFAULTS.VPN_BYPASS_POLYMARKET_READS,
          logger,
        ),
        source:
          process.env.VPN_BYPASS_POLYMARKET_READS !== undefined
            ? "ENV"
            : "DEFAULT",
      },
      VPN_BYPASS_POLYMARKET_WS: {
        value: getEnvBool(
          "VPN_BYPASS_POLYMARKET_WS",
          VPN_BYPASS_DEFAULTS.VPN_BYPASS_POLYMARKET_WS,
          logger,
        ),
        source:
          process.env.VPN_BYPASS_POLYMARKET_WS !== undefined
            ? "ENV"
            : "DEFAULT",
      },
    };

  const event: VpnRoutingPolicyEffectiveEvent = {
    event: "VPN_ROUTING_POLICY_EFFECTIVE",
    timestamp: new Date().toISOString(),
    vpnActive,
    vpnType,
    preVpnRouting: {
      gateway: preVpnRouting?.gateway ?? null,
      iface: preVpnRouting?.iface ?? null,
    },
    defaultsApplied: {
      VPN_BYPASS_RPC: VPN_BYPASS_DEFAULTS.VPN_BYPASS_RPC,
      VPN_BYPASS_POLYMARKET_READS:
        VPN_BYPASS_DEFAULTS.VPN_BYPASS_POLYMARKET_READS,
      VPN_BYPASS_POLYMARKET_WS: VPN_BYPASS_DEFAULTS.VPN_BYPASS_POLYMARKET_WS,
    },
    envOverrides,
    effectiveSettings,
    bypassedHosts: getBypassedHosts(),
    writeHosts: [...WRITE_HOSTS],
    writeRouteCheck: writeRouteChecks,
  };

  // Log effective settings with source for clarity
  console.log("");
  console.log("═".repeat(60));
  console.log("  📡 VPN BYPASS SETTINGS (EFFECTIVE)");
  console.log("═".repeat(60));
  console.log(
    `  VPN_BYPASS_RPC: ${effectiveSettings.VPN_BYPASS_RPC.value} [${effectiveSettings.VPN_BYPASS_RPC.source}]`,
  );
  console.log(
    `  VPN_BYPASS_POLYMARKET_READS: ${effectiveSettings.VPN_BYPASS_POLYMARKET_READS.value} [${effectiveSettings.VPN_BYPASS_POLYMARKET_READS.source}]`,
  );
  console.log(
    `  VPN_BYPASS_POLYMARKET_WS: ${effectiveSettings.VPN_BYPASS_POLYMARKET_WS.value} [${effectiveSettings.VPN_BYPASS_POLYMARKET_WS.source}]`,
  );
  console.log("═".repeat(60));
  console.log("");

  console.log(JSON.stringify(event));
  logger?.info?.(
    `VPN_ROUTING_POLICY_EFFECTIVE: vpnActive=${vpnActive}, vpnType=${vpnType}, ` +
      `bypassed=${event.bypassedHosts.length}, writeRouteOK=${writeRouteChecks.every((c) => !c.mismatch)}`,
  );

  return event;
}

/**
 * Get the current pre-VPN routing info (for external access)
 */
export function getPreVpnRouting(): PreVpnRouting | null {
  return preVpnRouting;
}

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
 * Default: true (bypass enabled). Set VPN_BYPASS_RPC=false to route RPC through VPN.
 */
export async function setupRpcBypass(
  rpcUrl: string,
  logger?: Logger,
): Promise<void> {
  const bypassRpc = getEnvBool(
    "VPN_BYPASS_RPC",
    VPN_BYPASS_DEFAULTS.VPN_BYPASS_RPC,
    logger,
  );

  if (!bypassRpc) {
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
 * Default: false (bypass disabled for safety).
 * Set VPN_BYPASS_POLYMARKET_READS=true to enable bypass.
 */
export async function setupPolymarketReadBypass(
  logger?: Logger,
): Promise<void> {
  const bypassReads = getEnvBool(
    "VPN_BYPASS_POLYMARKET_READS",
    VPN_BYPASS_DEFAULTS.VPN_BYPASS_POLYMARKET_READS,
    logger,
  );

  if (!bypassReads) {
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
 * Default: true (bypass enabled for latency).
 * Set VPN_BYPASS_POLYMARKET_WS=false to route WebSocket through VPN.
 *
 * NOTE: This bypasses the Market channel (public data). The User channel
 * uses the same host but requires authentication - still works with bypass
 * since auth is at the application layer, not IP-based.
 */
export async function setupWebSocketBypass(logger?: Logger): Promise<void> {
  const bypassWs = getEnvBool(
    "VPN_BYPASS_POLYMARKET_WS",
    VPN_BYPASS_DEFAULTS.VPN_BYPASS_POLYMARKET_WS,
    logger,
  );

  if (!bypassWs) {
    logger?.info?.("WebSocket VPN bypass disabled - WS routes through VPN");
    return;
  }

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
  // Determine which env vars are explicitly set vs using defaults
  const envOverrides: Record<string, string> = {};
  if (process.env.VPN_BYPASS_RPC !== undefined) {
    envOverrides.VPN_BYPASS_RPC = process.env.VPN_BYPASS_RPC;
  }
  if (process.env.VPN_BYPASS_POLYMARKET_READS !== undefined) {
    envOverrides.VPN_BYPASS_POLYMARKET_READS =
      process.env.VPN_BYPASS_POLYMARKET_READS;
  }
  if (process.env.VPN_BYPASS_POLYMARKET_WS !== undefined) {
    envOverrides.VPN_BYPASS_POLYMARKET_WS =
      process.env.VPN_BYPASS_POLYMARKET_WS;
  }

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
    defaultsApplied: {
      VPN_BYPASS_RPC: VPN_BYPASS_DEFAULTS.VPN_BYPASS_RPC,
      VPN_BYPASS_POLYMARKET_READS:
        VPN_BYPASS_DEFAULTS.VPN_BYPASS_POLYMARKET_READS,
      VPN_BYPASS_POLYMARKET_WS: VPN_BYPASS_DEFAULTS.VPN_BYPASS_POLYMARKET_WS,
    },
    envOverrides,
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

// Emit routing policy diagnostics once when the VPN module is loaded.
// This ensures VPN_ROUTING_POLICY (and any VPN_MISROUTED_WRITE_HOST) events
// are emitted at startup for administrators and automated checks.
emitRoutingPolicyLog();
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

  // Get effective bypass settings using getEnvBool
  const bypassRpc = getEnvBool(
    "VPN_BYPASS_RPC",
    VPN_BYPASS_DEFAULTS.VPN_BYPASS_RPC,
    logger,
  );
  const bypassReads = getEnvBool(
    "VPN_BYPASS_POLYMARKET_READS",
    VPN_BYPASS_DEFAULTS.VPN_BYPASS_POLYMARKET_READS,
    logger,
  );
  const bypassWs = getEnvBool(
    "VPN_BYPASS_POLYMARKET_WS",
    VPN_BYPASS_DEFAULTS.VPN_BYPASS_POLYMARKET_WS,
    logger,
  );

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
          expectedRoute: bypassRpc ? "BYPASS" : "VPN",
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
    if (hostConfig.category === "WEBSOCKET") {
      expectedRoute = bypassWs ? "BYPASS" : "VPN";
    }

    // READ API bypass is configurable (default: VPN for conservative approach)
    // Set VPN_BYPASS_POLYMARKET_READS=true to bypass VPN for READ APIs
    // NOTE: This is intentionally more conservative than WebSocket/RPC defaults
    if (hostConfig.category === "READ_API") {
      expectedRoute = bypassReads ? "BYPASS" : "VPN";
    }

    // RPC bypass is configurable (default: BYPASS for speed)
    // Set VPN_BYPASS_RPC=false to route RPC through VPN
    if (hostConfig.category === "RPC") {
      expectedRoute = bypassRpc ? "BYPASS" : "VPN";
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
