# ADR-0001: CLI Core First

## Status
Accepted

## Context
The reference project mixes CLI behavior, Electron UI, signing, strategy, market recommendation, and release packaging. That makes the private-key attack surface too wide.

## Decision
Implement a TypeScript Node 20 CLI core first. UI can be added later only as a client of the CLI/local API and must never directly access private keys.

## Consequences
The first version is easier to audit and test, but does not provide the original desktop experience.
