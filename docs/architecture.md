# Architecture

## Shape

Safe Market Maker is a modular TypeScript Node 20 application with a local loopback UI and CLI. The core process owns configuration, runtime signer loading, strategy, risk, execution, and SQLite state.

## Boundaries

- `config`: schema validation, raw-secret rejection, endpoint allowlist
- `secrets`: encrypted wallet and credential storage
- `venues`: Predict.fun and Polymarket adapters
- `strategy`: points/reward optimization, venue-specific market scoring, reward-fit quote generation, and quote replacement decisions
- `risk`: pre-submit checks for stale books, crossing quotes, size, depth, exposure, and duplicate token-side orders
- `execution`: live preflight, shared live context setup, live run loop orchestration, account sync/risk snapshot gate, remote open-order reconciliation, market/orderbook sync, cancellation planning, complete-set merge exit handling, quote-cycle processing, order gate checks, final submit service, event recording, and shared final submit guard for fresh orderbook plus risk rechecks
- `store`: SQLite schema migration, order ledger repository, account-risk repository, observability repository, metrics, events, checkpoints, and reconciliation
- `ui`: loopback-only live control panel, live-loop state boundary, emergency cancel controls, and modular static UI assets
- `observability`: structured logging and redaction

## Signing Model

Business logic receives only a `SignerProvider`. It can request signatures but cannot read private keys. The local wallet implementation contains an explicit SDK escape hatch for venue SDKs that require an ethers wallet; this is isolated to venue adapter code.

Configuration loading rejects raw private key, mnemonic, and seed-phrase fields anywhere in the YAML tree. Runtime logs, SQLite events, metrics, checkpoints, and UI JSON error responses pass through redaction before they leave their boundary. Public market token identifiers remain visible, but API keys, JWTs, bearer tokens, passphrases, signatures, and private-key-shaped hex strings are masked.

## Runtime Mode

Runtime execution is live-only. Tests use mock venues for safety verification, but the user-facing CLI and UI do not expose non-live execution modes.

Live execution requires:

- encrypted isolated hot wallet
- platform credentials
- selected markets
- `liveEnabled: true`
- explicit confirmation
- venue connectivity and private sync checks
- approval/balance inspection where the venue adapter supports it
- final orderbook recheck immediately before submission

The account risk and account data sync boundary is isolated in `AccountSyncService`. It owns venue account snapshot reads, snapshot persistence, account-risk decision persistence, position reads, balance reads, and structured account/balance/position reject events. The run loop calls the account-risk gate before market sync and again immediately before submission.

Remote open-order sync is isolated in `OrderReconciler`. It owns fail-closed open-order reads, local live ledger reconciliation, and structured `OPEN_ORDERS_UNAVAILABLE` rejects.

PP market routing is isolated in `RouteService`. It owns route candidate selection, route checkpoints, route selection events, and structured route reject events while reusing the same market-router scoring functions.

Market and orderbook sync is isolated in `MarketDataSyncService`. It owns market-list caching, adapter hydration on cache hits, selected/auto route market resolution, orderbook reads, and structured `ORDERBOOK_UNAVAILABLE` skip events. Auto routing uses full market metadata discovery first; `strategy.candidateLimit` is only the hot orderbook scan budget, not a global candidate cap. Orderbook reads are tiered: active tokens with current bot orders or visible complete-set inventory are scanned first, high-potential `hot` markets are scanned next, and lower-priority eligible `explore` markets rotate through a smaller sample so low-competition PP markets are eventually tested without exceeding REST rate limits. The tiered scan is periodically replaced by a full orderbook scan of all official eligible markets; route switching can then rely on a real whole-site coverage checkpoint instead of a local sample.

Cancellation is isolated in `CancelService`. It owns settlement/market-guard cancels and quote replacement cancels, and records cancel semantics consistently for Predict.fun and Polymarket.

Emergency cancel-all is isolated in `cancelAllLiveOrders`. CLI and UI both use this shared path, so both routes run the same preflight, selected-market bypass for emergency cancel, local+remote open-order merge, venue cancel call, local ledger update, and cancel event recording.

Complete-set exit handling is isolated in `LiquidationService`. The name is kept for compatibility, but the live behavior is merge-first: Predict.fun complete YES/NO sets cancel same-market bot orders and call `mergePositions` to convert equal shares back to USDT. Incomplete or single-sided inventory is held and surfaced as an event; the service does not use marketable SELL orders as a fallback.

