# 🔄 Sell Logic Quick Reference

> **For complete documentation, see [SELLING_LOGIC.md](./SELLING_LOGIC.md)**

## Common Issues & Solutions

### ❌ "Price too low: 1¢ < 67¢"

**What it means:** Best bid (1¢) is below your minimum acceptable price

**Quick fixes:**

1. **Wait for better liquidity** (safest)
2. **Check your mode:**
   ```bash
   # Standard sell: 1% slippage
   # Won't sell if bid < 66¢ (for 67¢ entry)
   
   # Emergency CONSERVATIVE: 50% protection
   # Won't sell if bid < 34¢ (for 67¢ entry)
   
   # Emergency MODERATE: 20% protection
   # Won't sell if bid < 13¢ (for 67¢ entry)
   ```

3. **Force sell (⚠️ DANGEROUS):**
   ```bash
   # Add to .env
   EMERGENCY_SELL_MODE=NUCLEAR
   
   # Restart
   docker-compose restart
   ```

---

### ❌ "No bids available"

**What it means:** Orderbook has zero buyers

**Solutions:**
1. Wait for market activity
2. Check if market is resolved → use redeem instead
3. Use NUCLEAR mode if desperate (but still won't sell with 0 buyers!)

---

## Sell Pathways

### 1. Standard Sell (`sellPosition`)
- **Protection:** 1% slippage
- **Used by:** Strategy exits (Blitz, Command, Guardian, etc.)
- **Min price:** `entry * 0.99`

### 2. Emergency Sell (`sellPositionEmergency`)
- **Protection:** CONSERVATIVE/MODERATE/NUCLEAR
- **Used by:** Emergency & recovery mode
- **Min price:** Varies by mode

| Mode | Protection | Example |
|------|------------|---------|
| CONSERVATIVE | 50% | 67¢ → min 34¢ |
| MODERATE | 20% | 67¢ → min 13¢ |
| NUCLEAR | None | 67¢ → will sell at 1¢ |

### 3. Scavenger Sells
- **Used in:** Low liquidity periods
- **EXIT_GREEN:** Exits profitable positions opportunistically
- **EXIT_RED_RECOVERY:** Exits red positions when they recover

---

## Log Indicators

### Standard Sell
```
🔄 [SELL] Patriots
   Pathway: Standard sell (1% slippage protection)
   Reason: APEX Blitz: 12.5% profit in 15min
```

### Emergency Sell
```
🔄 [SELL] Patriots
   Pathway: Emergency sell (configurable protection)
   Protection: CONSERVATIVE mode
   Min acceptable: 34.0¢
```

### Recovery Mode
```
♻️ RECOVERY MODE (Cycle 42)
   Balance: $3.15 | Positions: 8
   Emergency mode: 🚨 ACTIVE
```

### Scavenger Mode
```
🦅 [SCAV] Green exit: Patriots | P&L: 2.5%
✅ [SCAV] Green exit success: $12.89
```

---

## Strategy Exit Signals

| Strategy | Trigger | Log Pattern |
|----------|---------|-------------|
| **Blitz** | Quick profit | `APEX Blitz: 12.5% profit in 15min` |
| **Command** | Near $1 | `APEX Command: Auto-sell at 99¢` |
| **Guardian** | Stop-loss | `APEX Guardian: Stop-loss 28.5%` |
| **Ratchet** | Trailing stop | `APEX Ratchet: Trailing stop at 15%` |
| **Ladder** | Profit rung | `APEX Ladder: Profit rung 20% reached` |
| **Reaper** | Strategy cleanup | `APEX Reaper: Strategy disabled` |

---

## Configuration Quick Copy

### Conservative Setup (Default)
```bash
EMERGENCY_SELL_MODE=CONSERVATIVE
EMERGENCY_BALANCE_THRESHOLD=5
```

### Moderate Setup
```bash
EMERGENCY_SELL_MODE=MODERATE
EMERGENCY_BALANCE_THRESHOLD=5
```

### Nuclear Setup (⚠️ DANGEROUS)
```bash
EMERGENCY_SELL_MODE=NUCLEAR
EMERGENCY_BALANCE_THRESHOLD=5
```

---

## Troubleshooting Flow

```
Position won't sell?
│
├─ Check logs for "Pathway:" indicator
│  │
│  ├─ "Standard sell" → 1% slippage protection
│  │  └─ Wait for better liquidity
│  │
│  ├─ "Emergency sell" → Check mode
│  │  ├─ CONSERVATIVE → Switch to MODERATE?
│  │  ├─ MODERATE → Switch to NUCLEAR?
│  │  └─ NUCLEAR → Check "No bids available"
│  │
│  └─ "Recovery sell" → Same as emergency
│
├─ Check error message
│  │
│  ├─ "Price too low" → See mode-specific fixes above
│  │
│  ├─ "No bids available" → Wait or redeem
│  │
│  └─ "Sell failed: ORDER_FAILED" → Check market status
│
└─ Still stuck?
   └─ See full guide: docs/SELLING_LOGIC.md
```

---

## Emergency Mode Comparison

| Scenario | Recommended Mode | Why |
|----------|-----------------|-----|
| **Markets illiquid but not dead** | CONSERVATIVE | Protects from panic selling, waits for liquidity |
| **Need capital soon, markets mostly dead** | MODERATE | Allows 80% losses but catches occasional liquidity |
| **Markets completely dead, desperate** | NUCLEAR | Sells at ANY price, frees capital immediately |

---

## Key Takeaways

1. **"Price too low" = Price protection working** ✅
   - Not a bug, it's preventing bad sells
   - Adjust mode if you need to sell anyway

2. **Emergency modes are for emergencies** ⚠️
   - NUCLEAR accepts massive losses
   - Only use when you understand the consequences

3. **Check your logs** 📊
   - "Pathway:" tells you which sell function
   - "Reason:" tells you which strategy
   - "Protection:" tells you which mode

4. **Different situations need different modes** 🎯
   - Use the troubleshooting flow above
   - Read full docs when confused

---

**Full Documentation:** [SELLING_LOGIC.md](./SELLING_LOGIC.md)  
**Emergency Sells:** [EMERGENCY_SELLS.md](./EMERGENCY_SELLS.md)  
**Main README:** [../README.md](../README.md)
