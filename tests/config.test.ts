import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, saveConfig } from '../src/config/load.js';
import { appConfigSchema, assertEndpointAllowed, assertNoRawSecrets, normalizeLiveStrategyConfig } from '../src/config/schema.js';

describe('config schema', () => {
  it('rejects raw private key fields anywhere in config', () => {
    expect(() => assertNoRawSecrets({ venues: { predict: { privateKey: 'not allowed' } } })).toThrow(/Raw secret/);
    expect(() => assertNoRawSecrets({ nested: { mnemonic: 'not allowed' } })).toThrow(/Raw secret/);
    expect(() => assertNoRawSecrets({ nested: { seed_phrase: 'not allowed' } })).toThrow(/Raw secret/);
  });

  it('allows only known endpoints by default', () => {
    const config = appConfigSchema.parse({});
    expect(() => assertEndpointAllowed('https://api.predict.fun/v1/markets', config)).not.toThrow();
    expect(() => assertEndpointAllowed(config.venues.polymarket.rpcUrl, config)).not.toThrow();
    expect(() => assertEndpointAllowed('https://example.invalid', config)).toThrow(/not allowed/);
  });

  it('defaults new configurations to hold after fills', () => {
    const config = appConfigSchema.parse({});
    expect(config.strategy.onFillAction).toBe('hold');
  });

  it('defaults new configurations to cash single-leg PP entry', () => {
    const config = appConfigSchema.parse({});
    expect(config.strategy.entryMode).toBe('cash');
    expect(config.strategy.quoteSide).toBe('buy');
    expect(config.strategy.dualSide).toBe(false);
    expect(config.strategy.minMarketLiquidityUsd).toBe(0);
    expect(config.strategy.minRewardLevel).toBe(0);
  });

  it('preserves runtime cash single-leg settings while forcing safe hold-on-fill', () => {
    const config = normalizeLiveStrategyConfig(appConfigSchema.parse({
      strategy: { entryMode: 'cash', quoteSide: 'buy', dualSide: false, onFillAction: 'sellAllAtMarket', enforceRewardMinimum: false }
    }));

    expect(config.strategy).toMatchObject({
      entryMode: 'cash',
      quoteSide: 'buy',
      dualSide: false,
      enforceRewardMinimum: true,
      onFillAction: 'hold'
    });
  });

  it('normalizes split runtime strategy to paired inventory settings', () => {
    const config = normalizeLiveStrategyConfig(appConfigSchema.parse({
      strategy: { entryMode: 'split', quoteSide: 'buy', dualSide: false, onFillAction: 'sellAllAtMarket' }
    }));

    expect(config.strategy).toMatchObject({
      entryMode: 'split',
      quoteSide: 'both',
      dualSide: true,
      onFillAction: 'hold'
    });
  });

  it('loads and saves cash configs without silently converting them to split inventory', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-config-'));
    const configPath = path.join(dir, 'config.yaml');
    try {
      saveConfig(configPath, appConfigSchema.parse({
        dataDir: '.safe-mm',
        strategy: { entryMode: 'cash', quoteSide: 'sell', dualSide: false, onFillAction: 'sellAllAtMarket' }
      }));

      const raw = readFileSync(configPath, 'utf8');
      expect(raw).toContain('entryMode: cash');
      expect(raw).toContain('quoteSide: sell');
      expect(raw).toContain('dualSide: false');
      expect(raw).toContain('onFillAction: hold');
      expect(loadConfig(configPath).config.strategy).toMatchObject({
        entryMode: 'cash',
        quoteSide: 'sell',
        dualSide: false,
        onFillAction: 'hold'
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
