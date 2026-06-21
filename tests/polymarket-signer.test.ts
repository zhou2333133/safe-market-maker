import { describe, expect, it } from 'vitest';
import { LocalWalletSigner } from '../src/secrets/signer.js';

describe('Polymarket SDK signer adapter', () => {
  it('exposes an account address and viem-style typed-data signing for ethers v6 wallets', async () => {
    const signer = new LocalWalletSigner('0x0123456789012345678901234567890123456789012345678901234567890123');
    const walletClient = signer.unsafePolymarketWalletClientForSdk();

    expect(walletClient.account.address).toBe(signer.address);
    await expect(walletClient.getAddresses()).resolves.toEqual([signer.address]);
    await expect(walletClient.requestAddresses()).resolves.toEqual([signer.address]);

    const signature = await walletClient.signTypedData({
      domain: {
        name: 'Polymarket Test',
        version: '1',
        chainId: 137,
        verifyingContract: '0x0000000000000000000000000000000000000001'
      },
      types: {
        Payload: [{ name: 'value', type: 'uint256' }]
      },
      message: { value: 1 }
    });

    expect(signature).toMatch(/^0x[a-fA-F0-9]{130}$/);
  });
});
