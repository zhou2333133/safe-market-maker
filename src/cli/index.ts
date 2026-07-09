#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { existsSync } from 'node:fs';
import { Command } from 'commander';
import { defaultConfigPath, ensureDataDirs, loadConfig, saveConfig, writeDefaultConfig } from '../config/load.js';
import { appConfigSchema } from '../config/schema.js';
import { runGuidedInit } from './init-wizard.js';
import type { VenueName } from '../domain/types.js';
import { runPreflight } from '../execution/preflight.js';
import { ExecutionEngine } from '../execution/engine.js';
import { cancelAllLiveOrders } from '../execution/cancel-all.js';
import { withLiveContext } from '../execution/live-context.js';
import { logger } from '../observability/logger.js';
import { disabledPlugins } from '../plugins/registry.js';
import { importWallet, loadWalletSigner, normalizePrivateKey, saveCredential } from '../secrets/keystore.js';
import { readSecret } from '../secrets/prompt.js';
import { usingStore } from '../store/ui-store.js';
import { StrategyEngine } from '../strategy/strategy-engine.js';
import { startUiServer } from '../ui/server.js';
import { createVenue } from '../venues/factory.js';

const program = new Command();

program
  .name('mm')
  .description('Low-risk Predict.fun / Polymarket market maker CLI')
  .option('-c, --config <path>', 'config path', defaultConfigPath())
  .version('0.1.0');

program
  .command('init')
  .option('--guided', 'run a Chinese interactive configuration wizard')
  .description('create config.yaml and local data directories')
  .action(async (opts: { guided?: boolean }) => {
    const configPath = rootConfigPath();
    if (opts.guided) {
      const configExists = existsSync(configPath);
      const baseConfig = configExists ? loadConfig(configPath).config : appConfigSchema.parse({});
      const config = await runGuidedInit(baseConfig, configExists);
      saveConfig(configPath, config);
      const loaded = loadConfig(configPath);
      ensureDataDirs(loaded.dataDir);
      usingStore(loaded.dataDir).close();
      logger.info('Guided config saved', { configPath, dataDir: loaded.dataDir });
      return;
    }
    writeDefaultConfig(configPath);
    const loaded = loadConfig(configPath);
    ensureDataDirs(loaded.dataDir);
    usingStore(loaded.dataDir).close();
    logger.info('Initialized safe market maker project', { configPath, dataDir: loaded.dataDir });
  });

const wallet = program.command('wallet').description('encrypted wallet keystore commands');
wallet
  .command('import')
  .requiredOption('--venue <venue>', 'predict|polymarket')
  .description('import an isolated hot wallet into encrypted local keystore')
  .action(async (opts: { venue: string }) => {
    const venue = parseVenue(opts.venue);
    const loaded = loadConfig(rootConfigPath());
    ensureDataDirs(loaded.dataDir);

    console.log('');
    console.log(`${venue} 钱包导入分 3 步：`);
    console.log('1/3 粘贴隔离热钱包私钥：64 位十六进制，可带 0x；不是 API key、地址或助记词。');
    console.log('2/3 设置一个本机 keystore 加密密码：这是你自己记住的本机密码，不是平台密码；长度不限，但不能为空。');
    console.log('3/3 再输入一次同样的本机 keystore 加密密码，用来确认没有打错。');
    console.log('提示：输入会显示为 *，这是正常的隐藏输入。不要把真实私钥发给任何人。');
    console.log('');

    const privateKey = process.env.SAFE_MM_PRIVATE_KEY ?? await readSecret(`第 1/3 步：粘贴 ${venue} 钱包私钥（只输入一次，输入会显示为 *）: `);
    normalizePrivateKey(privateKey);
    const passphrase = await readNewPassphraseWithConfirm();
    const address = importWallet(loaded.dataDir, venue, privateKey, passphrase);
    logger.info('Wallet imported', { venue, address, path: loaded.dataDir });
  });

program
  .command('auth')
  .argument('[venue]', 'predict|polymarket', 'predict')
  .description('derive and store encrypted venue credentials')
  .action(async (venueArg: string) => {
    const venue = parseVenue(venueArg);
    const loaded = loadConfig(rootConfigPath());
    ensureDataDirs(loaded.dataDir);
    const passphrase = await readPassphrase();
    const signer = loadWalletSigner(loaded.dataDir, venue, passphrase);
    const adapter = createVenue(loaded.config, loaded.dataDir, venue);
    if (!adapter.authenticate) throw new Error(`${venue} does not support auth.`);
    const result = await adapter.authenticate(signer);
    saveCredential(loaded.dataDir, venue, result.name, result.credential, passphrase);
    logger.info(result.summary, { venue, credential: result.name });
  });