Initial maker-order gating is isolated in `OrderGateService`. It owns same token-side duplicate skips, initial market guard checks, capital and inventory checks, order-level risk checks, and the structured `checking-risk` reject events used by UI reject statistics. The run loop uses its `ready`, `rejected`, and `skipped-existing` results to keep accepted/rejected metrics consistent.

Final maker submission is isolated in `SubmitService`. It owns planned-order recording, final orderbook refresh, `SubmitGuard` evaluation, immediate pre-submit account-risk gate, venue order submission, order-result persistence, submit events, and the open-order mirror returned to the run loop. The run loop still owns candidate iteration and accepted/rejected metrics.

Maker quote iteration is isolated in `QuoteCycleService`. It owns per-intent gate evaluation, submit dispatch, spendable balance decrementing, open-order mirror updates, accepted/rejected/balance-skip counters, and run metrics/checkpoints. `ExecutionEngine` keeps orchestration responsibilities around account sync, route selection, cancellation, liquidation, and idle-stage reporting.

UI loop state is isolated in `ui/live-loop-state.ts`. It owns public live status serialization, stop requests, cycle timestamps, error state, and timer wakeups. The HTTP server still owns request handling and execution wiring.

Static UI assets are split behind `ui/assets.ts`. HTML, CSS, and browser JavaScript are authored as separate TypeScript string modules. The browser script is further grouped by state/labels, shared utilities, status rendering, list rendering, live actions, market actions, and binding/bootstrap. The HTTP server still serves a single `/app.js`, so this split improves maintainability without adding a frontend bundler or changing the local runtime surface.

Live dependency setup is isolated in `execution/live-context.ts`. CLI and UI live actions use this shared path to load config, ensure data directories, unlock the local signer, create the venue adapter, open SQLite state, and close the store after the action.

Execution event, metric, and stage recording for the core run loop is isolated in `ExecutionRecorder`, keeping the main loop focused on execution decisions while preserving the same event payloads and checkpoint names.

SQLite persistence is split behind `StateStore`: `OrderLedgerRepository` owns planned/submitted/open order state and recent-order reads, `RiskRepository` owns account snapshots and account-risk decisions, and `ObservabilityRepository` owns events, metrics, checkpoints, and compact store status reads. Schema creation is centralized in `store/schema.ts`.

Orderbook replay fixtures cover the main live-safety gates: stale books, thin depth, unknown end time fail-closed behavior, near-settlement new-order blocks, settlement cancel windows, short-event start-time blocks, already-started event blocks, and final best-bid/offer jumps before submission. Unknown or unverifiable end times block new maker orders and request cancellation of the robot's managed open orders. Short events are detected by comparing `startTime` to `endTime`; markets shorter than `risk.shortEventMaxDurationMs` use event-start stop-new-order and cancel windows in addition to settlement windows, so sports/esports-style markets cannot stay live merely because a reward window remains open. Cancel replay fixtures cover price-drift replacement, previous-route cleanup after market switching, near-settlement hold behavior, settlement-window cancellation, and unknown-end-time cancellation. Account replay fixtures cover stale account snapshots, daily loss breaches, missing PnL/equity around real exposure, and platform frozen-funds drift from local open-order estimates. These tests replay recorded fixture shapes through `MarketGuard`, `RiskEngine`, `SubmitGuard`, `CancelService`, account-risk evaluation, and capital-risk evaluation so the live loop keeps rejecting or removing unsafe market states even as execution services are split.

## API Budget

HTTP requests are lightly throttled per origin in `venues/http.ts` so the same API host is not hit in a tight loop. The execution engine also caches market lists with `strategy.marketRefreshMs` and refreshes orderbooks through the active/hot/explore scan plan each cycle instead of pulling every token at high frequency. A periodic full route scan refreshes every official eligible market orderbook so the router can prove the current best market against the whole site at bounded intervals.

The expected scan interval is controlled by `strategy.quoteRefreshMs`. Lower intervals should be used only after observing venue rate-limit behavior. The active tier exists so already-managed orders can stay fresh even while the explore tier rotates more slowly.

## Points Optimization

The strategy layer uses separate reward optimizers:

- `strategy/rewards/predict.ts`: Predict.fun pp-level, Boost, min shares, max spread cents, and reward-window fit.
- `strategy/rewards/polymarket.ts`: Polymarket daily rewards rate, min size, max spread, neg-risk notes, and queue/depth sensitivity.

