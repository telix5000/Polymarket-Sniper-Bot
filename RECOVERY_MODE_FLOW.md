# APEX v3.0 Recovery Mode Flow

## Startup Flow

```
┌─────────────────────────────────────┐
│  Bot Starts                         │
│  - Read PRIVATE_KEY                 │
│  - Initialize CLOB Client           │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  Check Startup Balance              │
│  - Get USDC Balance                 │
│  - Fetch Positions                  │
│  - Calculate Portfolio Value        │
└──────────────┬──────────────────────┘
               │
               ▼
       ┌───────┴───────┐
       │               │
       ▼               ▼
┌──────────────┐  ┌──────────────┐
│ Balance < $1 │  │ Balance >= $1│
│ No Positions │  │ OR Positions │
└──────┬───────┘  └──────┬───────┘
       │                 │
       ▼                 ▼
   ┌───────┐       ┌─────────┐
   │ EXIT  │       │ CONTINUE│
   └───────┘       └─────┬───┘
                         │
                         ▼
                 ┌───────────────┐
                 │ Balance < $20 │
                 │ AND Positions │
                 └───────┬───────┘
                         │
                         ▼
                 ┌───────────────┐
                 │ RECOVERY MODE │
                 └───────────────┘
```

## Recovery Mode Cycle

```
┌──────────────────────────────────────┐
│  APEX Cycle Starts                   │
│  - Update Balance                    │
│  - Fetch Positions                   │
└──────────────┬───────────────────────┘
               │
               ▼
       ┌───────────────────┐
       │ Balance < $20 ?   │
       └────┬─────────┬────┘
            │ YES     │ NO
            ▼         │
    ┌──────────────┐ │
    │ Enter/Stay   │ │
    │ Recovery     │ │
    │ Mode         │ │
    └──────┬───────┘ │
           │         │
           ▼         │
    ┌──────────────┐ │
    │ Priority 1:  │ │
    │ Exit         │ │
    │ Profitable   │ │
    │ Positions    │ │
    │ (PnL > 0.5%) │ │
    └──────┬───────┘ │
           │         │
           ▼         │
    ┌──────────────┐ │
    │ Priority 2:  │ │
    │ Exit Near-   │ │
    │ Resolution   │ │
    │ (Price>95¢)  │ │
    └──────┬───────┘ │
           │         │
           ▼         │
    ┌──────────────┐ │
    │ Priority 3:  │ │
    │ Exit Small   │ │
    │ Losers       │ │
    │ (if bal<$10) │ │
    └──────┬───────┘ │
           │         │
           ▼         │
    ┌──────────────┐ │
    │ Balance      │ │
    │ >= $20 ?     │ │
    └──┬───────┬───┘ │
       │ YES   │ NO  │
       ▼       │     │
    ┌─────┐   │     │
    │Exit │   │     │
    │Mode │   │     │
    └──┬──┘   │     │
       │      │     │
       ▼      ▼     ▼
    ┌──────────────────┐
    │ Continue Normal  │
    │ APEX Cycle       │
    └──────────────────┘
```

## Error Handling Flow

```
┌──────────────────────────────────────┐
│  Order Placed                        │
└──────────────┬───────────────────────┘
               │
               ▼
       ┌───────────────┐
       │ Success ?     │
       └────┬─────┬────┘
            │ NO  │ YES
            ▼     │
    ┌──────────┐ │
    │ Extract  │ │
    │ Error    │ │
    └────┬─────┘ │
         │       │
         ▼       │
  ┌───────────┐  │
  │ Check     │  │
  │ Error     │  │
  │ Type      │  │
  └──┬────────┘  │
     │           │
     ▼           │
┌────────────────────────┐
│ Response Errors:       │
│ - err.response.data    │
│ - err.data.error       │
│ - err.errorMsg         │
└──────┬─────────────────┘
       │
       ▼
┌────────────────────────┐
│ Assign Reason Code:    │
│ - INSUFFICIENT_BALANCE │
│ - INSUFFICIENT_ALLOW.  │
│ - PRICE_SLIPPAGE       │
│ - CLOUDFLARE_BLOCKED   │
└──────┬─────────────────┘
       │
       ▼
┌────────────────────────┐
│ Log Clean Message      │
│ Track lastErrorReason  │
└──────┬─────────────────┘
       │
       ▼
┌────────────────────────┐
│ Retry < MAX ?          │
└─┬──────────────────┬───┘
  │ YES              │ NO
  │                  │
  ▼                  ▼
┌──────┐      ┌──────────┐
│ Retry│      │ Return   │
└──────┘      │ Error    │
              └──────────┘
```

