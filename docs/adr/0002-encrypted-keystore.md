# ADR-0002: Encrypted Keystore

## Status
Accepted

## Context
Raw private keys in `.env` are easy to leak via logs, sync folders, backups, support bundles, and compromised renderers.

## Decision
Store wallet private keys only in encrypted keystore files. The signer abstraction exposes address and signing methods, not raw key material.

## Consequences
Operators must unlock at runtime. This adds friction, but sharply reduces accidental key disclosure.
