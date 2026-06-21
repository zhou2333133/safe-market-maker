// Live watcher: polls the state store and prints one line per notable event (used by the session Monitor).
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '.safe-mm/state.sqlite'), { readonly: true, fileMustExist: true });
let lastEventId = (db.prepare('SELECT MAX(id) m FROM events').get().m ?? 0);
let knownOrders = new Set(db.prepare("SELECT client_order_id FROM orders").all().map((r) => r.client_order_id));
const WATCH_TYPES = [
  'quote.replace-cancel', 'quote.new-orders-paused', 'risk.daily-loss-limit', 'risk.account-gate.blocked',
  'cash.fill-circuit-breaker', 'cash.exit', 'split', 'ui.live.risk-stop', 'ui.live.retrying', 'ui.live.loop.stopped',
  'route.selection'
];
function tick() {
  try {
    const events = db.prepare('SELECT id, ts, venue, severity, type, message FROM events WHERE id > ? ORDER BY id ASC LIMIT 200').all(lastEventId);
    for (const e of events) {
      lastEventId = e.id;
      if (e.venue !== 'polymarket') continue;
      const watched = e.severity === 'error' || WATCH_TYPES.some((t) => String(e.type).startsWith(t));
      if (!watched) continue;
      if (String(e.type) === 'route.selection' && String(e.message).includes('没有可挂单')) continue;
      console.log(`${new Date(Number(e.ts)).toISOString().slice(11, 19)} [${e.severity}] ${e.type} | ${String(e.message || '').slice(0, 90)}`);
    }
    const orders = db.prepare("SELECT client_order_id, side, price, size, notional_usd, status, token_id FROM orders WHERE venue='polymarket'").all();
    for (const o of orders) {
      if (knownOrders.has(o.client_order_id)) continue;
      knownOrders.add(o.client_order_id);
      console.log(`ORDER-NEW ${o.side} px=${o.price} size=${o.size} $${o.notional_usd} ${o.status} token=${String(o.token_id).slice(0, 14)}...`);
    }
  } catch (error) {
    console.log('watcher-error: ' + (error && error.message ? error.message : String(error)).slice(0, 80));
  }
}
setInterval(tick, 4000);
tick();
