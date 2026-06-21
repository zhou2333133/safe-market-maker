import type { AppConfig } from '../config/schema.js';
import { venueLiveEnabled } from '../config/live-enabled.js';
import type { PreflightResult, VenueName } from '../domain/types.js';
import type { SignerProvider } from '../secrets/signer.js';
import { hasWallet } from '../secrets/keystore.js';
import { hasRuntimePrivateKey, runtimePrivateKeyEnvName } from '../secrets/runtime.js';
import type { StateStore } from '../store/sqlite.js';
import type { VenueAdapter } from '../venues/types.js';

export interface LiveGateInput {
  config: AppConfig;
  dataDir: string;
  venue: VenueName;
  confirm?: string;
  signer?: SignerProvider;
  store: StateStore;
  adapter: VenueAdapter;
  expectedConfirm?: string;
  skipConfirm?: boolean;
  requireSelectedMarkets?: boolean;
  requireLiveEnabled?: boolean;
  preflightTimeoutMs?: number;
  softNetworkChecks?: boolean;
}

export async function runPreflight(input: LiveGateInput): Promise<PreflightResult> {
  const checks: PreflightResult['checks'] = [];
  const expectedConfirm = input.expectedConfirm ?? 'LIVE';
  const requireSelectedMarkets = input.requireSelectedMarkets ?? !input.config.strategy.autoSelectMarkets;
  const requireLiveEnabled = input.requireLiveEnabled ?? true;
  const liveEnabled = venueLiveEnabled(input.config, input.venue);
  const timeoutMs = input.preflightTimeoutMs ?? 8000;
  checks.push({ name: 'mode', ok: true, message: 'live' });
  checks.push({
    name: 'live-confirm',
    ok: input.skipConfirm || input.confirm === expectedConfirm,
    message: input.skipConfirm ? 'not required for local UI action' : input.confirm === expectedConfirm ? expectedConfirm : `requires ${expectedConfirm}`
  });
  checks.push({
    name: 'live-config',
    ok: !requireLiveEnabled || liveEnabled,
    message: requireLiveEnabled
      ? `liveEnabled=${liveEnabled}`
      : `not required for this action; liveEnabled=${liveEnabled}`
  });
  const runtimeKey = hasRuntimePrivateKey(input.venue, input.dataDir);
  const wallet = hasWallet(input.dataDir, input.venue);
  checks.push({
    name: 'wallet-signer-source',
    ok: runtimeKey || wallet,
    message: runtimeKey ? `${runtimePrivateKeyEnvName(input.venue)} loaded` : wallet ? 'encrypted keystore available' : 'missing runtime private key'
  });
  checks.push({
    name: 'signer',
    ok: Boolean(input.signer),
    message: input.signer?.address ?? 'not loaded'
  });
  const selectedCount = input.config.selectedMarkets[input.venue].length;
  checks.push({
    name: 'selected-markets',
    ok: !requireSelectedMarkets || selectedCount > 0,
    message: selectedCount > 0
      ? `${selectedCount} selected`
      : requireSelectedMarkets
        ? 'live mode requires selected markets; run recommend --apply or edit config'
        : input.config.strategy.autoSelectMarkets
          ? 'auto PP routing enabled; selectedMarkets not required'
          : 'not required for this live action'
  });
  checks.push({ name: 'risk-order-size', ok: input.config.risk.orderSizeUsd <= input.config.risk.maxSingleOrderUsd, message: `${input.config.risk.orderSizeUsd}/${input.config.risk.maxSingleOrderUsd}` });
  checks.push({ name: 'store', ok: true, message: JSON.stringify(input.store.status()) });
  const connectionOk = await withTimeout(input.adapter.testConnection(), timeoutMs, false);
  checks.push({
    name: 'venue-connection',
    ok: connectionOk || Boolean(input.softNetworkChecks),
    message: connectionOk
      ? input.venue
      : input.softNetworkChecks
        ? `warning: connection check failed or timed out after ${timeoutMs}ms; live loop will retry and will not place orders unless market/orderbook sync succeeds`
        : `connection check failed or timed out after ${timeoutMs}ms`
  });
  let makerAddress = input.signer?.address;
  if (!input.signer) {
    checks.push({ name: 'venue-live-preflight', ok: false, message: 'signer missing' });
  } else if (!input.adapter.preflight) {
    checks.push({ name: 'venue-live-preflight', ok: false, message: 'adapter does not expose live preflight' });
  } else {
    const venuePreflight = await withTimeout(
      input.adapter.preflight(input.signer, input.config.selectedMarkets[input.venue]),
      timeoutMs,
      undefined
    );
    if (!venuePreflight) {
      checks.push({
        name: 'venue-live-preflight',
        ok: Boolean(input.softNetworkChecks),
        message: input.softNetworkChecks
          ? `warning: timed out after ${timeoutMs}ms; live loop will retry before placing orders`
          : `timed out after ${timeoutMs}ms`
      });
    } else {
      makerAddress = venuePreflight.makerAddress ?? makerAddress;
      checks.push(...venuePreflight.checks.map((check) => ({ ...check, name: `venue:${check.name}` })));
    }
  }
  if (input.signer && input.adapter.inspectApprovals) {
    const approval = await withTimeout(
      input.adapter.inspectApprovals(input.signer, input.config.selectedMarkets[input.venue][0]),
      timeoutMs,
      undefined
    );
    if (!approval) {
      checks.push({ name: 'approval-inspection', ok: false, message: `timed out after ${timeoutMs}ms` });
    } else {
      checks.push(...approval.checks.map((check) => ({ ...check, name: `approval:${check.name}` })));
    }
  }
  return {
    ok: checks.every((check) => check.ok),
    venue: input.venue,
    signerAddress: input.signer?.address,
    makerAddress,
    checks
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, timeoutValue: T): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => resolve(timeoutValue), ms);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
