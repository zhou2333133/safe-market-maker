# Threat Model: Safe Market Maker

## Assets

- Wallet private keys
- Predict JWT and API key
- Polymarket CLOB API secret and passphrase
- Token approvals and spender allowances
- Open orders and account balances
- Operator configuration and selected markets

## Trust Boundaries

- CLI operator input to configuration and keystore
- Local encrypted keystore to in-memory signer
- Strategy engine to risk engine
- Risk engine to live venue adapters
- Venue adapters to external APIs and RPC endpoints
- SQLite state to recovery and audit views

## Primary Threats

- Private-key disclosure via plaintext config, logs, stack traces, backups, or UI layers
- Accidental live trading through misconfiguration or an exposed local browser session
- Malicious or compromised npm dependency signing unauthorized payloads
- Endpoint substitution causing hostile auth challenges or false market data
- Stale orderbook data causing unsafe quotes
- Crash/restart leaving stale live orders unmanaged
- Excessive approvals increasing loss blast radius

## Controls

- No raw private key fields accepted in config
- Encrypted keystore and runtime unlock
- Global secret redaction for logs and events
- Endpoint allowlist by default
- Runtime is live-only, with explicit confirmation, live config opt-in, wallet, credential, selected-market, and preflight gates
- UI is loopback-only by default and does not import raw private keys
- Pre-submit risk checks and final orderbook freshness check
- SQLite order ledger and recovery checkpoint
- Explicit approval inspection/grant commands
- Disabled plugin boundary for unaudited integrations
