import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Wallet } from 'ethers';
import type { VenueName } from '../domain/types.js';
import { decryptUtf8, encryptUtf8, type EncryptedEnvelope } from './crypto.js';
import { LocalWalletSigner } from './signer.js';
import { normalizePrivateKey } from './keystore.js';

type PredictRuntimeCredential = { jwt?: string };
type PolymarketRuntimeCredential = { key: string; secret: string; passphrase: string };
export type RuntimeCredential = PredictRuntimeCredential | PolymarketRuntimeCredential;

const credentialCache = new Map<VenueName, RuntimeCredential>();

interface RuntimeWalletVault {
  kind: 'runtime-wallet';
  venue: VenueName;
  address: string;
  createdAt: string;
  updatedAt: string;
  sourceEnv?: string;
  envelope: EncryptedEnvelope;
}

export interface RuntimeSignerStatus {
  available: boolean;
  source: 'env' | 'encrypted-local' | 'none';
  label: string;
  envName: string;
  address?: string;
}

export function runtimePrivateKeyEnvName(venue: VenueName): string {
  return venue === 'predict' ? 'SAFE_MM_PREDICT_PRIVATE_KEY' : 'SAFE_MM_POLYMARKET_PRIVATE_KEY';
}

export function runtimePrivateKey(venue: VenueName, dataDir?: string): string | undefined {
  const env = runtimePrivateKeyFromEnv(venue);
  if (env) {
    const normalized = normalizePrivateKey(env.value);
    if (dataDir) saveRuntimePrivateKey(dataDir, venue, normalized, env.name);
    return normalized;
  }
  if (!dataDir) return undefined;
  return loadPersistedRuntimePrivateKey(dataDir, venue);
}

export function hasRuntimePrivateKey(venue: VenueName, dataDir?: string): boolean {
  try {
    return Boolean(runtimePrivateKey(venue, dataDir));
  } catch {
    return false;
  }
}

export function loadRuntimeSigner(venue: VenueName, dataDir?: string): LocalWalletSigner {
  const privateKey = runtimePrivateKey(venue, dataDir);
  if (!privateKey) {
    throw new Error(`${runtimePrivateKeyEnvName(venue)} 或 SAFE_MM_PRIVATE_KEY 未设置，也没有本机加密保存的运行时私钥，无法进行实盘签名。`);
  }
  return new LocalWalletSigner(normalizePrivateKey(privateKey));
}

export function runtimeSignerStatus(dataDir: string, venue: VenueName): RuntimeSignerStatus {
  const env = runtimePrivateKeyFromEnv(venue);
  if (env) {
    const signer = new LocalWalletSigner(normalizePrivateKey(env.value));
    saveRuntimePrivateKey(dataDir, venue, normalizePrivateKey(env.value), env.name);
    return {
      available: true,
      source: 'env',
      label: `${env.name} 已加载并已本机加密保存`,
      envName: runtimePrivateKeyEnvName(venue),
      address: signer.address
    };
  }
  const persisted = loadPersistedRuntimePrivateKey(dataDir, venue);
  if (persisted) {
    const signer = new LocalWalletSigner(persisted);
    return {
      available: true,
      source: 'encrypted-local',
      label: '本机加密私钥已加载',
      envName: runtimePrivateKeyEnvName(venue),
      address: signer.address
    };
  }
  return {
    available: false,
    source: 'none',
    label: '未检测到运行时私钥',
    envName: runtimePrivateKeyEnvName(venue)
  };
}

export function getRuntimeCredential(venue: VenueName): RuntimeCredential | undefined {
  return credentialCache.get(venue) ?? runtimeCredentialFromEnv(venue);
}

export function setRuntimeCredential(venue: VenueName, credential: RuntimeCredential): void {
  credentialCache.set(venue, credential);
}

export function hasRuntimeCredential(venue: VenueName): boolean {
  return Boolean(getRuntimeCredential(venue));
}

function runtimeCredentialFromEnv(venue: VenueName): RuntimeCredential | undefined {
  if (venue === 'predict') {
    const jwt = process.env.SAFE_MM_PREDICT_JWT;
    return jwt ? { jwt } : undefined;
  }
  const key = process.env.SAFE_MM_POLYMARKET_CLOB_KEY;
  const secret = process.env.SAFE_MM_POLYMARKET_CLOB_SECRET;
  const passphrase = process.env.SAFE_MM_POLYMARKET_CLOB_PASSPHRASE;
  if (!key || !secret || !passphrase) return undefined;
  return { key, secret, passphrase };
}

function runtimePrivateKeyFromEnv(venue: VenueName): { name: string; value: string } | undefined {
  const venueName = runtimePrivateKeyEnvName(venue);
  const venueSpecific = process.env[venueName];
  if (venueSpecific) return { name: venueName, value: venueSpecific };
  const shared = process.env.SAFE_MM_PRIVATE_KEY;
  if (shared) return { name: 'SAFE_MM_PRIVATE_KEY', value: shared };
  return undefined;
}

function runtimeSecretsDir(dataDir: string): string {
  return path.join(dataDir, 'runtime-secrets');
}

function runtimeWalletPath(dataDir: string, venue: VenueName): string {
  return path.join(runtimeSecretsDir(dataDir), `${venue}.runtime-wallet.json`);
}

function runtimeMasterKeyPath(dataDir: string): string {
  return path.join(runtimeSecretsDir(dataDir), 'local-master.key');
}

function runtimeMasterKey(dataDir: string): string {
  const target = runtimeMasterKeyPath(dataDir);
  if (existsSync(target)) return readFileSync(target, 'utf8').trim();
  mkdirSync(path.dirname(target), { recursive: true });
  const key = randomBytes(32).toString('hex');
  writeFileSync(target, key, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return key;
}

function saveRuntimePrivateKey(dataDir: string, venue: VenueName, privateKey: string, sourceEnv: string): void {
  const normalized = normalizePrivateKey(privateKey);
  const wallet = new Wallet(normalized);
  const target = runtimeWalletPath(dataDir, venue);
  const createdAt = existsSync(target)
    ? (JSON.parse(readFileSync(target, 'utf8')) as Partial<RuntimeWalletVault>).createdAt ?? new Date().toISOString()
    : new Date().toISOString();
  const payload: RuntimeWalletVault = {
    kind: 'runtime-wallet',
    venue,
    address: wallet.address,
    createdAt,
    updatedAt: new Date().toISOString(),
    sourceEnv,
    envelope: encryptUtf8(normalized, runtimeMasterKey(dataDir))
  };
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(payload, null, 2), { encoding: 'utf8', flag: 'w', mode: 0o600 });
}

function loadPersistedRuntimePrivateKey(dataDir: string, venue: VenueName): string | undefined {
  const target = runtimeWalletPath(dataDir, venue);
  if (!existsSync(target)) return undefined;
  const payload = JSON.parse(readFileSync(target, 'utf8')) as RuntimeWalletVault;
  if (payload.kind !== 'runtime-wallet' || payload.venue !== venue) {
    throw new Error(`Invalid runtime wallet vault: ${target}`);
  }
  return normalizePrivateKey(decryptUtf8(payload.envelope, runtimeMasterKey(dataDir)));
}
