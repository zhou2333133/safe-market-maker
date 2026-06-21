# Project Rules

- Reply in Chinese by default.
- This project is `safe-market-maker`; operational process rules below apply only to this robot, not to sibling projects in `C:\Users\Administrator\Documents\New project 3`.
- The local UI process must be unique for this robot. Before starting `node dist/src/cli/index.js ui ...`, check for an existing `safe-market-maker` UI process. Reuse the existing URL or stop the old same-project UI process before starting another one.
- After any code change that can affect runtime behavior, automatically restart this robot without waiting for another user prompt: run focused verification, stop the old same-project UI/backend process, start the updated app on port `8789`, verify that exactly one same-project listener owns the port, and confirm `/api/status` returns the new running state.
- Do not kill Node, UI, trading, or development processes from other projects while enforcing the UI uniqueness rule.
- Do not interpret "唯一进程" as a trading-entry, market, or position rule. Trading strategy settings such as `quoteSide`, `dualSide`, `maxMarkets`, and order sizing remain separate unless the user explicitly asks to change them.
- Small live-test orders are intentional when `strategy.enforceRewardMinimum=false`. Do not treat orders below the platform PP minimum shares as a bug in that mode, and do not "fix" it by forcing larger orders.
- Do not change ENV/API-key/credential loading unless the user explicitly asks for secret handling work in that turn.
- Understand-Anything may be used as a local codebase knowledge graph aid. Keep `.understand-anything/` local and untracked; do not enable automatic commit hooks unless the user explicitly asks.
- In Predict.fun cash mode, `risk.orderSizeUsd` is the per single-leg maker target amount. In split paired SELL mode, it is the hard total notional budget for the complete YES/NO SELL group when `enforceRewardMinimum=false`; equalized paired SELL shares should keep the two-leg total around `orderSizeUsd`, not per leg.
- Predict.fun live PP strategy must exclude already-started short sports/event markets. Do not relax `shortEventMaxDurationMs`, `eventStartNoNewOrdersMs`, or started-event blocking just to chase high PP.
- Points-only Predict.fun routes require official `rewards.maxSpreadCents`; missing reward spread means the bot cannot verify the PP-eligible range and must skip the market.
- Cash single-leg routing is allowed for gas-light PP making: do not call split/merge in cash mode, route each token/outcome/side independently by expected PP at the configured target amount, and only place SELL when inventory exists. Split entry remains an optional paired mode: create complete YES/NO inventory, then place paired SELL maker orders. In split mode, if either leg cannot be safely quoted or maintained, do not leave a single active leg; cancel the managed pair.
- Live orderbook freshness is intentionally tight, around 1-2 seconds. Do not restore 10-second stale-book behavior for live PP quoting.
