import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { appConfigSchema, assertEndpointAllowed, assertNoRawSecrets, normalizeLiveStrategyConfig, type AppConfig } from './schema.js';
import { ensurePolymarketParams, ensurePredictParams, stripVenuePrefixedStrategy } from './venue-config.js';

export interface LoadedConfig {
  config: AppConfig;
  configPath: string;
  dataDir: string;
}

export function defaultConfigPath(cwd = process.cwd()): string {
  return path.join(cwd, 'config.yaml');
}

export function loadConfig(configPath = defaultConfigPath()): LoadedConfig {
  let raw: unknown = {};
  if (existsSync(configPath)) {
    raw = YAML.parse(readFileSync(configPath, 'utf8')) ?? {};
  }
  assertNoRawSecrets(raw);
  const config = ensurePredictParams(ensurePolymarketParams(normalizeLiveStrategyConfig(appConfigSchema.parse(raw))));
  assertEndpointAllowed(config.venues.predict.apiBaseUrl, config);
  assertEndpointAllowed(config.venues.predict.wsUrl, config);
  assertEndpointAllowed(config.venues.predict.rpcUrl, config);
  assertEndpointAllowed(config.venues.polymarket.gammaUrl, config);
  assertEndpointAllowed(config.venues.polymarket.clobUrl, config);
  assertEndpointAllowed(config.venues.polymarket.dataApiUrl, config);
  assertEndpointAllowed(config.venues.polymarket.rpcUrl, config);
  assertEndpointAllowed(config.venues.polymarket.wsUrl, config);
  const dataDir = path.resolve(path.dirname(configPath), config.dataDir);
  return { config, configPath: path.resolve(configPath), dataDir };
}

export function writeDefaultConfig(configPath = defaultConfigPath()): void {
  if (existsSync(configPath)) {
    throw new Error(`Config already exists: ${configPath}`);
  }
  const config = normalizeLiveStrategyConfig(appConfigSchema.parse({}));
  mkdirSync(path.dirname(path.resolve(configPath)), { recursive: true });
  writeFileSync(configPath, YAML.stringify(config), { encoding: 'utf8', flag: 'wx' });
}

export function saveConfig(configPath: string, config: AppConfig): void {
  // Before serialising back to YAML, strip cross-venue fields from each venue's strategy block so the YAML
  // self-heals as the user edits config. Without this, an originally-dirty config.yaml (with predict* keys under
  // polymarketParams.strategy or vice versa) would round-trip unchanged forever; with this, every save removes
  // one more set of misplaced fields, and a clean config stays clean.
  const cleaned: AppConfig = {
    ...config,
    ...(config.predictParams ? {
      predictParams: {
        risk: config.predictParams.risk,
        strategy: stripVenuePrefixedStrategy(config.predictParams.strategy, 'predict')
      }
    } : {}),
    ...(config.polymarketParams ? {
      polymarketParams: {
        risk: config.polymarketParams.risk,
        strategy: stripVenuePrefixedStrategy(config.polymarketParams.strategy, 'polymarket')
      }
    } : {})
  };
  const normalized = normalizeLiveStrategyConfig(cleaned);
  assertNoRawSecrets(normalized);
  mkdirSync(path.dirname(path.resolve(configPath)), { recursive: true });
  writeFileSync(configPath, YAML.stringify(normalized), 'utf8');
}

export function ensureDataDirs(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(path.join(dataDir, 'keystores'), { recursive: true });
  mkdirSync(path.join(dataDir, 'credentials'), { recursive: true });
  mkdirSync(path.join(dataDir, 'runtime-state'), { recursive: true });
}
