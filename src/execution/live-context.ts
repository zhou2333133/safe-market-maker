import { ensureDataDirs, loadConfig } from '../config/load.js';
import type { VenueName } from '../domain/types.js';
import { loadWalletSigner } from '../secrets/keystore.js';
import { loadRuntimeSigner } from '../secrets/runtime.js';
import type { SignerProvider } from '../secrets/signer.js';
import { StateStore } from '../store/sqlite.js';
import { usingStore } from '../store/ui-store.js';
import { createVenue } from '../venues/factory.js';
import type { VenueAdapter } from '../venues/types.js';
import type { AppConfig } from '../config/schema.js';

export interface LiveContext {
  config: AppConfig;
  configPath: string;
  dataDir: string;
  venue: VenueName;
  passphrase: string;
  signer: SignerProvider;
  adapter: VenueAdapter;
  store: StateStore;
}

export async function withLiveContext<T>(
  configPath: string,
  venue: VenueName,
  passphrase: string,
  task: (context: LiveContext) => Promise<T>
): Promise<T> {
  const loaded = loadConfig(configPath);
  ensureDataDirs(loaded.dataDir);
  const signer = passphrase ? loadWalletSigner(loaded.dataDir, venue, passphrase) : loadRuntimeSigner(venue, loaded.dataDir);
  const adapter = createVenue(loaded.config, loaded.dataDir, venue, passphrase);
  const store = usingStore(loaded.dataDir);
  try {
    return await task({
      config: loaded.config,
      configPath: loaded.configPath,
      dataDir: loaded.dataDir,
      venue,
      passphrase,
      signer,
      adapter,
      store
    });
  } finally {
    store.close();
  }
}
