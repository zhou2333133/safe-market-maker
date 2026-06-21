const LONG_HEX_RE = /0x[a-fA-F0-9]{80,}/g;
const TRANSACTION_RE = /transaction="[^"]*"/gi;
const MAX_PUBLIC_ERROR_CHARS = 260;

export function publicErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  return publicErrorText(raw);
}

export function publicErrorText(value: string): string {
  const text = String(value || '').trim();
  if (!text) return '未知错误';
  if (isNativeGasErrorText(text)) return nativeGasLowMessage();
  // Geo/region block must be checked BEFORE the generic 401/403 auth message — a VPN in a banned region (Polymarket
  // blocks the US + sanctioned territories at Cloudflare) returns 403/1009, which would otherwise read as "凭据失效".
  if (isGeoBlockErrorText(text)) return geoBlockMessage();
  if (isHttpAuthErrorText(text)) return '平台认证失败或地区受限(HTTP 401/403):可能是 JWT/API 凭据失效,或 IP/VPN 地区被封。若你用 VPN 且刚换过地区,请先排查地区(换回允许地区);否则重新授权。机器人暂停新增挂单。';
  if (isConnectionErrorText(text)) return '连接平台失败(超时/网络中断):网络或 VPN 连通性问题 —— 地区被封时也可能表现为连不上。若用 VPN,检查连通性或换回允许地区后重试。';
  const compact = text
    .replace(TRANSACTION_RE, 'transaction="[交易数据已隐藏]"')
    .replace(LONG_HEX_RE, '[交易数据已隐藏]')
    .replace(/\s+/g, ' ')
    .trim();
  if (compact.length <= MAX_PUBLIC_ERROR_CHARS) return compact;
  return `${compact.slice(0, MAX_PUBLIC_ERROR_CHARS - 1)}…`;
}

export function isNativeGasError(error: unknown): boolean {
  return isNativeGasErrorText(error instanceof Error ? error.message : String(error ?? ''));
}

export function isNativeGasErrorText(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.includes('insufficient funds for intrinsic transaction cost') ||
    lower.includes('insufficient funds for gas') ||
    (lower.includes('insufficient_funds') && lower.includes('gas')) ||
    lower.includes('native gas balance is too low') ||
    lower.includes('bnb 手续费余额不足')
  );
}

export function nativeGasLowMessage(minBnb?: string, currentBnb?: string): string {
  const current = currentBnb ? `当前约 ${currentBnb} BNB，` : '';
  const min = minBnb ? `建议至少保留 ${minBnb} BNB。` : '请给签名钱包补少量 BNB 后再自动拆分/合并。';
  return `普通挂单不需要 BNB；但自动 split/merge 是链上交易，当前 BNB 手续费余额不足。${current}${min}`;
}

function isHttpAuthErrorText(value: string): boolean {
  return /HTTP\s+(401|403)\b/i.test(value);
}

// Polymarket geo-blocks the US + sanctioned regions at the Cloudflare edge (error 1009 = "owner has banned the
// country/region your IP is in"), plus various API-level jurisdiction wording. A VPN set to a banned region trips this.
export function isGeoBlockErrorText(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    (lower.includes('1009') && (lower.includes('cloudflare') || lower.includes('country') || lower.includes('region') || lower.includes('banned'))) ||
    lower.includes('banned the country') || lower.includes('banned the region') ||
    lower.includes('geoblock') || lower.includes('geo-block') || lower.includes('geo block') || lower.includes('geofenc') ||
    lower.includes('restricted jurisdiction') || lower.includes('restricted territory') ||
    lower.includes('not available in your region') || lower.includes('not available in your country') ||
    lower.includes('unavailable in your region') || lower.includes('unavailable in your country') ||
    lower.includes('blocked in your region') || lower.includes('blocked in your country') ||
    lower.includes('not permitted in your jurisdiction') ||
    (lower.includes('access denied') && (lower.includes('country') || lower.includes('region') || lower.includes('cloudflare')))
  );
}

export function geoBlockMessage(): string {
  return '下单/连接被拒:疑似 IP/VPN 地区受限(Polymarket 封锁美国及受限地区)。若你刚切换过 VPN 地区,请换回允许的地区后重试 —— 这不是凭据问题;机器人暂停新增挂单。';
}

// Raw network/transport failures — often how a fully blocked region manifests when Cloudflare doesn't even return a page.
export function isConnectionErrorText(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.includes('etimedout') || lower.includes('timed out') || lower.includes('timeout') ||
    lower.includes('econnrefused') || lower.includes('econnreset') ||
    lower.includes('enotfound') || lower.includes('eai_again') ||
    lower.includes('fetch failed') || lower.includes('network error') ||
    lower.includes('socket hang up') || lower.includes('socket disconnected')
  );
}