Both optimizers return a market assessment and a target quote plan. The execution engine then applies shared risk checks and a `SubmitGuard` final orderbook/risk recheck before submission. The UI no longer exposes a manual order path; live entry is restricted to the automatic split-inventory loop, and `/api/manual-order` fails closed.

The live router ranks markets by estimated effective PP share, not only by headline PP/hr:

```text
expectedPpPerHour = officialPpPerHour * targetOrderUsd / (rewardBandDepthUsd + targetOrderUsd)
```

This metric is derived from official reward PP/hr plus current orderbook reward-band depth. It is an estimate, not a platform-guaranteed payout. In Predict cash mode, routing is single-leg and token/outcome specific, but the competition denominator follows the public Predict.fun PP method: each candidate uses the same market group's YES/NO reward-band depth for that order side plus the candidate's own order amount. In strict reward mode, the candidate's own amount is the real configured `risk.orderSizeUsd`; candidates whose current quote cannot buy the venue minimum shares plus one within that amount are rejected instead of silently increasing order size. In small-test mode, execution still uses `risk.orderSizeUsd`, while ranking can estimate opportunity quality at the minimum-shares-plus-one baseline. That lets the bot find low-competition branches inside the whole market instead of chasing headline PP/hr. In Predict split paired SELL mode, routing is group-level: each YES/NO leg uses its real effective SELL notional, then the complete market group is ranked by the sum of both leg estimates. Cross-pool switching compares current group versus best group by expected PP edge, remaining safe time, and split/merge gas cost; small advantages keep maintaining the current pool.

Cash mode does not split or merge. It builds a ranked basket up to `risk.maxMarkets` and submits maker BUY orders by default. Any resulting Predict position triggers cash fill protection for that cycle: cancel all bot-managed cash orders, stop new entries while the position exists, then follow `strategy.cashOnFillAction`. With `sellWithinLossCap`, the bot submits a reduce-only SELL taker limit only when the current bid can exit inside `cashMaxExitLossPct`; it will not sweep below that loss floor. The live loop only hard-stops and requires manual restart when account risk reaches the configured total loss limit.

When `strategy.enforceRewardMinimum=false`, the system is explicitly in small live-test mode. In that mode, failing to reach the venue's PP minimum shares is not an execution bug and must not be auto-corrected by silently increasing size. For Predict.fun split paired SELL, `risk.orderSizeUsd` is the hard total notional budget for the complete YES/NO SELL group: equalized YES/NO SELL shares are capped by the current paired quote prices so the two legs together stay around the configured order amount. Existing bot-managed split SELL orders that no longer match the current size/price budget are canceled instead of being kept as "already open".

Venue normalization contract fixtures pin the field variants that matter for live routing: token ids, market/condition ids, outcome labels, earliest tradable end time and source, comma-formatted liquidity/volume, reward thresholds, PP/daily reward estimates, open-order remaining size, and collateral balance availability. These contracts are intentionally fixture-based so platform field drift is caught before it reaches live market selection or account-risk gates.

## Fill Handling

New configurations default to `strategy.onFillAction: hold`. In split mode, detected complete YES/NO inventory is the normal maker inventory and can continue quoting both SELL legs. The robot does not submit an automatic exit transaction in hold mode.

The legacy value `sellAllAtMarket` now means "attempt complete-set merge exit" for Predict.fun only:

- cancel existing bot-managed orders for the complete market group
- verify equal YES/NO inventory under the same `conditionId`
- call Predict.fun SDK `mergePositions` for the mergeable equal share amount
- skip new maker quoting for that cycle

If the inventory is incomplete or only one side exists, the service records `fill.merge-not-ready` and holds the position. It does not sell the residual side at market.

Polymarket live preflight hard-blocks merge exit because the adapter has no complete-set merge implementation. The runtime service also records `fill.merge-unsupported` if a stale or manually edited config reaches the execution layer.

## Recovery

Every run synchronizes remote open orders before placing new orders. Orders missing from remote sync are marked canceled locally. Existing open orders on the same token and side are retained only while they still match the current reward target. If a quote leaves the reward band or target price moves more than `replaceThresholdTicks`, the engine cancels and replaces it. Orders for managed tokens that no longer match the reward filters are canceled when `cancelOutsideReward` is enabled.

## Excluded From V1

Opinion and cross-platform arbitrage are represented only as disabled plugin records. They have no live execution entrypoint.
