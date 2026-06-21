# ADR-0005: Dual Platform First

## Status
Accepted

## Context
The visible product promise is Predict.fun and Polymarket market making. The reference source also contains Opinion and cross-platform execution code.

## Decision
Implement Predict.fun and Polymarket first. Opinion and cross-platform arbitrage remain disabled plugin extension points until separately audited.

## Consequences
The core product is covered while the riskiest execution paths stay out of the first release.
