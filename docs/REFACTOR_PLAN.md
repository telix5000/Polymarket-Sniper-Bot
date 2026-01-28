# Polymarket Bot - Refactor Plan

A prioritized refactor backlog with risk assessment and incremental action plan.

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Current Architecture Mapping](#current-architecture-mapping)
3. [Bloat Detection](#bloat-detection)
4. [Refactor Targets (Prioritized)](#refactor-targets-prioritized)
5. [Suggested Architecture](#suggested-architecture)
6. [Risk Assessment](#risk-assessment)
7. [3-Phase Action Plan](#3-phase-action-plan)

---

## Executive Summary

### Audit Highlights

| Metric | Current | Target |
|--------|---------|--------|
| `start.ts` lines | 7,453 | < 500 |
| `/lib` files | 30 | ~20 |
| Duplicate logic | 3+ areas | 0 |
| Test coverage | 341 tests | Maintain/expand |

### Cleanup Completed

- ✅ Removed unused `scavenger.ts` module (1,080 lines)
- ✅ Removed non-existent dashboard references from docs

### Key Issues

1. **God File**: `start.ts` contains 10 classes and the main loop
2. **Duplicate Logic**: Decision engine, EV tracking exist in multiple places
3. **Misplaced Modules**: Trading logic in `/lib`, infrastructure in `/lib`
4. **Facade Overload**: `/lib/index.ts` re-exports everything, defeating module boundaries

---

## Current Architecture Mapping

### `/src/config` - Configuration Layer ✅
**Status: Clean**

| File | Lines | Responsibility |
|------|-------|----------------|
| `env.ts` | ~80 | Environment variable helpers |
| `schema.ts` | ~50 | Config validation |
| `index.ts` | ~20 | Re-exports |

**Verdict**: Well-designed, single responsibility.

---

### `/src/core` - Trading Logic ✅
**Status: Clean but incomplete**

| File | Lines | Responsibility |
|------|-------|----------------|
| `decision-engine.ts` | 683 | Entry/exit decision logic |
| `ev-tracker.ts` | 348 | EV metrics & PnL tracking |
| `strategy.ts` | 122 | Strategy interface definitions |
| `risk.ts` | 119 | Position sizing & risk checks |
| `index.ts` | 59 | Re-exports |

**Issue**: Good design, but `start.ts` duplicates `DecisionEngine` and `EvTracker` classes.

---

### `/src/infra` - Infrastructure ✅
**Status: Clean but incomplete**

| Folder/File | Responsibility |
|-------------|----------------|
| `logging/index.ts` | Logger utilities |
| `persistence/` | Store abstractions (base-store, position-store, market-cache) |

**Issue**: Some infrastructure (latency-monitor, error-handling, github-reporter) is in `/lib`.

---

### `/src/models` - Data Models ✅
**Status: Clean**

| File | Responsibility |
|------|----------------|
| `common.ts` | Common types (Logger, Preset) |
| `order.ts` | Order types |
| `position.ts` | Position types |
| `trade.ts` | Trade signal types |
| `whale.ts` | Whale tracker types |

**Verdict**: Pure type definitions, well-organized.

---

### `/src/services` - External Integrations ✅
**Status: Clean**

| File/Folder | Responsibility |
|-------------|----------------|
| `polymarket/rest-client.ts` | REST API client |
| `polymarket/ws-client.ts` | WebSocket client |
| `polymarket/rate-limit.ts` | Rate limiting |
| `interfaces.ts` | Service interfaces |

**Verdict**: Well-encapsulated external API layer.

---

### `/src/lib` - Utilities (Catch-All) ⚠️
**Status: Bloated, needs reorganization**

| Category | Files | Issue |
|----------|-------|-------|
| Trading Logic | smart-sell, order, dynamic-*, market-* | Should be in `/core` |
| Infrastructure | latency-monitor, github-reporter, error-handling | Should be in `/infra` |
| Utilities | auth, balance, telegram, vpn, ethers-compat | Appropriate location |
| Re-exports | index.ts (117 lines) | Too broad |

**Files by Size (top 10)**:
| File | Lines | Notes |
|------|-------|-------|
| `diag-workflow.ts` | 2,837 | Diagnostic workflows - keep separate |
| `vpn.ts` | 1,751 | VPN support - specialized |
| `onchain-monitor.ts` | 1,038 | On-chain monitoring |
| `ws-user-client.ts` | 1,008 | WebSocket client |
| `dynamic-hedge-policy.ts` | 861 | Risk management → move to `/core` |
| `dynamic-ev-engine.ts` | 851 | EV calculations → move to `/core` |
| `ws-market-client.ts` | 829 | WebSocket client |
| `github-reporter.ts` | 825 | Reporting → move to `/infra` |
| `smart-sell.ts` | 705 | Exit logic → move to `/core` |

---

### `/src/start.ts` - Entry Point 🚨
**Status: GOD FILE - Critical refactor needed**

| Embedded Class | Lines (est.) | Should Be |
|----------------|--------------|-----------|
| `EvTracker` | 200 | `/core/ev-tracker.ts` (consolidate) |
| `BiasAccumulator` | 150 | `/lib/bias-accumulator.ts` (extract) |
| `MarketScanner` | 300 | `/lib/market-scanner.ts` (consolidate) |
| `DynamicReserveManager` | 200 | `/core/reserve-manager.ts` (extract) |
| `PositionManager` | 400 | `/core/position-manager.ts` (extract) |
| `DecisionEngine` | 500 | `/core/decision-engine.ts` (consolidate) |
| `MarketDataCooldownManager` | 150 | `/lib/market-cooldown.ts` (extract) |
| `ExecutionEngine` | 500 | `/core/execution-engine.ts` (extract) |
| `ChurnEngine` | 200 | `/core/churn-engine.ts` (extract) |
| Main loop & init | 1000+ | Keep minimal orchestration |

---

## Bloat Detection

### God Files

| File | Lines | Issue |
|------|-------|-------|
| `start.ts` | 7,453 | 10 embedded classes + main loop |
| `diag-workflow.ts` | 2,837 | Large but specialized |
| `vpn.ts` | 1,751 | Large but specialized |

### Excessive Dependencies

`start.ts` imports directly from:
- `@polymarket/clob-client`
- `axios`
- `dotenv/config`
- 80+ exports from `./lib`

### Duplicate Logic

| Concern | Locations | Action |
|---------|-----------|--------|
| Decision Engine | `/core/decision-engine.ts` + `start.ts` | Consolidate to `/core` |
| EV Tracking | `/core/ev-tracker.ts` + `start.ts` | Consolidate to `/core` |
| Market Scanning | `/lib/market-scanner.ts` + `start.ts` | Consolidate to `/lib` |

---

## Refactor Targets (Prioritized)

### Priority 1: Critical (Immediate)
**Goal**: Reduce `start.ts` to orchestration only

| Target | Action | Risk | Benefit |
|--------|--------|------|---------|
| Extract `ExecutionEngine` | Move to `/core/execution-engine.ts` | Medium | Testability |
| Extract `PositionManager` | Move to `/core/position-manager.ts` | Medium | Testability |
| Consolidate `DecisionEngine` | Use existing `/core/decision-engine.ts` | High | Remove duplication |
| Consolidate `EvTracker` | Use existing `/core/ev-tracker.ts` | Medium | Remove duplication |

### Priority 2: High (Near-term)
**Goal**: Reorganize `/lib` for clarity

| Target | Action | Risk | Benefit |
|--------|--------|------|---------|
| Move `smart-sell.ts` | Relocate to `/core` | Low | Clear ownership |
| Move `dynamic-hedge-policy.ts` | Relocate to `/core` | Low | Clear ownership |
| Move `dynamic-ev-engine.ts` | Relocate to `/core` | Low | Clear ownership |
| Move `latency-monitor.ts` | Relocate to `/infra` | Low | Clear ownership |
| Move `github-reporter.ts` | Relocate to `/infra` | Low | Clear ownership |
| Move `error-handling.ts` | Relocate to `/infra` | Low | Clear ownership |

### Priority 3: Medium (Future)
**Goal**: Clean up remaining structure

| Target | Action | Risk | Benefit |
|--------|--------|------|---------|
| Simplify `/lib/index.ts` | Remove blanket re-exports | Medium | Module boundaries |
| Extract remaining `start.ts` classes | BiasAccumulator, ChurnEngine, etc. | Medium | Maintainability |
| Add integration tests | Cover extracted modules | Low | Regression safety |

---

## Suggested Architecture

### Current vs Proposed

```
CURRENT:                          PROPOSED:
src/                              src/
├── config/      ✅ Keep          ├── config/      (unchanged)
├── core/        ⚠️  Underused    ├── core/        (expanded)
│   └── 5 files                   │   ├── decision-engine.ts
├── infra/       ⚠️  Incomplete   │   ├── ev-tracker.ts
│   └── 6 files                   │   ├── execution-engine.ts  ← NEW
├── lib/         🚨 Bloated       │   ├── position-manager.ts  ← NEW
│   └── 33 files                  │   ├── reserve-manager.ts   ← NEW
├── models/      ✅ Keep          │   ├── risk.ts
├── services/    ✅ Keep          │   ├── smart-sell.ts        ← FROM /lib
└── start.ts     🚨 God File      │   ├── dynamic-hedge.ts     ← FROM /lib
                                  │   ├── dynamic-ev.ts        ← FROM /lib
                                  │   └── strategy.ts
                                  ├── infra/       (expanded)
                                  │   ├── logging/
                                  │   ├── persistence/
                                  │   ├── latency-monitor.ts   ← FROM /lib
                                  │   ├── github-reporter.ts   ← FROM /lib
                                  │   └── error-handling.ts    ← FROM /lib
                                  ├── lib/         (trimmed ~20 files)
                                  │   ├── auth.ts
                                  │   ├── balance.ts
                                  │   ├── market-data-*.ts
                                  │   ├── ws-*.ts
                                  │   ├── telegram.ts
                                  │   ├── vpn.ts
                                  │   └── ...utilities
                                  ├── models/      (unchanged)
                                  ├── services/    (unchanged)
                                  └── start.ts     (~500 lines, orchestration only)
```

### Architecture Style: Layered + Domain-Focused

```
┌─────────────────────────────────────────────────────────────┐
│                        start.ts                              │
│                   (Orchestration Layer)                      │
├──────────────────────┬──────────────────────────────────────┤
│       /core          │              /services               │
│   (Business Logic)   │         (External APIs)              │
│                      │                                       │
│  • decision-engine   │  • polymarket/rest-client            │
│  • execution-engine  │  • polymarket/ws-client              │
│  • position-manager  │  • polymarket/rate-limit             │
│  • risk management   │                                       │
│  • EV tracking       │                                       │
├──────────────────────┴──────────────────────────────────────┤
│                          /lib                                │
│                    (Shared Utilities)                        │
│                                                              │
│  • auth, balance, telegram, vpn                              │
│  • market-data-*, ws-*                                       │
│  • copy, redeem, targets                                     │
├─────────────────────────────────────────────────────────────┤
│              /infra              │         /models           │
│       (Infrastructure)           │     (Data Models)         │
│                                  │                           │
│  • logging                       │  • Position, Trade        │
│  • persistence                   │  • Order, Whale           │
│  • latency-monitor               │  • Common types           │
│  • error-handling                │                           │
├──────────────────────────────────┴───────────────────────────┤
│                          /config                             │
│                   (Configuration Layer)                      │
└─────────────────────────────────────────────────────────────┘
```

---

## Risk Assessment

### High Risk Areas (Handle with Care)

| Area | Risk | Mitigation |
|------|------|------------|
| `DecisionEngine` consolidation | May break entry/exit logic | Full test coverage before changing |
| `ExecutionEngine` extraction | Order placement could fail | Test in simulation mode first |
| `PositionManager` extraction | Position tracking errors | Verify P&L calculations |

### Medium Risk Areas

| Area | Risk | Mitigation |
|------|------|------------|
| `/lib/index.ts` changes | Break imports in `start.ts` | Update imports incrementally |
| Moving files to `/core` | Import path changes | Use IDE refactoring tools |

### Low Risk Areas

| Area | Risk | Mitigation |
|------|------|------------|
| Moving to `/infra` | Pure infrastructure | Simple path updates |
| Documentation updates | None | N/A |

### Critical Code Paths (Do Not Break)

1. **Order Execution** (`order.ts`, `ExecutionEngine`)
2. **Price Validation** (`price-safety.ts`)
3. **Risk Management** (`risk.ts`, `dynamic-hedge-policy.ts`)
4. **WebSocket Connections** (`ws-*.ts`)
5. **Authentication** (`auth.ts`)

---

## 3-Phase Action Plan

### Phase 1: Foundation (Week 1-2)
**Goal**: Add test coverage for critical paths before refactoring

| Step | Task | Tests to Run | Checkpoint |
|------|------|--------------|------------|
| 1.1 | Add tests for `DecisionEngine` in `start.ts` | `npm test` | All pass |
| 1.2 | Add tests for `ExecutionEngine` | `npm test` | All pass |
| 1.3 | Add tests for `PositionManager` | `npm test` | All pass |
| 1.4 | Verify simulation mode works | Manual test | No errors |

**Regression-proof**: Run `npm test && npm run build` after each step.

### Phase 2: Extraction (Week 3-4)
**Goal**: Extract classes from `start.ts` to proper modules

| Step | Task | Tests to Run | Checkpoint |
|------|------|--------------|------------|
| 2.1 | Extract `ExecutionEngine` to `/core` | `npm test` | All pass |
| 2.2 | Extract `PositionManager` to `/core` | `npm test` | All pass |
| 2.3 | Consolidate `DecisionEngine` | `npm test` | All pass |
| 2.4 | Consolidate `EvTracker` | `npm test` | All pass |
| 2.5 | Verify trading loop works | Simulation mode | Executes trades |

**Regression-proof**: 
- Run full test suite after each extraction
- Test simulation mode after major changes
- Keep old code commented until verified

### Phase 3: Reorganization (Week 5-6)
**Goal**: Reorganize `/lib` and finalize structure

| Step | Task | Tests to Run | Checkpoint |
|------|------|--------------|------------|
| 3.1 | Move `smart-sell.ts` to `/core` | `npm test && npm run build` | All pass |
| 3.2 | Move `dynamic-*.ts` to `/core` | `npm test && npm run build` | All pass |
| 3.3 | Move infra files to `/infra` | `npm test && npm run build` | All pass |
| 3.4 | Simplify `/lib/index.ts` | `npm test && npm run build` | All pass |
| 3.5 | Update documentation | Manual review | Accurate |
| 3.6 | Final verification | Full test + simulation | All working |

**Regression-proof**:
- Run `npm run lint && npm test && npm run build` after each move
- Verify imports compile correctly
- Test simulation mode end-to-end

---

## File-by-File Refactor Guide

For detailed file-by-file instructions, request the specific file you want to refactor:

```
Available for detailed guidance:
- start.ts (extraction of embedded classes)
- /lib → /core migrations
- /lib → /infra migrations
- Import cleanup
```

---

## Success Criteria

| Metric | Before | After |
|--------|--------|-------|
| `start.ts` lines | 7,453 | < 500 |
| Test count | 341 | 341+ |
| Build time | Baseline | Same or better |
| `/lib` file count | 30 | ~20 |
| Duplicate code | 3 areas | 0 |

---

## Conclusion

The Polymarket bot has a solid foundation in `/config`, `/models`, `/services`, and `/infra`, but suffers from:

1. A massive `start.ts` god file that embeds 10 classes
2. Duplicate logic between `/core` and `start.ts`
3. An overloaded `/lib` folder acting as both facade and business logic container

The recommended approach is **incremental extraction** with strong test coverage at each step. Priority 1 targets (extracting from `start.ts`) will have the highest impact on maintainability.

---

*Last updated: See git history for version dates*
