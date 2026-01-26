# Cloudflare 403 Diagnostic Guide

## Root-Cause Hypothesis (Ranked by Likelihood)

### 1. **VPN Not Active or CLOB Traffic Bypassing VPN** ⭐⭐⭐⭐⭐ (Most Likely)
**Probability:** 85%

**Description:** The CLOB endpoint (`clob.polymarket.com`) is **intentionally excluded** from Polymarket read bypass routing (see `src/lib/vpn.ts:656-661`). However, if:
- VPN is not running/connected
- VPN routing rules are misconfigured
- Network changed and VPN didn't reconnect
- Docker container networking bypasses host VPN

Then order submissions reach Cloudflare from your actual IP, which may be geo-blocked.

**Evidence:**
- `src/lib/vpn.ts:624`: "clob.polymarket.com is NOT bypassed because it handles both read operations AND write operations (orders, auth)"
- `src/lib/vpn.ts:661`: "clob.polymarket.com - EXCLUDED: handles orders which need VPN protection"

**Manual Checks:**
```bash
# 1. Verify VPN is active and connected
ip route show | grep tun0  # Should show tun0/vpn interface

# 2. Check if clob.polymarket.com routes through VPN
traceroute clob.polymarket.com  # Should go through VPN gateway

# 3. Check public IP seen by Cloudflare
curl https://clob.polymarket.com  # Note the IP in error response

# 4. Compare with your actual VPN exit IP
curl https://api.ipify.org  # Should match VPN exit node

# 5. For Docker: verify container uses host network or VPN
docker inspect <container_id> | grep NetworkMode  # Should be "host" or VPN-aware
```

---

### 2. **IP Reputation / Rate Limiting** ⭐⭐⭐⭐ (Likely)
**Probability:** 60%

**Description:** Your VPN exit node IP may have a poor reputation with Cloudflare due to:
- Many users sharing the same VPN exit node
- Recent abuse from that IP range
- Cloudflare identifying it as a datacenter/proxy IP
- Rate limiting threshold exceeded

**Evidence:**
- Cloudflare blocks are IP-based, not credential-based
- 403 (not 401) indicates authorization issue at network level
- Ray ID will show Cloudflare PoP location and block reason

**Manual Checks:**
```bash
# 1. Check if your VPN IP is flagged
curl -I https://clob.polymarket.com  # Look for cf-cache-status header

# 2. Try different VPN exit node/location
# - Change VPN server to different region
# - Re-test order submission

# 3. Check Cloudflare Ray ID location
# The Ray ID suffix (e.g., 8e4f3c2b1a9d6e7f-SJC) indicates the PoP
# SJC = San Jose, LAX = Los Angeles, etc.

# 4. Test with curl to isolate from bot code
curl -v -X POST https://clob.polymarket.com/order \
  -H "POLY-ADDRESS: YOUR_ADDRESS" \
  -H "POLY-SIGNATURE: YOUR_SIG" \
  # ... (see error-handling.ts for header format)
```

---

### 3. **Signature Type Mismatch (401/403 Crossover)** ⭐⭐⭐ (Possible)
**Probability:** 30%

**Description:** Per `docs/TRADE_EXECUTION_DIAGNOSTIC.md:110`, there's a known issue where signatureType mismatch between credential derivation and runtime can cause 401/403 errors:

> "If API credentials (POLYMARKET_API_KEY, etc.) were generated with signatureType=0 but you're now using signatureType=1, orders will fail with 401/403 errors."

While 403 is more commonly Cloudflare, some CLOB authentication failures can return 403.

**Evidence:**
- `docs/TRADE_EXECUTION_DIAGNOSTIC.md:110-111`: "Proxy mode with credentials derived in EOA mode"
- `src/lib/auth.ts:94-97`: Warning logged when signatureType/proxy mismatch

**Manual Checks:**
```bash
# 1. Check current signature type configuration
echo "POLYMARKET_SIGNATURE_TYPE: ${POLYMARKET_SIGNATURE_TYPE:-0 (default)}"
echo "POLYMARKET_PROXY_ADDRESS: ${POLYMARKET_PROXY_ADDRESS:-not set}"

# 2. Verify credentials were derived with same signatureType
# Look for this warning in logs:
grep "signatureType=.* but no POLYMARKET_PROXY_ADDRESS" logs/bot.log

# 3. If using proxy mode (signatureType=1 or 2), ensure:
# - POLYMARKET_PROXY_ADDRESS is set
# - Signer wallet is authorized to trade for proxy address
# - Credentials were derived WITH the proxy address

# 4. Test authentication separately
npm run auth:probe  # Should show auth diagnostics

# 5. If unsure, re-derive credentials in correct mode:
# - Set POLYMARKET_SIGNATURE_TYPE and POLYMARKET_PROXY_ADDRESS first
# - Delete old credentials (if using env vars)
# - Restart bot to derive fresh credentials
```

