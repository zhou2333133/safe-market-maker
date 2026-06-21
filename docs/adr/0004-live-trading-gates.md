# ADR-0004: Strong Live Trading Gates

## Status
Accepted

## Context
Accidental live trading is one of the highest user-loss risks in a market-making bot.

## Decision
Runtime execution is live-only. Live trading still requires config opt-in, explicit confirmation, wallet unlock, venue credentials, selected markets, and successful preflight before any order submission.

## Consequences
Live startup is slower and more explicit. This is intentional.
