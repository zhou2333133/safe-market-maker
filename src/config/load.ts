import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { appConfigSchema, assertEndpointAllowed, assertNoRawSecrets, normalizeLiveStrategyConfig, type AppConfig } from './schema.js';
import { ensurePolymarketParams, ensurePredictParams } from './venue-config.js';

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
  const normalized = normalizeLiveStrategyConfig(config);
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
