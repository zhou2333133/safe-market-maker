import type { VenueName } from '../domain/types.js';

const store = new Map<VenueName, string>();

export function setPassphrase(venue: VenueName, passphrase: string): void {
  if (!passphrase) throw new Error('密码不能为空');
  store.set(venue, passphrase);
}

export function getPassphrase(venue: VenueName): string | undefined {
  return store.get(venue);
}

export function clearPassphrase(venue: VenueName): void {
  store.delete(venue);
}

export function clearAllPassphrases(): void {
  store.clear();
}

export function isUnlocked(venue: VenueName): boolean {
  return store.has(venue);
}
