export const stateStoreSchemaSql = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  venue TEXT,
  severity TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  details_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  client_order_id TEXT PRIMARY KEY,
  external_id TEXT,
  venue TEXT NOT NULL,
  market_id TEXT,
  token_id TEXT NOT NULL,
  side TEXT NOT NULL,
  price REAL NOT NULL,
  size REAL NOT NULL,
  notional_usd REAL NOT NULL,
  status TEXT NOT NULL,
  mode TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  raw_json TEXT NOT NULL,
  size_matched REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS positions (
  venue TEXT NOT NULL,
  token_id TEXT NOT NULL,
  size REAL NOT NULL,
  notional_usd REAL NOT NULL,
  average_price REAL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (venue, token_id)
);

CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  name TEXT NOT NULL,
  value REAL NOT NULL,
  labels_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checkpoints (
  name TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  value_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_fills (
  venue TEXT NOT NULL,
  fill_id TEXT NOT NULL,
  order_id TEXT,
  token_id TEXT,
  market_id TEXT,
  side TEXT,
  price REAL,
  size REAL,
  notional_usd REAL NOT NULL,
  fee_usd REAL,
  realized_pnl_usd REAL,
  cashflow_usd REAL,
  fill_ts INTEGER NOT NULL,
  raw_json TEXT NOT NULL,
  PRIMARY KEY (venue, fill_id)
);

CREATE TABLE IF NOT EXISTS account_risk_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  venue TEXT NOT NULL,
  account TEXT NOT NULL,
  source TEXT NOT NULL,
  day_start INTEGER NOT NULL,
  equity_usd REAL,
  day_start_equity_usd REAL,
  realized_pnl_usd REAL,
  unrealized_pnl_usd REAL,
  net_cashflow_usd REAL,
  fees_usd REAL,
  warnings_json TEXT NOT NULL,
  raw_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_risk_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  venue TEXT NOT NULL,
  ok INTEGER NOT NULL,
  reason TEXT NOT NULL,
  message TEXT NOT NULL,
  details_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_ts_desc ON events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_venue_ts_desc ON events(venue, ts DESC);
CREATE INDEX IF NOT EXISTS idx_orders_updated_at_desc ON orders(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_venue_status_updated ON orders(venue, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_external_id ON orders(venue, external_id);
CREATE INDEX IF NOT EXISTS idx_checkpoints_ts_desc ON checkpoints(ts DESC);
CREATE INDEX IF NOT EXISTS idx_account_fills_venue_fill_ts ON account_fills(venue, fill_ts DESC);
CREATE INDEX IF NOT EXISTS idx_account_risk_snapshots_venue_ts ON account_risk_snapshots(venue, ts DESC);
CREATE INDEX IF NOT EXISTS idx_account_risk_decisions_venue_ts ON account_risk_decisions(venue, ts DESC);
`;
