# WireGuard VPN Failure Diagnostic Summary

## 🔴 Root Cause

**WireGuard fails because `resolvconf` cannot find an init system in the Alpine container.**

The logs show WireGuard interface setup succeeds through step 6 (interface up), but fails at step 7 when `wg-quick` tries to configure DNS via `resolvconf`. The errors:
```
resolvconf: could not detect a useable init system
resolvconf: signature mismatch: /etc/resolv.conf
```

`wg-quick` treats this as fatal and tears down the interface (`ip link delete dev wg0`).

---

## 🔍 Technical Analysis

### Why This Happens

1. **Alpine Linux** (base image: `node:20-alpine`) runs minimal containers **without systemd or OpenRC**
2. `resolvconf` expects to communicate with an init system to manage DNS
3. Docker manages `/etc/resolv.conf` directly, not through resolvconf
4. When WireGuard config contains a `DNS` directive, `wg-quick` calls `resolvconf -a wg0` to update DNS
5. resolvconf fails → wg-quick aborts → interface torn down

### When DNS Directive is Present

The user's WireGuard config (from env vars or config file) likely includes:
```
DNS = 1.1.1.1
```
or
```
WIREGUARD_DNS=1.1.1.1
```

This line is **optional** in WireGuard configs. If omitted, `wg-quick` never calls resolvconf and the interface stays up.

---

## ✅ Recommended Fix (Immediate)

### **Remove DNS configuration from WireGuard**

The container will use Docker's default DNS (usually sufficient).

**If using environment variables:**
```bash
# Remove or comment out:
# WIREGUARD_DNS=1.1.1.1
```

**If using config file (`WG_CONFIG` or `WIREGUARD_CONFIG`):**
```ini
[Interface]
PrivateKey = ...
Address = 10.151.22.111/32
MTU = 1320
# DNS = 1.1.1.1  <-- REMOVE THIS LINE

[Peer]
PublicKey = ...
Endpoint = ...
AllowedIPs = 0.0.0.0/0
```

Restart the container → WireGuard should connect successfully.

---

## 🛠️ Long-Term Fix (Code Change)

### **Modify `src/lib/vpn.ts` to skip DNS in containers**

**Location:** Line 225 in `generateWireguardConfig()`

```typescript
// Current code:
if (dns) config += `DNS = ${dns}\n`;

// Proposed fix:
// Skip DNS config in containerized environments where resolvconf fails
const isContainer = existsSync("/.dockerenv") || process.env.container;
if (dns && !isContainer) {
  config += `DNS = ${dns}\n`;
} else if (dns && isContainer) {
  logger?.warn?.(
    "WIREGUARD_DNS specified but skipped in container (resolvconf not available). " +
    "Container will use Docker-managed DNS."
  );
}
```

This allows:
- DNS config to work in non-container environments
- Automatic skip in Docker/K8s where resolvconf fails
- Clear logging of the behavior

---

## 📊 Auth Story Format

```json
{
  "run_id": "wg-fail-20240126-210841",
  "phase": "vpn_setup",
  "attempts": [
    {
      "attempt": 1,
      "action": "wg-quick up /etc/wireguard/wg0.conf",
      "result": "FAILED",
      "error": "resolvconf: could not detect a useable init system",
      "root_cause": "Alpine container lacks init system for DNS updates",
      "interface_state": "torn_down",
      "duration_ms": 250
    }
  ],
  "diagnosis": "DNS directive in WireGuard config triggers resolvconf which fails in Alpine containers without systemd/OpenRC",
  "fix": "Remove DNS from config OR modify vpn.ts to skip DNS in containers",
  "blocking": "YES - VPN required for geo-restricted API access"
}
```

---

## 🎯 Alternative Solutions (Not Recommended)

| Solution | Pros | Cons | Recommendation |
|----------|------|------|----------------|
| Manual `wg` commands instead of `wg-quick` | Full control, no resolvconf | Complex, must replicate routing logic | ⚠️ Only if DNS control is critical |
| Switch to Ubuntu base image | resolvconf works | 3-5x larger image, slower builds | ❌ Not worth the overhead |
| Add resolvconf workaround | Preserves DNS feature | Complex, may still have signature issues | ⚠️ Only for advanced setups |
| **Remove DNS directive** | **Simple, works immediately** | **Uses Docker DNS only** | ✅ **RECOMMENDED** |

---

## 🚀 Action Items

### For User (Immediate)
1. ✅ Remove `WIREGUARD_DNS` from environment variables (or DNS line from config)
2. ✅ Restart container: `docker-compose restart`
3. ✅ Verify WireGuard connects: Check logs for "WireGuard connected"

### For Developer (Follow-up)
1. 🔧 Implement container detection in `src/lib/vpn.ts:225`
2. 📝 Add warning log when skipping DNS in containers
3. 📖 Document this limitation in README and `.env.example`
4. ✅ Test with user's config after fix

---

## 📝 Related Files

- **VPN Module:** `src/lib/vpn.ts` (lines 185-356)
- **Dockerfile:** `Dockerfile` (line 47-48 - openresolv installation)
- **Start Script:** `src/start.ts` (lines 690-696 - VPN startup)
- **Env Example:** `.env.example` (WireGuard config section)

---

## 🔗 References

- WireGuard DNS handling: https://git.zx2c4.com/wireguard-tools/about/src/man/wg-quick.8
- resolvconf in Alpine: https://wiki.alpinelinux.org/wiki/Configure_Networking#DNS_Resolution
- Docker DNS: https://docs.docker.com/config/containers/container-networking/#dns-services