---

### 4. **User-Agent or Request Fingerprinting** ⭐⭐ (Less Likely)
**Probability:** 15%

**Description:** Cloudflare may fingerprint requests based on:
- User-Agent header (bot detection)
- TLS fingerprint (OpenSSL version, cipher order)
- HTTP/2 fingerprint (frame order, priority)
- Missing browser-like headers (Accept, Accept-Language, etc.)

**Evidence:**
- Modern Cloudflare bot detection uses advanced fingerprinting
- @polymarket/clob-client uses axios, which has a predictable signature

**Manual Checks:**
```bash
# 1. Check User-Agent sent by client
# (Requires code inspection or network capture)
tcpdump -i any -A 'host clob.polymarket.com' | grep User-Agent

# 2. Test with browser-like User-Agent
curl -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" \
  https://clob.polymarket.com

# 3. Compare TLS fingerprint
# (Requires specialized tools like ja3 or tls-client-fingerprinting)
```

**Note:** This is harder to fix without modifying @polymarket/clob-client internals. Consider asking Polymarket support if specific headers are required.

---

### 5. **Geographic Restrictions** ⭐ (Unlikely if VPN works elsewhere)
**Probability:** 10%

**Description:** Polymarket/Cloudflare blocks traffic from certain countries. However, if VPN usually works, this is unlikely.

**Evidence:**
- Known issue: US users must use VPN
- Some countries are completely blocked regardless of VPN

**Manual Checks:**
```bash
# 1. Check VPN exit location
curl https://ipapi.co/json  # Should show VPN country

# 2. Verify Polymarket allows trading from that location
# (Check Polymarket terms/support docs)

# 3. Try different VPN country if blocked
# - Recommended: European servers (UK, NL, DE)
# - Avoid: US, China, North Korea, Iran (known blocks)
```

---

## Concrete Code Changes Already Implemented

### File: `src/lib/error-handling.ts`

**Added Functions:**
1. **`extractCloudflareRayId(error: unknown): string | null`** (lines 308-341)
   - Extracts Ray ID from HTML, JSON, or text
   - Handles multiple formats: `<strong>abc123</strong>`, `"ray_id":"abc123"`, `Ray ID: abc123`
   - Returns null if not found

2. **`extractStatusCode(error: unknown): number | "unknown"`** (lines 343-367)
   - Extracts HTTP status from error response
   - Checks: response.status, statusCode, status, code
   - Returns "unknown" if not found

3. **`extractCloudflareHeaders(error: unknown): {cfRay?, cfCacheStatus?}`** (lines 369-400)
   - Extracts cf-ray and cf-cache-status headers
   - Checks response.headers, headers, config.headers
   - Returns empty object if not found

### File: `src/lib/order.ts`

**Enhanced Logging at 3 Locations:**

1. **Response failure handler** (lines 234-254)
   ```typescript
   // When postOrder() response indicates failure
   if (isCloudflareBlock(errorMsg) || isCloudflareBlock(response)) {
     const rayId = extractCloudflareRayId(response) ?? extractCloudflareRayId(errorMsg);
     const status = extractStatusCode(response);
     const { cfRay, cfCacheStatus } = extractCloudflareHeaders(response);
     const bodyLength = /* estimate */;
     
     logger?.error?.(
       `CLOB Order blocked by Cloudflare (403)${rayId ? ` - Ray ID: ${rayId}` : ""}` +
       `${cfRay ? ` (cf-ray: ${cfRay})` : ""} | Status: ${status}` +
       `${bodyLength ? ` | Body length: ${bodyLength}B` : ""}` +
       `${cfCacheStatus ? ` | CF-Cache: ${cfCacheStatus}` : ""} | ` +
       `Check VPN routing and geo-restrictions`
     );
   }
   ```

2. **Execution exception handler** (lines 256-283)
   - Same enhanced logging for caught exceptions

3. **Outer catch block** (lines 308-322)
   - Top-level error handler with same diagnostics

---

