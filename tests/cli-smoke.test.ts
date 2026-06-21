import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('CLI smoke', () => {
  it('initializes config and reports empty status', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-cli-'));
    const configPath = path.join(dir, 'config.yaml');
    try {
      execFileSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', '--config', configPath, 'init'], {
        cwd: process.cwd(),
        encoding: 'utf8'
      });
      const output = execFileSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', '--config', configPath, 'status'], {
        cwd: process.cwd(),
        encoding: 'utf8'
      });
      expect(output).toContain('"openOrders": 0');
      expect(output).toContain('"cross-platform-arbitrage"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);

  it('runs guided init from scripted answers', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-cli-guided-'));
    const configPath = path.join(dir, 'config.yaml');
    const answers = [
      '.safe-mm',
      'both',
      'n',
      'https://api.predict.fun',
      'wss://ws.predict.fun/ws',
      'https://bsc-dataseed.binance.org',
      '56',
      'clear',
      '',
      'https://gamma-api.polymarket.com',
      'https://clob.polymarket.com',
      '137',
      '',
      '0',
      'y',
      'test',
      '5',
      '5',
      '20',
      '10',
      '120000',
      '2',
      '25',
      '1800000',
      '600000',
      'y',
      '20',
      '2',
      '1',
      '1500',
      '25',
      '0.08',
      '0.92',
      '80',
      '600',
      'y',
      'conservative',
      'y',
      'y',
      '10000',
      '4',
      '1',
      'y',
      '10000',
      '60000',
      '4',
      '3',
      '1',
      '1',
      'y',
      'sellAllAtMarket',
      '2',
      '10',
      '0.0001',
      '1',
      'y',
      '50',
      'y',
      '2',
      'n',
      'n'
    ].join('\n') + '\n';
    try {
      execFileSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', '--config', configPath, 'init', '--guided'], {
        cwd: process.cwd(),
        input: answers,
        encoding: 'utf8'
      });
      const config = readFileSync(configPath, 'utf8');
      expect(config).toContain('liveEnabled: false');
      expect(config).toContain('orderSizeUsd: 5');
      expect(config).toContain('tradingMode: conservative');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
