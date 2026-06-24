import { randomBytes, scryptSync, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';

// Envelope versions:
//  - 1: scrypt N=16384, r=8, p=1 (legacy). 8x below OWASP 2025 recommendation but kept for decrypt so existing
//       keystores still unlock without forcing the user to reimport.
//  - 2: scrypt N=131072, r=8, p=2 (current). Matches the OWASP 2025 floor and roughly halves the GPU-dictionary
//       attack rate vs v1. New encryptions always use v2; v1 envelopes are upgraded the next time they get
//       rewritten (e.g. credential rotation). Unlock takes ~100-200ms on a modern CPU which is fine for
//       manual / one-shot operations.
export interface EncryptedEnvelope {
  version: 1 | 2;
  kdf: 'scrypt';
  cipher: 'aes-256-gcm';
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

const KEY_BYTES = 32;
const SCRYPT_V1 = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SCRYPT_V2 = { N: 131072, r: 8, p: 2, maxmem: 512 * 1024 * 1024 };
const CURRENT_ENVELOPE_VERSION = 2 as const;

function deriveKey(passphrase: string, salt: Buffer, version: 1 | 2): Buffer {
  const params = version === 1 ? SCRYPT_V1 : SCRYPT_V2;
  return scryptSync(passphrase, salt, KEY_BYTES, params);
}

export function encryptUtf8(plaintext: string, passphrase: string): EncryptedEnvelope {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt, CURRENT_ENVELOPE_VERSION);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: CURRENT_ENVELOPE_VERSION,
    kdf: 'scrypt',
    cipher: 'aes-256-gcm',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: encrypted.toString('base64')
  };
}

export function decryptUtf8(envelope: EncryptedEnvelope, passphrase: string): string {
  if ((envelope.version !== 1 && envelope.version !== 2) || envelope.kdf !== 'scrypt' || envelope.cipher !== 'aes-256-gcm') {
    throw new Error('Unsupported encrypted envelope.');
  }
  const salt = Buffer.from(envelope.salt, 'base64');
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  const key = deriveKey(passphrase, salt, envelope.version);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