## Quick Manual Checks (Before Changing Code)

### 1. **Verify VPN Routing**
```bash
# Check VPN is active
ip route | grep tun
nmcli connection show --active | grep vpn  # For NetworkManager
systemctl status openvpn@*  # For OpenVPN

# Verify clob.polymarket.com routes through VPN
ip route get $(dig +short clob.polymarket.com | head -1)

# Should show VPN interface (tun0, wg0, etc.)
```

### 2. **Check Environment Variables**
```bash
# Signature type and proxy address
echo "POLYMARKET_SIGNATURE_TYPE=${POLYMARKET_SIGNATURE_TYPE}"
echo "POLYMARKET_PROXY_ADDRESS=${POLYMARKET_PROXY_ADDRESS}"

# Credentials (should NOT print actual values, just check if set)
[ -n "$POLYMARKET_API_KEY" ] && echo "API_KEY: SET" || echo "API_KEY: NOT SET"
[ -n "$POLYMARKET_PASSPHRASE" ] && echo "PASSPHRASE: SET" || echo "PASSPHRASE: NOT SET"
[ -n "$POLYMARKET_SECRET" ] && echo "SECRET: SET" || echo "SECRET: NOT SET"
```

### 3. **Test CLOB Endpoint Directly**
```bash
# Simple connectivity test
curl -v https://clob.polymarket.com 2>&1 | grep -E "(HTTP|cf-|Ray ID)"

# Should NOT return Cloudflare block page
# If blocked, you'll see "403 Forbidden" and Ray ID in HTML
```

### 4. **Check Bot Logs for Warnings**
```bash
# Look for signature type warnings
grep "signatureType=" logs/bot.log | grep "but no POLYMARKET_PROXY_ADDRESS"

# Look for existing Cloudflare blocks (with new logging)
grep "Cloudflare" logs/bot.log | grep "Ray ID"

# Check authentication flow
grep "Authenticating wallet" logs/bot.log
grep "signatureType=" logs/bot.log
```

### 5. **Verify CLOB Auth Mode**
```bash
# Run auth probe to check configuration
npm run auth:probe

# Expected output:
# ✅ Signature Type: 0 (EOA) or 1 (Proxy) or 2 (Safe)
# ✅ Address: 0x...
# ✅ Proxy Address: 0x... (if proxy mode)
# ✅ Credentials: derived successfully
```

---

## Network-Level Diagnostics

### Capture Ray ID from Live Traffic
```bash
# Install tcpdump
sudo apt-get install tcpdump

# Capture CLOB traffic
sudo tcpdump -i any -A 'host clob.polymarket.com' -w clob_traffic.pcap

# Run bot until Cloudflare block occurs

# Analyze capture
tcpdump -A -r clob_traffic.pcap | grep -i "ray id"
```

### Check DNS Resolution
```bash
# Ensure clob.polymarket.com resolves
dig clob.polymarket.com

# Should return A records (IP addresses)
# If empty, DNS issue may prevent connection

# Check if VPN hijacks DNS
cat /etc/resolv.conf  # Should show VPN DNS servers
```

### Test VPN Exit IP
```bash
# Method 1: Check public IP
curl https://api.ipify.org

# Method 2: Check with IP geolocation
curl https://ipapi.co/json | jq '.country, .city, .org'

# Should show VPN provider, not your real ISP/location
```

---

## Interpreting Cloudflare Ray ID

**Format:** `8e4f3c2b1a9d6e7f-SJC`

- **First part (8e4f3c2b1a9d6e7f):** Unique request identifier
- **Second part (SJC):** Cloudflare PoP (Point of Presence) location

**Common PoPs:**
- SJC = San Jose, California
- LAX = Los Angeles, California
- IAD = Washington DC, Virginia
- LHR = London Heathrow, UK
- CDG = Paris Charles de Gaulle, France

**What to do with Ray ID:**
1. **Contact Polymarket support** - They may be able to check Cloudflare logs
2. **Report to VPN provider** - If VPN exit node is flagged
3. **Check Cloudflare Community** - Search for similar Ray IDs
4. **Compare across attempts** - Same PoP = consistent routing; different = VPN switching

---

## VPN Bypass Routing (Code Reference)

The codebase **intentionally excludes** `clob.polymarket.com` from bypass routing to ensure order submissions go through the VPN.

**File:** `src/lib/vpn.ts`

