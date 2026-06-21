# Acceptance Checklist

## Offline Acceptance

- `npm ci`
- `npm run check`
- `npm run build`
- `npm audit --audit-level=moderate`
- `node dist/src/cli/index.js --help`

## Readiness Acceptance

- `mm init --guided` creates `config.yaml` and SQLite state.
- `mm wallet import --venue <venue>` stores only an encrypted keystore.
- `mm auth predict` stores encrypted Predict JWT credentials when Predict is used.
- `mm auth polymarket` stores encrypted Polymarket CLOB credentials when Polymarket is used.
- `mm recommend --venue <venue> --top 3 --apply` writes reviewed market token IDs to `selectedMarkets`.
- `mm approvals inspect --venue <venue> --token-id <token>` passes or clearly reports the missing approval/balance action.
- `mm preflight --venue <venue> --confirm LIVE` fails closed until every live gate passes.

## UI Live Acceptance

- Local UI starts on loopback only: `node dist/src/cli/index.js ui --port 8788`.
- The page does not expose non-live runtime modes.
- Overview shows live loop state, wallet state, credential state, selected market count, open orders, and latest error.
- Overview exposes editable order size, quote side, quote mode, depth level, retreat ticks, liquidity filter, market count, and points-only setting.
- Risk and strategy pages show Chinese parameter names, values, units, and explanations.
- Market recommendations default to points/reward markets, accepting-orders markets, and the configured minimum liquidity filter.
- Manual live orders are disabled; `/api/manual-order` must fail closed.
- Start live is rejected without a runtime signer, `liveEnabled: true`, credentials, selected markets unless auto routing is enabled, and successful preflight.
- Stop halts new loop cycles without canceling existing orders.
- Stop-and-cancel uses the runtime signer and submits cancel-all through the live preflight path.

## Live Micro-Acceptance

Only perform this with a wallet funded with a small amount you accept losing.

- `config.yaml` has `liveEnabled: true`.
- Selected markets are explicitly set by recommendation or manual review.
- `mm preflight --venue <venue> --confirm LIVE` passes.
- `mm run --venue <venue> --confirm LIVE --once` submits at most one cycle of bounded post-only orders.
- `mm cancel-all --venue <venue> --confirm CANCEL_ALL` cancels all known open orders.
- Explorer/platform UI confirms no unexpected allowances or open orders remain.
