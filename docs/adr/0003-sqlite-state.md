# ADR-0003: SQLite State Store

## Status
Accepted

## Context
The bot needs recoverable order state, audit events, risk events, and metrics. JSON files are hard to query and fragile under concurrent writes.

## Decision
Use SQLite for local state, migrations, order ledger, risk event ledger, metrics, and checkpoints.

## Consequences
The project gains a native dependency, but recovery and auditability improve substantially.
