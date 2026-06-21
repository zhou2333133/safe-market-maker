import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { importWallet, loadWalletSigner } from '../src/secrets/keystore.js';
import { loadRuntimeSigner, runtimeSignerStatus } from '../src/secrets/runtime.js';

describe('encrypted keystore', () => {
  it('round-trips a wallet without exposing raw private key in the signer API', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    try {
      const privateKey = '1'.repeat(64);
      const passphrase = 'correct horse battery staple';
      const address = importWallet(dir, 'predict', privateKey, passphrase);
      const signer = loadWalletSigner(dir, 'predict', passphrase);
      expect(signer.address).toBe(address);
      expect('privateKey' in signer).toBe(false);
      await expect(signer.signMessage('hello')).resolves.toMatch(/^0x/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runtime signer vault', () => {
  it('persists an env private key locally so later UI starts can load it without env', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-runtime-'));
    const previous = process.env.SAFE_MM_PREDICT_PRIVATE_KEY;
    try {
      process.env.SAFE_MM_PREDICT_PRIVATE_KEY = '2'.repeat(64);
      const first = runtimeSignerStatus(dir, 'predict');
      expect(first).toMatchObject({ available: true, source: 'env' });
      expect(first.address).toBeTruthy();

      delete process.env.SAFE_MM_PREDICT_PRIVATE_KEY;
      const second = runtimeSignerStatus(dir, 'predict');
      expect(second).toMatchObject({ available: true, source: 'encrypted-local', address: first.address });
      expect(loadRuntimeSigner('predict', dir).address).toBe(first.address);
    } finally {
      if (previous === undefined) delete process.env.SAFE_MM_PREDICT_PRIVATE_KEY;
      else process.env.SAFE_MM_PREDICT_PRIVATE_KEY = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