const approvals = program.command('approvals').description('inspect or grant token approvals');
approvals
  .command('inspect')
  .requiredOption('--venue <venue>', 'predict|polymarket')
  .option('--token-id <tokenId>', 'market token id for venue-specific allowance lookup')
  .description('inspect signer and approval state')
  .action(async (opts: { venue: string; tokenId?: string }) => {
    const venue = parseVenue(opts.venue);
    const loaded = loadConfig(rootConfigPath());
    const passphrase = await readPassphrase();
    const signer = loadWalletSigner(loaded.dataDir, venue, passphrase);
    const adapter = createVenue(loaded.config, loaded.dataDir, venue, passphrase);
    if (!adapter.inspectApprovals) throw new Error(`${venue} does not support approval inspection.`);
    console.log(JSON.stringify(await adapter.inspectApprovals(signer, opts.tokenId), null, 2));
  });

approvals
  .command('grant')
  .requiredOption('--venue <venue>', 'predict|polymarket')
  .requiredOption('--amount-usd <amount>', 'exact approval amount in USD units')
  .option('--token-id <tokenId>', 'Predict token id required to derive spender')
  .option('--include-conditional-tokens', 'also approve Polymarket outcome tokens for SELL orders')
  .option('--confirm <word>', 'must be APPROVE')
  .description('grant a bounded approval; never grants unlimited approval by default')
  .action(async (opts: { venue: string; amountUsd: string; tokenId?: string; includeConditionalTokens?: boolean; confirm?: string }) => {
    const venue = parseVenue(opts.venue);
    if (opts.confirm !== 'APPROVE') throw new Error('Approval grant requires --confirm APPROVE.');
    const loaded = loadConfig(rootConfigPath());
    const passphrase = await readPassphrase();
    const signer = loadWalletSigner(loaded.dataDir, venue, passphrase);
    const adapter = createVenue(loaded.config, loaded.dataDir, venue, passphrase);
    if (!adapter.grantApprovals) throw new Error(`${venue} does not support approval grants.`);
    const result = await adapter.grantApprovals(signer, {
      amountUsd: Number(opts.amountUsd),
      ...(opts.tokenId ? { tokenId: opts.tokenId } : {}),
      includeConditionalTokens: Boolean(opts.includeConditionalTokens),
      confirm: true
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('recommend')
  .requiredOption('--venue <venue>', 'predict|polymarket')
  .option('--top <n>', 'number of markets', '10')
  .option('--apply', 'write selected token ids to config')
  .option('--json', 'emit machine-readable JSON')
  .description('rank markets by rewards, liquidity, and risk flags')
  .action(async (opts: { venue: string; top: string; apply?: boolean; json?: boolean }) => {
    const venue = parseVenue(opts.venue);
    const loaded = loadConfig(rootConfigPath());
    const adapter = createVenue(loaded.config, loaded.dataDir, venue);
    const strategy = new StrategyEngine(loaded.config);
    const recommendations = strategy.recommend(await adapter.getMarkets(), Number(opts.top));
    if (opts.apply) {
      loaded.config.selectedMarkets[venue] = recommendations.map((rec) => rec.market.tokenId);
      saveConfig(loaded.configPath, loaded.config);
    }
    if (opts.json) {
      console.log(JSON.stringify({ venue, applied: Boolean(opts.apply), recommendations }, null, 2));
    } else {
      for (const [index, rec] of recommendations.entries()) {
        console.log(`${index + 1}. ${rec.market.tokenId} score=${rec.score.toFixed(1)} ${rec.market.question}`);
        console.log(`   reasons=${rec.reasons.join(', ') || '-'} flags=${rec.riskFlags.join(', ') || '-'}`);
      }
      if (opts.apply) logger.info('Applied recommended markets to config', { venue, count: recommendations.length });
    }
  });

program
  .command('preflight')
  .requiredOption('--venue <venue>', 'predict|polymarket')
  .option('--confirm <word>', 'must be LIVE')
  .description('run live preflight checks without starting the market maker')
  .action(async (opts: { venue: string; confirm?: string }) => {
    const venue = parseVenue(opts.venue);
    const passphrase = await readPassphrase();
    await withLiveContext(rootConfigPath(), venue, passphrase, async ({ config, dataDir, signer, store, adapter }) => {
      const preflight = await runPreflight({ config, dataDir, venue, confirm: opts.confirm, signer, store, adapter });
      console.log(JSON.stringify(preflight, null, 2));
      if (!preflight.ok) process.exitCode = 1;
    });
  });

program
  .command('run')
  .requiredOption('--venue <venue>', 'predict|polymarket')
  .option('--once', 'run one cycle then exit')
  .option('--confirm <word>', 'must be LIVE')
  .description('run live market making loop')
  .action(async (opts: { venue: string; once?: boolean; confirm?: string }) => {
    const venue = parseVenue(opts.venue);
    const passphrase = await readPassphrase();
    await withLiveContext(rootConfigPath(), venue, passphrase, async ({ config, dataDir, signer, store, adapter }) => {
      const preflight = await runPreflight({ config, dataDir, venue, confirm: opts.confirm, signer, store, adapter });
      console.log(JSON.stringify(preflight, null, 2));
      if (!preflight.ok) throw new Error('Preflight failed; refusing to run.');
      const engine = new ExecutionEngine(config, adapter, store);
      let keepRunning = true;
      while (keepRunning) {
        await engine.runOnce({ venue, signer });
        keepRunning = !opts.once;
        if (keepRunning) await sleep(config.strategy.quoteRefreshMs);
      }
    });
  });

program
  .command('cancel-all')
  .requiredOption('--venue <venue>', 'predict|polymarket')
  .option('--confirm <word>', 'must be CANCEL_ALL')
  .description('emergency cancel known live open orders')
  .action(async (opts: { venue: string; confirm?: string }) => {
    const venue = parseVenue(opts.venue);
    if (opts.confirm !== 'CANCEL_ALL') throw new Error('Live cancel requires --confirm CANCEL_ALL.');
    const passphrase = await readPassphrase();
    await withLiveContext(rootConfigPath(), venue, passphrase, async ({ config, dataDir, signer, store, adapter }) => {
      const result = await cancelAllLiveOrders({
        config,
        dataDir,
        venue,
        confirm: opts.confirm,
        signer,
        store,
        adapter,
        eventType: 'cancel-all'
      });
      console.log(JSON.stringify(result.preflight, null, 2));
      if (!result.ok) throw new Error('Cancel-all preflight failed; refusing to submit cancels.');
      logger.warn('Submitted cancel-all', { venue, ids: result.ids });
    });
  });

program
  .command('status')
  .description('show local state and disabled plugin status')
  .action(async () => {
    const loaded = loadConfig(rootConfigPath());
    ensureDataDirs(loaded.dataDir);
    const store = usingStore(loaded.dataDir);
    try {
      console.log(JSON.stringify({ ...store.status(), disabledPlugins }, null, 2));
    } finally {
      store.close();
    }
  });

program
  .command('ui')
  .option('--port <port>', 'local UI port', '8789')
  .option('--host <host>', 'local UI host', '127.0.0.1')
  .option('--allow-remote-ui', 'allow binding the UI to a non-loopback host')
  .description('start the local web UI on 127.0.0.1')
  .action(async (opts: { port: string; host: string; allowRemoteUi?: boolean }) => {
    const port = Number(opts.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('Invalid UI port.');
    const handle = await startUiServer(rootConfigPath(), {
      host: opts.host,
      port,
      allowRemote: Boolean(opts.allowRemoteUi)
    });
    logger.info('Safe Market Maker UI started', { url: handle.url });
    console.log(`\nSafe Market Maker UI: ${handle.url}\n`);
  });

program.parseAsync(process.argv).catch((error) => {
  logger.error(error instanceof Error ? error.message : String(error), { stack: error instanceof Error ? error.stack : undefined });
  process.exitCode = 1;
});

function rootConfigPath(): string {
  return path.resolve(program.opts<{ config: string }>().config);
}

function parseVenue(value: string): VenueName {
  if (value === 'predict' || value === 'polymarket') return value;
  throw new Error(`Invalid venue: ${value}`);
}

async function readPassphrase(): Promise<string> {
  return process.env.SAFE_MM_PASSPHRASE ?? await readSecret('本机 keystore 加密密码（不是平台密码，用来解锁本地加密私钥）: ');
}

async function readNewPassphraseWithConfirm(): Promise<string> {
  const first = process.env.SAFE_MM_PASSPHRASE ?? await readSecret('第 2/3 步：设置本机 keystore 加密密码（长度不限，但不能为空；不是私钥）: ');
  if (!first) throw new Error('本机 keystore 加密密码不能为空。长度已经不限制，但至少要输入一个字符。');
  if (process.env.SAFE_MM_PASSPHRASE) return first;
  const second = await readSecret('第 3/3 步：再次输入同一个本机 keystore 加密密码（不是私钥）: ');
  if (!second) throw new Error('本机 keystore 加密密码不能为空。长度已经不限制，但至少要输入一个字符。');
  if (first !== second) {
    throw new Error('第 2/3 步和第 3/3 步输入的本机 keystore 加密密码不一致。请重新运行 wallet import；后两步输入的是你设置的本机密码，不是私钥。');
  }
  return first;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
