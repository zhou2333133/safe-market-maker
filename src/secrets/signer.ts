import { Wallet, type TypedDataDomain, type TypedDataField } from 'ethers';

export interface SignerProvider {
  readonly address: string;
  signMessage(message: string | Uint8Array): Promise<string>;
  signTypedData(
    domain: TypedDataDomain,
    types: Record<string, TypedDataField[]>,
    value: Record<string, unknown>
  ): Promise<string>;
}

const BLOCKED_WALLET_PROPS = new Set<PropertyKey>([
  'privateKey',
  'signingKey',
  'mnemonic',
  'extendedKey',
  '_signingKey',
  '_privateKey'
]);

/**
 * Wrap an ethers Wallet so that ANY external read of `.privateKey` / `.signingKey` / `.mnemonic` throws, while the
 * wallet's own methods continue to work because their `this` is bound to the underlying target (not the proxy),
 * so internal calls in signMessage / signTypedData / signTransaction can still touch signingKey directly. The
 * returned object still satisfies `instanceof Wallet` (ethers SDK type checks pass) but a caller can no longer
 * extract the plaintext key in one line of code. .connect(provider) returns a Wallet — we re-proxy that too so
 * the .connect() output is equally locked down.
 */
function safeWalletProxy(wallet: Wallet): Wallet {
  // Only the `get` trap blocks the leak — leaving `has`/`ownKeys`/`getOwnPropertyDescriptor` untouched keeps SDK
  // introspection (`Object.keys(wallet)`, `'privateKey' in wallet`) numerically identical to a raw wallet so any
  // SDK that walks the object for compatibility checks still sees what it expects; the actual read still throws.
  return new Proxy(wallet, {
    get(target, prop, receiver) {
      if (BLOCKED_WALLET_PROPS.has(prop)) {
        throw new Error(`LocalWalletSigner blocks direct access to wallet.${String(prop)}. Use signMessage / signTypedData / signTransaction instead — the underlying ethers SDK keeps working because method internals access the real wallet directly.`);
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      if (prop === 'connect') {
        return (provider: unknown) => safeWalletProxy(target.connect(provider as never) as Wallet);
      }
      return value.bind(target);
    }
  });
}

export class LocalWalletSigner implements SignerProvider {
  private readonly wallet: Wallet;

  constructor(privateKey: string) {
    const normalized = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    this.wallet = new Wallet(normalized);
  }

  get address(): string {
    return this.wallet.address;
  }

  signMessage(message: string | Uint8Array): Promise<string> {
    return this.wallet.signMessage(message);
  }

  signTypedData(
    domain: TypedDataDomain,
    types: Record<string, TypedDataField[]>,
    value: Record<string, unknown>
  ): Promise<string> {
    return this.wallet.signTypedData(domain, types, value);
  }

  /**
   * Return a privateKey-blocked Proxy of the underlying ethers Wallet for SDKs that require a Wallet (Predict SDK,
   * Polymarket SDK gas paths). `.privateKey` / `.signingKey` / `.mnemonic` throw if accessed externally; the SDK's
   * own internal signing flows are unaffected because the methods are bound to the underlying target. Renamed from
   * unsafeEthersWalletForSdk to remove the misleading "use freely" signal.
   */
  ethersWalletForSdk(): Wallet {
    return safeWalletProxy(this.wallet);
  }

  ethersWalletForTransactions(): Wallet {
    return safeWalletProxy(this.wallet);
  }

  /**
   * Polymarket clob-client expects a minimal "wallet client" object (NOT a full ethers Wallet). This object never
   * exposed `.privateKey` even in the original implementation; we keep the same shape, just renaming the method.
   */
  polymarketWalletClientForSdk(): {
    account: { address: string };
    getAddresses(): Promise<string[]>;
    requestAddresses(): Promise<string[]>;
    signTypedData(input: {
      domain: TypedDataDomain;
      types: Record<string, TypedDataField[]>;
      message: Record<string, unknown>;
    }): Promise<string>;
  } {
    const wallet = this.wallet;
    return {
      account: { address: wallet.address },
      getAddresses: async () => [wallet.address],
      requestAddresses: async () => [wallet.address],
      signTypedData: async (input) => wallet.signTypedData(input.domain, input.types, input.message)
    };
  }

  // ---- Deprecated aliases ---------------------------------------------------
  // Kept so the 9 existing venue call sites keep compiling during the rename; remove after one rotation.

  /** @deprecated Use ethersWalletForSdk() — same behaviour, no privateKey leak risk anymore. */
  unsafeEthersWalletForSdk(): Wallet { return this.ethersWalletForSdk(); }
  /** @deprecated Use ethersWalletForTransactions(). */
  unsafeEthersWalletForTransactions(): Wallet { return this.ethersWalletForTransactions(); }
  /** @deprecated Use polymarketWalletClientForSdk(). */
  unsafePolymarketWalletClientForSdk(): ReturnType<LocalWalletSigner['polymarketWalletClientForSdk']> { return this.polymarketWalletClientForSdk(); }
}
