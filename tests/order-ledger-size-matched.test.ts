import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { OrderLedgerRepository } from '../src/store/order-ledger-repository.js';
import { stateStoreSchemaSql } from '../src/store/schema.js';
import type { OrderIntent, OrderResult } from '../src/domain/types.js';

function newRepo(): { db: Database.Database; repo: OrderLedgerRepository } {
  const db = new Database(':memory:');
  db.exec(stateStoreSchemaSql);
  // Mirror the production ALTER TABLE migration in case schema.ts version skew during tests:
  const cols = new Set((db.prepare('PRAGMA table_info(orders)').all() as Array<{ name: string }>).map((r) => r.name));
  if (!cols.has('size_matched')) db.exec('ALTER TABLE orders ADD COLUMN size_matched REAL NOT NULL DEFAULT 0');
  return { db, repo: new OrderLedgerRepository(db) };
}

function intent(clientOrderId: string, externalId: string, size: number): OrderIntent {
  return {
    venue: 'polymarket',
    tokenId: 'tokA',
    side: 'BUY',
    price: 0.5,
    size,
    notionalUsd: 0.5 * size,
    clientOrderId,
    reason: 'test',
    postOnly: true,
    market: {
      venue: 'polymarket',
      tokenId: 'tokA',
      marketId: 'mkt',
      conditionId: 'c1',
      question: 'Q',
      outcome: 'Yes',
      outcomeIndex: 0,
      outcomeCount: 2,
      volume24hUsd: 0,
      liquidityUsd: 0,
      acceptingOrders: true,
      negRisk: false,
      feeRateBps: 0,
      tickSize: 0.01,
      rewards: { enabled: true }
    } as any
  } as OrderIntent;
}

function result(clientOrderId: string, externalId: string, status: string): OrderResult {
  return {
    venue: 'polymarket',
    clientOrderId,
    externalId,
    status: status as any,
    raw: {}
  } as OrderResult;
}

describe('OrderLedgerRepository.applyFillSizeUpdate — idempotent partial/full fill ledgering', () => {
  it('marks a fully-filled OPEN order as FILLED and updates size_matched', () => {
    const { db, repo } = newRepo();
    repo.recordPlannedOrder(intent('c1', '0xext1', 100), 'live');
    repo.recordOrderResult(result('c1', '0xext1', 'OPEN'));
    expect(repo.applyFillSizeUpdate('polymarket', '0xext1', 100)).toBe(true);
    const row = db.prepare('SELECT status, size_matched FROM orders WHERE client_order_id=?').get('c1') as any;
    expect(row.status).toBe('FILLED');
    expect(row.size_matched).toBe(100);
  });

  it('marks a partial fill (size_matched < size) and keeps status OPEN', () => {
    const { db, repo } = newRepo();
    repo.recordPlannedOrder(intent('c1', '0xext1', 100), 'live');
    repo.recordOrderResult(result('c1', '0xext1', 'OPEN'));
    expect(repo.applyFillSizeUpdate('polymarket', '0xext1', 40)).toBe(true);
    const row = db.prepare('SELECT status, size_matched FROM orders WHERE client_order_id=?').get('c1') as any;
    expect(row.status).toBe('OPEN');
    expect(row.size_matched).toBe(40);
  });

  it('returns false (does nothing) when the new filledSize is not larger than the recorded size_matched', () => {
    const { db, repo } = newRepo();
    repo.recordPlannedOrder(intent('c1', '0xext1', 100), 'live');
    repo.recordOrderResult(result('c1', '0xext1', 'OPEN'));
    repo.applyFillSizeUpdate('polymarket', '0xext1', 40);
    // Stale duplicate WS event arrives:
    expect(repo.applyFillSizeUpdate('polymarket', '0xext1', 40)).toBe(false);
    expect(repo.applyFillSizeUpdate('polymarket', '0xext1', 30)).toBe(false);
    const row = db.prepare('SELECT size_matched FROM orders WHERE client_order_id=?').get('c1') as any;
    expect(row.size_matched).toBe(40); // unchanged
  });

  it('returns false when the external_id is not in the ledger (avoids creating ghost rows)', () => {
    const { repo } = newRepo();
    expect(repo.applyFillSizeUpdate('polymarket', '0xnone', 50)).toBe(false);
  });

  it('reconcileOpenOrders marks a missing order with size_matched > 0 as FILLED, not CANCELED', () => {
    const { db, repo } = newRepo();
    repo.recordPlannedOrder(intent('c1', '0xext1', 100), 'live');
    repo.recordOrderResult(result('c1', '0xext1', 'OPEN'));
    // Mark the order as 100% filled BEFORE the next reconcile (simulating WS push between cycles).
    repo.applyFillSizeUpdate('polymarket', '0xext1', 100);
    // Now reconcile: venue returns an EMPTY open-orders list because the order is gone (filled).
    repo.reconcileOpenOrders('polymarket', [], 'live');
    const row = db.prepare('SELECT status FROM orders WHERE client_order_id=?').get('c1') as any;
    expect(row.status).toBe('FILLED');
  });

  it('reconcileOpenOrders STILL marks a missing order with size_matched == 0 as CANCELED (old behaviour preserved)', () => {
    const { db, repo } = newRepo();
    repo.recordPlannedOrder(intent('c1', '0xext1', 100), 'live');
    repo.recordOrderResult(result('c1', '0xext1', 'OPEN'));
    // No fills applied — order is just gone (we cancelled it).
    repo.reconcileOpenOrders('polymarket', [], 'live');
    const row = db.prepare('SELECT status FROM orders WHERE client_order_id=?').get('c1') as any;
    expect(row.status).toBe('CANCELED');
  });
});
