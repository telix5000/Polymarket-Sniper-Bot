# WireGuard VPN Auth Story

**Run ID:** `wireguard-diagnostic-20240126-210841`  
**Timestamp:** 2024-01-26T21:08:41Z  
**Component:** VPN Setup (WireGuard)  
**Result:** ❌ FAILED

---

## One-Line Diagnosis

Alpine container lacks init system → resolvconf fails on DNS config → wg-quick aborts → interface torn down

---

## Execution Trace

```
[21:08:41] INFO  Starting WireGuard...
           ├─ Step 1: ip link add dev wg0 type wireguard                    [✓]
           ├─ Step 2: wg setconf wg0 /dev/fd/63                            [✓]
           ├─ Step 3: ip -4 address add 10.151.22.111/32 dev wg0           [✓]
           ├─ Step 4: ip -6 address add fd7d:76ee:...:35b4/128 dev wg0     [✓]
           ├─ Step 5: ip link set mtu 1320 up dev wg0                      [✓]
           │          Interface wg0 is UP and configured
           │
           ├─ Step 6: resolvconf -a wg0 -m 0 -x                            [✗]
           │          ERROR: could not detect a useable init system
           │          ERROR: signature mismatch: /etc/resolv.conf
           │          CAUSE: Alpine container has no systemd/OpenRC
           │
           └─ Step 7: ip link delete dev wg0                                [✓]
                      wg-quick cleanup: interface torn down

[21:08:41] WARN  ⚠️ WireGuard failed: Command failed: wg-quick up /etc/wireguard/wg0.conf
```

---

## Root Cause

| Layer | Issue | Impact |
|-------|-------|--------|
| **Environment** | Alpine Linux (node:20-alpine) | No init system (no systemd/OpenRC) |
| **Component** | resolvconf | Cannot detect init system to manage DNS |
| **Configuration** | WireGuard config contains `DNS = ...` | Triggers resolvconf call via wg-quick |
| **Docker** | /etc/resolv.conf managed by Docker daemon | Not under resolvconf control → signature mismatch |
| **Tool Behavior** | wg-quick aborts on first error | Tears down interface on resolvconf failure |

**Bottom Line:** DNS configuration step is incompatible with Alpine containers, blocking VPN establishment.

---

## Code Path

```
src/start.ts:696
  → startWireguard(logger)

src/lib/vpn.ts:259
  → generateWireguardConfig() OR read existing config
  
src/lib/vpn.ts:220-232
  → Generate config with DNS line if WIREGUARD_DNS is set
     if (dns) config += `DNS = ${dns}\n`;  ← Line 225
     
src/lib/vpn.ts:346
  → execSync(`wg-quick up /etc/wireguard/wg0.conf`)
  
wg-quick script
  → Sets up interface (success)
  → Calls resolvconf -a wg0 (failure)
  → Tears down interface (cleanup)
  
src/lib/vpn.ts:351-354
  → Catches error, logs warning, returns false
```

---

## Signing Inputs / Request Details

**Config Generated:**
```ini
[Interface]
PrivateKey = <redacted>
Address = 10.151.22.111/32
MTU = 1320
DNS = 1.1.1.1  ← Triggers resolvconf

[Peer]
PublicKey = <redacted>
Endpoint = vpn.example.com:51820
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
```

**Command Executed:**
```bash
wg-quick up /etc/wireguard/wg0.conf
```

**Environment:**
- Base Image: node:20-alpine
- Init System: NONE
- resolvconf: Installed (openresolv package) but incompatible
- /etc/resolv.conf: Managed by Docker daemon

---

## HTTP Request/Response

**N/A** - Failure occurs at OS/network layer before any API calls

---

## Fix

### Immediate (User)
Remove DNS directive from WireGuard configuration:

**Option A - Environment Variables:**
```bash
# Remove or comment out:
# WIREGUARD_DNS=1.1.1.1
```

**Option B - Config File:**
```ini
[Interface]
PrivateKey = ...
Address = 10.151.22.111/32
# DNS = 1.1.1.1  ← Remove or comment out
```

Restart container → WireGuard should connect

**Trade-off:** Container uses Docker-managed DNS instead of custom DNS (usually fine)

---

### Permanent (Code)

**File:** `src/lib/vpn.ts`  
**Line:** 225  
**Change:**

```typescript
// Before:
if (dns) config += `DNS = ${dns}\n`;

// After:
const isContainer = existsSync("/.dockerenv") || !!process.env.container;
if (dns && !isContainer) {
  config += `DNS = ${dns}\n`;
} else if (dns && isContainer) {
  logger?.warn?.(
    "WIREGUARD_DNS skipped in container (resolvconf unavailable). Using Docker DNS."
  );
}
```

**Rationale:**
- Preserves DNS config on bare metal (where resolvconf works)
- Auto-skips in containers (where it fails)
- Provides clear log message explaining the behavior

---

## Impact

**Blocking:** YES  
**Severity:** HIGH  
**User Workaround:** Remove DNS from config (simple, 1-line change)  
**Code Fix Needed:** YES (prevent future occurrences)

**Why It Matters:**
- VPN required for geo-restricted Polymarket API access
- Without VPN, auth/orders fail with 403 Forbidden
- Silent failure mode (logs show warning but unclear fix to users)

---

## Lessons Learned

1. **Container DNS is Different:** Alpine containers don't have traditional init systems
2. **wg-quick Assumptions:** Assumes resolvconf is available when DNS is configured
3. **Optional Features Become Blockers:** DNS config is optional but breaks setup when present
4. **Error Messages Need Context:** "could not detect init system" doesn't explain Alpine incompatibility

---

## Prevention

- [ ] Detect container environment and skip DNS config
- [ ] Add warning log explaining DNS behavior in containers
- [ ] Update documentation (.env.example, README) about DNS limitations
- [ ] Consider alternative: manual `wg` commands instead of `wg-quick` for full control
- [ ] Add automated test for WireGuard setup in Alpine containers

---

## Related Files

- `src/lib/vpn.ts` - VPN setup logic
- `src/start.ts` - VPN startup call
- `Dockerfile` - Alpine base image + openresolv installation
- `.env.example` - WireGuard config examples

---

## Verification

After fix, expect:
```
[21:08:41] INFO  Starting WireGuard...
[21:08:41] INFO  WireGuard connected
[21:08:41] INFO  VPN active: wireguard
```

Verify interface:
```bash
docker exec -it <container> wg show
# Should show: interface wg0, peer, endpoint, latest handshake
```

---

**Auth Story Complete**  
✅ Root cause identified  
✅ Fix documented  
✅ Code change specified  
✅ User workaround provided
