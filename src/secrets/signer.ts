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

  unsafeEthersWalletForSdk(): Wallet {
    return this.wallet;
  }

  unsafeEthersWalletForTransactions(): Wallet {
    return this.wallet;
  }

  unsafePolymarketWalletClientForSdk(): {
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
}
