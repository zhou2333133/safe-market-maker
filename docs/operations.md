# Operations Runbook

## First-Time Setup

```bash
npm ci
npm run build
node dist/src/cli/index.js init --guided
```

Edit `config.yaml` only for non-private configuration such as platform API key fields, account/funder addresses, selected markets, and risk limits. Never add private keys, seed phrases, cookies, or platform secrets to config.

## Runtime Signer

Use a fresh isolated hot wallet with only the funds you accept losing.

```bash
SAFE_MM_PREDICT_PRIVATE_KEY="<isolated-hot-wallet-private-key>" node dist/src/cli/index.js ui --port 8789
```

On first start, the UI server reads the runtime private key from env and encrypts it into `.safe-mm/runtime-secrets/`. Later starts can run without the env variable:

```bash
node dist/src/cli/index.js ui --port 8789
```

The private key is never written to `config.yaml`. Legacy `wallet import` keystore commands remain for CLI compatibility, but the UI path uses the runtime signer vault.

## Authentication

```bash
node dist/src/cli/index.js auth predict
node dist/src/cli/index.js auth polymarket
```

Credentials are encrypted under `.safe-mm/credentials/`.

## Live Runtime Sequence

1. Apply a small reviewed market set.
2. Inspect approvals and balances.
3. Enable `liveEnabled: true` only after review.
4. Run live preflight.
5. Start live from the UI or CLI.
6. Stop without canceling, or stop-and-cancel when you want open orders removed.

```bash
node dist/src/cli/index.js recommend --venue predict --top 3 --apply
node dist/src/cli/index.js approvals inspect --venue predict --token-id <token>
node dist/src/cli/index.js preflight --venue predict --confirm LIVE
node dist/src/cli/index.js run --venue predict --confirm LIVE --once
```

The live run refuses to start unless selected markets exist in `config.yaml`.

## Local UI

```bash
node dist/src/cli/index.js ui --port 8789
```

Open `http://127.0.0.1:8789/`.

- Start live and stop-and-cancel in the UI use the runtime signer vault. No keystore password is entered in the UI.
- The UI also lets the operator adjust the live-enabled gate, order size, explicit risk caps, quote side, quote mode, depth level, retreat ticks, settlement windows, minimum liquidity, max market count, and points-only filtering.
- Changing order size in the UI does not silently raise `maxSingleOrderUsd` or `maxPositionUsd`; risk caps must be changed explicitly. In strict PP mode, the configured order size is also the real budget cap, so markets that require more than that for the minimum shares plus one are skipped.
- The dashboard shows the current loop stage, recent structured reject reasons, settlement/end-time guard status, selected group expected PP, best group expected PP, reward-band depth, and current-versus-best route comparison. In cash mode, PP/hr/kUSD is the primary basket ranking metric for 101-share single-leg orders. Its denominator is the same market group's YES/NO reward-band competition depth for the selected side plus the candidate order amount, so low-competition markets can outrank higher headline PP/hr markets. Expected PP share and PP/hr/kUSD are estimated, non-official metrics derived from official reward PP/hr plus current reward-band orderbook depth.
- Auto PP routing performs full market metadata discovery first, then tiered orderbook scans: active currently managed tokens, hot high-potential candidates, and rotating explore candidates. `candidateLimit` controls the hot scan budget; it no longer means "only consider this many markets". The bot also runs a periodic full orderbook scan across all official eligible markets so current-versus-best decisions are regularly based on whole-site coverage, not only the latest tiered sample.
- Short-event markets also use the event start time as a hard safety input. When a market duration is shorter than `risk.shortEventMaxDurationMs`, the bot blocks new orders near `risk.eventStartNoNewOrdersMs`, cancels managed open orders near `risk.eventStartCancelOpenOrdersMs`, and blocks already-started events even if the reward window is still active.
- Startup facts show available balance, reserved balance, estimated open-order occupation, platform frozen balance when exposed, split-entry readiness, and the freeze-drift status. When a venue exposes both available and total balance, the available balance is treated as already net of frozen funds; the estimated open-order occupation is then used for drift validation rather than deducted a second time.
- UI status responses expose only whether the Predict API key is configured, not the key value. SQLite audit events and JSON logger output redact sensitive keys and sensitive message substrings such as JWTs, Bearer tokens, and private-key-shaped values. Public market identifiers such as `tokenId` remain visible so route and order diagnostics stay usable.
- Predict balance display first tries the platform balance API, then falls back to the configured account's on-chain USDT balance on BNB Chain.
- CLI commands still keep explicit `--confirm` flags.

The UI imports runtime private keys only from process env and immediately persists them as an encrypted local vault.

## Emergency Cancel

```bash
node dist/src/cli/index.js cancel-all --venue predict --confirm CANCEL_ALL
```

The command merges locally known orders and remotely synced orders before submitting cancels. Emergency cancel does not require selected markets, but it still requires the wallet, venue credentials, and successful cancel preflight.

## Preflight Checks

Live startup checks include:

- runtime signer exists from env or encrypted local runtime vault
- configured endpoints are allowlisted unless explicitly overridden
- venue connectivity
- Predict JWT or Polymarket CLOB credentials where required
- open order sync
- selected markets for live run
- SQLite writable state
- risk order size does not exceed configured single-order limit
- stablecoin balance, open-order reservation estimate, and platform frozen-balance drift when the venue exposes frozen balance
- market end-time and short-event start-time guards pass; unknown end times, near-settlement windows, near-start windows, and already-started short events fail closed for new maker orders
- Predict native gas, USDT balance, and allowance when a token is selected
- Polymarket CLOB V2 version, official geoblock result, Polygon POL gas, direct pUSD balance, pUSD allowances, CTF operator approvals, and open-order sync

Polymarket production collateral is Polygon pUSD at `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`. A fresh EOA uses `signatureType: 0` with an empty `funderAddress`; the client derives nonce-0 CLOB credentials before attempting creation. Approval grants are bounded for pUSD, while CTF uses the ERC-1155 operator approval required for SELL/cancel-exit flows. Fully blocked and close-only regions fail closed. Japan is documented as frontend-only, so the API path is allowed only when the authenticated CLOB status also reports `closed_only=false`.

## Residual Dependency Risk

`npm audit --audit-level=moderate` must pass before live use.
