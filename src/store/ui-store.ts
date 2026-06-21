import path from 'node:path';
import { StateStore } from './sqlite.js';

export function usingStore(dataDir: string): StateStore {
  return new StateStore(path.join(dataDir, 'state.sqlite'));
}
