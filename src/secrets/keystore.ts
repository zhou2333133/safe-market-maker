import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Wallet } from 'ethers';
import type { VenueName } from '../domain/types.js';
import { decryptUtf8, encryptUtf8, type EncryptedEnvelope } from './crypto.js';
import { LocalWalletSigner } from './signer.js';

interface WalletKeystore {
  kind: 'wallet';
  venue: VenueName;
  address: string;
  createdAt: string;
  envelope: EncryptedEnvelope;
}

interface CredentialKeystore {
  kind: 'credential';
  venue: VenueName;
  name: string;
  createdAt: string;
  envelope: EncryptedEnvelope;
}

export function normalizePrivateKey(privateKey: string): string {
  const clean = privateKey.trim().replace(/^0x/i, '');
  if (!/^[a-fA-F0-9]{64}$/.test(clean)) {
    throw new Error('钱包私钥必须是 64 位十六进制字符串，可带 0x 前缀。不要输入 API key、助记词、地址或 keystore 密码。');
  }
  return `0x${clean}`;
}

export function walletKeystorePath(dataDir: string, venue: VenueName): string {
  return path.join(dataDir, 'keystores', `${venue}.wallet.json`);
}

export function credentialPath(dataDir: string, venue: VenueName, name: string): string {
  return path.join(dataDir, 'credentials', `${venue}.${name}.json`);
}

export function importWallet(dataDir: string, venue: VenueName, privateKey: string, passphrase: string): string {
  const normalized = normalizePrivateKey(privateKey);
  const wallet = new Wallet(normalized);
  const target = walletKeystorePath(dataDir, venue);
  mkdirSync(path.dirname(target), { recursive: true });
  const payload: WalletKeystore = {
    kind: 'wallet',
    venue,
    address: wallet.address,
    createdAt: new Date().toISOString(),
    envelope: encryptUtf8(normalized, passphrase)
  };
  writeFileSync(target, JSON.stringify(payload, null, 2), { encoding: 'utf8', flag: 'w' });
  return wallet.address;
}

export function loadWalletSigner(dataDir: string, venue: VenueName, passphrase: string): LocalWalletSigner {
  const target = walletKeystorePath(dataDir, venue);
  if (!existsSync(target)) {
    throw new Error(`No wallet keystore for ${venue}. Run mm wallet import --venue ${venue}.`);
  }
  const payload = JSON.parse(readFileSync(target, 'utf8')) as WalletKeystore;
  if (payload.kind !== 'wallet' || payload.venue !== venue) {
    throw new Error(`Invalid wallet keystore: ${target}`);
  }
  return new LocalWalletSigner(decryptUtf8(payload.envelope, passphrase));
}

export function hasWallet(dataDir: string, venue: VenueName): boolean {
  return existsSync(walletKeystorePath(dataDir, venue));
}

export function saveCredential(
  dataDir: string,
  venue: VenueName,
  name: string,
  value: unknown,
  passphrase: string
): void {
  const target = credentialPath(dataDir, venue, name);
  mkdirSync(path.dirname(target), { recursive: true });
  const payload: CredentialKeystore = {
    kind: 'credential',
    venue,
    name,
    createdAt: new Date().toISOString(),
    envelope: encryptUtf8(JSON.stringify(value), passphrase)
  };
  writeFileSync(target, JSON.stringify(payload, null, 2), 'utf8');
}

export function loadCredential<T>(dataDir: string, venue: VenueName, name: string, passphrase: string): T | undefined {
  const target = credentialPath(dataDir, venue, name);
  if (!existsSync(target)) return undefined;
  const payload = JSON.parse(readFileSync(target, 'utf8')) as CredentialKeystore;
  if (payload.kind !== 'credential' || payload.venue !== venue || payload.name !== name) {
    throw new Error(`Invalid credential keystore: ${target}`);
  }
  return JSON.parse(decryptUtf8(payload.envelope, passphrase)) as T;
}