## State Transitions

```
   ┌─────────────┐
   │   STARTUP   │
   │   NORMAL    │
   └──────┬──────┘
          │
          │ Balance < $20
          │ Positions exist
          ▼
   ┌─────────────┐
   │  RECOVERY   │◄─────┐
   │    MODE     │      │
   └──────┬──────┘      │
          │             │
          │ Liquidate   │
          │ Positions   │
          │             │
          ▼             │
   ┌─────────────┐      │
   │  Balance    │      │
   │  Check      │      │
   └──────┬──────┘      │
          │             │
     ┌────┴────┐        │
     │         │        │
  < $20      >= $20     │
     │         │        │
     └─────────┘        │
          │             │
          │ Exit        │
          │ Recovery    │
          ▼             │
   ┌─────────────┐      │
   │   NORMAL    │      │
   │  OPERATION  │      │
   └──────┬──────┘      │
          │             │
          │ Balance     │
          │ drops < $20 │
          └─────────────┘
```

## Balance Check Logic

```
START
  │
  ▼
Get Balance
  │
  ▼
Get Positions
  │
  ▼
Calculate Portfolio = Balance + Position Value
  │
  ├─────────────────────────┬────────────────┐
  │                         │                │
Balance < $20          Balance < $1      Balance >= $1
Positions > 0          Positions = 0     OR Positions > 0
  │                         │                │
  ▼                         ▼                ▼
RECOVERY MODE            EXIT WITH       CONTINUE
Liquidate                ERROR           NORMAL
  │                         │                │
  └─────────────────────────┴────────────────┘
                            │
                            ▼
                       RUN APEX CYCLE
```

## Priority Levels

```
APEX Cycle Priority Order:

Priority -1: RECOVERY MODE CHECK
          └─► Check balance < $20
          └─► Run recovery exits if needed
          └─► Skip new entries during recovery

Priority 0:  FIREWALL CHECK
          └─► Validate trading not halted

Priority 1:  HUNTER SCAN
          └─► Scan for opportunities

Priority 2:  EXITS
          └─► Blitz exits (quick scalps)
          └─► Command exits (auto-sell)

Priority 3:  REDEMPTION
          └─► Convert wins to USDC

Priority 4:  ENTRIES
          └─► Deploy capital
          └─► Execute strategies
```

## Recovery Exit Priority

```
Priority 1: PROFITABLE POSITIONS
         ├─► Filter: PnL > 0.5%
         ├─► Sort: Most profitable first
         └─► Action: Sell at market

Priority 2: NEAR-RESOLUTION
         ├─► Filter: Price > 95¢ AND Loss < 2%
         ├─► Action: Sell to free capital

Priority 3: SMALL LOSERS (if balance < $10)
         ├─► Filter: -5% < Loss < 0.5%
         ├─► Sort: Least losing first
         └─► Action: Cut losses to free capital
```

## Environment Variables

```
┌─────────────────────────────────────────┐
│  Required:                              │
│  • PRIVATE_KEY                          │
│  • RPC_URL                              │
└─────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────┐
│  Optional:                              │
│  • SKIP_BALANCE_CHECK_ON_STARTUP=true   │
│  • LIVE_TRADING=I_UNDERSTAND_THE_RISKS  │
│  • TELEGRAM_BOT_TOKEN                   │
│  • TELEGRAM_CHAT_ID                     │
│  • APEX_MODE (CONSERVATIVE/BALANCED/AGG)│
└─────────────────────────────────────────┘
```

## Key Thresholds

```
RECOVERY_MODE_BALANCE_THRESHOLD = $20
  └─► Triggers recovery mode activation

MINIMUM_OPERATING_BALANCE = $1
  └─► Minimum to continue without positions

PROFITABLE_POSITION_THRESHOLD = 0.5%
  └─► Min profit to exit in recovery

NEAR_RESOLUTION_PRICE_THRESHOLD = 95¢
  └─► Price for near-resolution exits

EMERGENCY_BALANCE_THRESHOLD = $10
  └─► Triggers emergency small-loser exits

MAX_ACCEPTABLE_LOSS = -5%
  └─► Max loss for emergency exits
```

## Notification Flow

```
┌──────────────────┐
│ State Change     │
└────────┬─────────┘
         │
         ├─► Recovery Mode Activated
         │   └─► Telegram Alert
         │
         ├─► Recovery Mode Complete
         │   └─► Telegram Alert
         │
         ├─► Balance Too Low
         │   └─► Telegram Alert + Error Report
         │
         └─► Order Failed (Critical)
             └─► Telegram Alert + Error Report
```
