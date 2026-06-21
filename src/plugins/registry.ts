export interface DisabledPlugin {
  name: 'opinion' | 'cross-platform-arbitrage';
  enabled: false;
  reason: string;
}

export const disabledPlugins: DisabledPlugin[] = [
  {
    name: 'opinion',
    enabled: false,
    reason: 'Requires separate API/signing audit before live execution.'
  },
  {
    name: 'cross-platform-arbitrage',
    enabled: false,
    reason: 'Multi-leg execution is excluded from v1 live scope.'
  }
];