**Lines 624-628:**
```typescript
/**
 * Setup Polymarket API bypass for reads (gamma API, strapi)
 * Routes read-only API traffic outside VPN for speed.
 *
 * NOTE: clob.polymarket.com is NOT bypassed because it handles both
 * read operations (orderbooks, markets) AND write operations (orders, auth).
 * Write operations require VPN protection to avoid geo-blocking, and
 * IP-level routing cannot differentiate between reads and writes.
 */
```

**Lines 656-661:**
```typescript
// Polymarket API hosts for reads ONLY
// NOTE: clob.polymarket.com is intentionally EXCLUDED because it handles
// both reads (orderbooks) AND writes (order submissions, auth).
// Order submissions require VPN to avoid geo-blocking, and IP-level routing
// cannot differentiate between read and write requests to the same host.
const hosts = [
  // "clob.polymarket.com" - EXCLUDED: handles orders which need VPN protection
  "gamma-api.polymarket.com", // Gamma API (reads only)
  "strapi-matic.poly.market", // Strapi API (reads only)
];
```

**Implication:** If you see Cloudflare blocks on order submission, the most likely cause is:
1. VPN is not active/connected
2. VPN routing is broken
3. Docker container networking bypasses VPN
4. Network interface changed and VPN didn't adapt

**Verification:**
```bash
# Check if bypass is active (should be inactive for clob.polymarket.com)
ip route show | grep "$(dig +short clob.polymarket.com | head -1)"

# Should route through VPN interface (tun0, wg0), NOT default gateway
```

---

## Docker-Specific Checks

If running in Docker, network isolation may prevent VPN access:

```bash
# 1. Check container network mode
docker inspect <container_id> | jq '.[0].HostConfig.NetworkMode'

# Should be "host" to share host VPN, or custom VPN-aware network

# 2. Test VPN from inside container
docker exec <container_id> curl https://api.ipify.org

# Should match host VPN IP, not host real IP

# 3. Check container routing
docker exec <container_id> ip route

# Should show VPN interface if using host network

# 4. Fix: Use host network mode
# In docker-compose.yml:
network_mode: "host"

# Or in docker run:
docker run --network host ...
```

---

## Summary: Recommended Diagnostic Flow

1. **Check VPN is active and connected** (most common issue)
   ```bash
   ip route | grep tun
   curl https://api.ipify.org  # Should show VPN IP
   ```

2. **Verify clob.polymarket.com routes through VPN**
   ```bash
   traceroute clob.polymarket.com
   ip route get $(dig +short clob.polymarket.com | head -1)
   ```

3. **Check signature type configuration**
   ```bash
   echo "POLYMARKET_SIGNATURE_TYPE=${POLYMARKET_SIGNATURE_TYPE:-0}"
   echo "POLYMARKET_PROXY_ADDRESS=${POLYMARKET_PROXY_ADDRESS:-not set}"
   ```

4. **Test CLOB endpoint directly**
   ```bash
   curl -v https://clob.polymarket.com 2>&1 | grep -E "(HTTP|cf-|Ray ID)"
   ```

5. **Review bot logs for warnings**
   ```bash
   grep -E "(Cloudflare|signatureType|Ray ID)" logs/bot.log
   ```

6. **Try different VPN exit node** (if IP reputation issue)
   - Change VPN server to different country/region
   - Restart bot and re-test

7. **Collect Ray ID from enhanced logs** (with new changes)
   - New logging will show: `Ray ID: xxx (cf-ray: xxx-PoP) | Status: 403`
   - Provide to Polymarket support for investigation

8. **If all else fails, regenerate credentials**
   ```bash
   # Ensure correct signature type
   export POLYMARKET_SIGNATURE_TYPE=0  # or 1 for proxy
   export POLYMARKET_PROXY_ADDRESS=0x...  # if proxy mode
   
   # Clear old credentials
   unset POLYMARKET_API_KEY POLYMARKET_SECRET POLYMARKET_PASSPHRASE
   
   # Restart bot (will derive fresh credentials)
   npm start
   ```

---

## Additional Resources

- **Polymarket API Docs:** https://docs.polymarket.com
- **CLOB Auth Guide:** See `docs/TRADE_EXECUTION_DIAGNOSTIC.md`
- **VPN Routing:** See `src/lib/vpn.ts` implementation
- **Error Handling:** See `src/lib/error-handling.ts`
- **Order Execution:** See `src/lib/order.ts`

---

**Last Updated:** 2026-01-26 (after implementing enhanced Cloudflare logging)
