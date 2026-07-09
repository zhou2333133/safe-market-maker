import type { Balance, Market, Orderbook, OrderbookLevel, VenueName } from '../domain/types.js';

export function toFiniteNumber(...values: unknown[]): number {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const parsed = Number(typeof value === 'string' ? value.replace(/,/g, '').trim() : value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function toOptionalFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    if (typeof value === 'string') {
      const cleaned = value.replace(/,/g, '').trim();
      const parsed = Number(cleaned);
      if (Number.isFinite(parsed)) return parsed;
      const match = cleaned.match(/-?\d+(?:\.\d+)?/);
      if (match) {
        const numeric = Number(match[0]);
        if (Number.isFinite(numeric)) return numeric;
      }
      continue;
    }
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function normalizeBalances(payload: any, defaultAsset = 'UNKNOWN'): Balance[] {
  const rows = balanceRows(payload);
  return rows
    .map((item) => {
      const asset = firstString(
        item?.asset,
        item?.symbol,
        item?.currency,
        item?.denom,
        item?.tokenSymbol,
        item?.token_symbol,
        item?.token?.symbol,
        item?.token?.asset,
        defaultAsset
      );
      const available = toOptionalFiniteNumber(
        item?.available,
        item?.availableBalance,
        item?.available_balance,
        item?.free,
        item?.freeBalance,
        item?.free_balance,
        item?.spendable,
        item?.withdrawable,
        item?.cashAvailable,
        item?.cash_available
      );
      const total = toOptionalFiniteNumber(
        item?.total,
        item?.totalBalance,
        item?.total_balance,
        item?.walletBalance,
        item?.wallet_balance,
        item?.balance,
        item?.amount,
        item?.value,
        item?.valueUsd,
        item?.value_usd,
        item?.collateral,
        item?.cash
      );
      const normalizedTotal = total ?? available ?? 0;
      return {
        asset,
        available: available ?? normalizedTotal,
        total: normalizedTotal
      };
    })
    .filter((balance) => balance.asset !== 'UNKNOWN' || balance.available > 0 || balance.total > 0);
}

function balanceRows(payload: any): any[] {
  const roots = [
    payload,
    payload?.data,
    payload?.result,
    payload?.account,
    payload?.wallet,
    payload?.data?.account,
    payload?.data?.wallet
  ].filter(Boolean);
  const rows: any[] = [];
  for (const root of roots) {
    if (Array.isArray(root)) {
      rows.push(...root);
      continue;
    }
    if (!root || typeof root !== 'object') continue;
    for (const key of ['balances', 'balance', 'assets', 'funds', 'collateral']) {
      const value = root[key];
      if (Array.isArray(value)) rows.push(...value);
      else if (value && typeof value === 'object') rows.push(...expandBalanceObject(value));
      else if (value !== undefined && value !== null && value !== '') rows.push({ balance: value });
    }
    if (hasBalanceFields(root)) rows.push(root);
  }
  return rows.length > 0 ? rows : [];
}

function expandBalanceObject(value: any): any[] {
  if (hasBalanceFields(value)) return [value];
  return Object.entries(value).flatMap(([asset, balance]) => {
    if (!/^[a-zA-Z0-9._-]{2,16}$/.test(asset)) return [];
    if (balance && typeof balance === 'object') return [{ ...balance, asset: (balance as any).asset ?? asset }];
    return [{ asset, balance }];
  });
}

function hasBalanceFields(value: any): boolean {
  if (!value || typeof value !== 'object') return false;
  return [
    'available',
    'availableBalance',
    'available_balance',
    'free',
    'total',
    'totalBalance',
    'total_balance',
    'walletBalance',
    'wallet_balance',
    'balance',
    'amount',
    'value',
    'valueUsd',
    'value_usd',
    'collateral',
    'cash'
  ].some((key) => value[key] !== undefined && value[key] !== null && value[key] !== '');
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return 'UNKNOWN';
}

function optionalString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function optionalIsoTime(...values: unknown[]): string | undefined {
  for (const value of values) {
    const parsed = parseTime(value);
    if (parsed !== undefined) return new Date(parsed).toISOString();
  }
  return undefined;
}

function parseTime(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 0 && value < 10_000_000_000 ? value * 1000 : value;
    return Number.isFinite(ms) ? ms : undefined;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return undefined;
    if (/^\d+(\.\d+)?$/.test(text)) return parseTime(Number(text));
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function earliestIso(...values: Array<string | undefined>): string | undefined {
  const times = values
    .map((value) => value ? Date.parse(value) : Number.NaN)
    .filter(Number.isFinite);
  if (times.length === 0) return undefined;
  return new Date(Math.min(...times)).toISOString();
}

function timeSource(source: string): Market['startTimeSource'] {
  if (source === 'category-start') return 'category-start';
  if (source === 'market-start') return 'market-start';
  return 'unknown';
}

function startTimeSource(categoryStart?: string, marketStart?: string): Market['startTimeSource'] | undefined {
  const startTime = earliestIso(categoryStart, marketStart);
  if (!startTime) return undefined;
  const ts = Date.parse(startTime);
  if (categoryStart && Date.parse(categoryStart) === ts) return 'category-start';
  if (marketStart && Date.parse(marketStart) === ts) return 'market-start';
  return 'unknown';
}

function endTimeSource(orderDeadline?: string, marketEnd?: string, categoryEnd?: string, resolution?: string, rewardEnd?: string): Market['endTimeSource'] | undefined {
  const endTime = earliestIso(orderDeadline, marketEnd, categoryEnd, resolution, rewardEnd);
  if (!endTime) return undefined;
  const ts = Date.parse(endTime);
  if (orderDeadline && Date.parse(orderDeadline) === ts) return 'order-deadline';
  if (marketEnd && Date.parse(marketEnd) === ts) return 'market-end';
  if (categoryEnd && Date.parse(categoryEnd) === ts) return 'category-end';
  if (resolution && Date.parse(resolution) === ts) return 'resolution';
  if (rewardEnd && Date.parse(rewardEnd) === ts) return 'reward-end';
  return 'unknown';
}

export function toOptionalBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      if (value.toLowerCase() === 'true') return true;
      if (value.toLowerCase() === 'false') return false;
    }
  }
  return undefined;
}

export function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function normalizeTickSize(value: unknown): number {
  const numeric = toFiniteNumber(value);
  if (!numeric) return 0.01;
  return numeric > 1 ? numeric / 100 : numeric;
}

export function normalizeRewardSpread(value: unknown): number | undefined {
  const numeric = toFiniteNumber(value);
  if (!numeric) return undefined;
  return numeric > 1 ? numeric : numeric * 100;
}

export function normalizeRewardLevel(...values: unknown[]): number | undefined {
  const numeric = toFiniteNumber(...values);
  if (!numeric) return undefined;
  return Math.min(5, Math.max(1, Math.trunc(numeric)));
}

export function inferRewardLevel(minShares?: number, maxSpreadCents?: number): number | undefined {
  if (!minShares || !maxSpreadCents) return undefined;
  if (maxSpreadCents >= 6 && minShares <= 100) return 5;
  if (maxSpreadCents >= 5 && minShares <= 150) return 4;
  if (maxSpreadCents >= 3 && minShares <= 200) return 3;
  if (maxSpreadCents >= 2 && minShares <= 300) return 2;
  return 1;
}

export function inferPredictRewardLevel(raw: any, minShares?: number, maxSpreadCents?: number): number | undefined {
  const boosted = isPredictBoosted(raw);
  if (boosted) return 5;
  if (!minShares || !maxSpreadCents) return undefined;
  if (maxSpreadCents >= 6 && minShares <= 100) return 5;
  if (maxSpreadCents >= 5 && minShares <= 150) return 4;
  if (maxSpreadCents >= 3 && minShares <= 200) return 3;
  if (maxSpreadCents >= 2 && minShares <= 300) return 2;
  return 1;
}

function isActiveBoostWindow(raw: any): boolean {
  const startsAt = Date.parse(String(raw?.boostStartsAt ?? raw?.boost_starts_at ?? ''));
  const endsAt = Date.parse(String(raw?.boostEndsAt ?? raw?.boost_ends_at ?? ''));
  const now = Date.now();
  return Number.isFinite(startsAt) && Number.isFinite(endsAt) && startsAt <= now && now <= endsAt;
}

function isPredictBoosted(raw: any): boolean {
  const explicit = toOptionalBoolean(raw?.isBoosted, raw?.is_boosted) === true;
  const endsAt = Date.parse(String(raw?.boostEndsAt ?? raw?.boost_ends_at ?? ''));
  const expired = Number.isFinite(endsAt) && endsAt < Date.now();
  return !expired && (explicit || isActiveBoostWindow(raw));
}

export function normalizeLevels(levels: any[], side: 'bids' | 'asks'): OrderbookLevel[] {
  return levels
    .map((level) => ({
      price: toFiniteNumber(level?.price, level?.priceFloat, level?.[0]),
      size: toFiniteNumber(level?.size, level?.shares, level?.quantity, level?.[1])
    }))
    .filter((level) => level.price > 0 && level.size > 0)
    .sort((a, b) => (side === 'bids' ? b.price - a.price : a.price - b.price));
}

export function buildOrderbook(venue: VenueName, tokenId: string, payload: any): Orderbook {
  const bids = normalizeLevels(Array.isArray(payload?.bids) ? payload.bids : [], 'bids');
  const asks = normalizeLevels(Array.isArray(payload?.asks) ? payload.asks : [], 'asks');
  // saneBook guard (mirrors polymarket-ws sanity check): reject malformed REST books so they can't drive
  // quoting on bad data. A book with only one side still present is usable (e.g. quoting a cash BUY only
  // needs bids), so we only reject a book that has NEITHER side, or a crossed book (best bid >= best ask).
  const hasBids = bids.length > 0;
  const hasAsks = asks.length > 0;
  if (!hasBids && !hasAsks) {
    return { venue, tokenId, bids: [], asks: [], receivedAt: Date.now() };
  }
  if (hasBids && hasAsks) {
    const bestBid = bids[0]?.price;
    const bestAsk = asks[0]?.price;
    if (bestBid === undefined || bestAsk === undefined || !(bestBid > 0 && bestAsk < 1 && bestBid < bestAsk)) {
      return { venue, tokenId, bids: [], asks: [], receivedAt: Date.now() };
    }
  }
  return {
    venue,
    tokenId,
    bids,
    asks,
    receivedAt: Date.now()
  };
}

export function buildOrderbookForToken(
  venue: VenueName,
  tokenId: string,
  payload: any,
  options: { allowAmbiguousTopLevel?: boolean; complementAmbiguousTopLevel?: boolean; complementTickSize?: number; complementDecimalPlaces?: number } = {}
): Orderbook {
  const selection = selectOrderbookPayloadForToken(tokenId, payload, options);
  const book = buildOrderbook(venue, tokenId, selection.payload);
  return selection.ambiguousTopLevel && options.complementAmbiguousTopLevel
    ? complementBinaryOrderbook(book, {
        tickSize: options.complementTickSize,
        decimalPlaces: options.complementDecimalPlaces
      })
    : book;
}

function selectOrderbookPayloadForToken(
  tokenId: string,
  payload: any,
  options: { allowAmbiguousTopLevel?: boolean },
): { payload: any; ambiguousTopLevel: boolean } {
  const root = unwrapOrderbookPayload(payload);
  const nested = findTokenOrderbookPayload(tokenId, root, 0, new Set<object>());
  if (nested) return { payload: nested, ambiguousTopLevel: false };
  if (hasOrderbookLevels(root)) {
    if (tokenPayloadMatches(root, tokenId)) return { payload: root, ambiguousTopLevel: false };
    if (options.allowAmbiguousTopLevel) return { payload: root, ambiguousTopLevel: true };
    throw new Error(`Predict orderbook payload does not identify requested token ${tokenId}`);
  }
  throw new Error(`Predict orderbook payload did not contain bids/asks for token ${tokenId}`);
}

export function complementBinaryOrderbook(book: Orderbook, options: { tickSize?: number; decimalPlaces?: number } = {}): Orderbook {
  return {
    ...book,
    bids: book.asks
      .map((level) => ({
        price: complementPrice(level.price, options),
        size: level.size
      }))
      .filter((level) => level.price > 0 && level.price < 1)
      .sort((a, b) => b.price - a.price),
    asks: book.bids
      .map((level) => ({
        price: complementPrice(level.price, options),
        size: level.size
      }))
      .filter((level) => level.price > 0 && level.price < 1)
      .sort((a, b) => a.price - b.price)
  };
}

function complementPrice(price: number, options: { tickSize?: number; decimalPlaces?: number } = {}): number {
  const decimalPlaces = options.decimalPlaces ?? decimalPlacesFromTick(options.tickSize) ?? 6;
  return Number((1 - price).toFixed(decimalPlaces));
}

export function decimalPlacesFromTick(tickSize: number | undefined): number | undefined {
  if (!Number.isFinite(tickSize) || tickSize === undefined || tickSize <= 0) return undefined;
  const text = tickSize.toFixed(12).replace(/0+$/, '');
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : Math.max(0, text.length - dot - 1);
}

function unwrapOrderbookPayload(payload: any): any {
  return payload?.data?.orderbook
    ?? payload?.data?.book
    ?? payload?.orderbook
    ?? payload?.book
    ?? payload?.data
    ?? payload;
}

function findTokenOrderbookPayload(tokenId: string, value: any, depth: number, seen: Set<object>): any | undefined {
  if (!value || typeof value !== 'object' || depth > 6) return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (tokenPayloadMatches(value, tokenId)) {
    const direct = firstOrderbookPayload(value, value?.orderbook, value?.orderBook, value?.order_book, value?.book);
    if (direct) return direct;
  }

  if (!Array.isArray(value)) {
    const keyed = value[tokenId];
    const keyedBook = firstOrderbookPayload(keyed, keyed?.orderbook, keyed?.orderBook, keyed?.order_book, keyed?.book);
    if (keyedBook) return keyedBook;
  }

  const children = Array.isArray(value)
    ? value
    : [
        value?.outcomes,
        value?.tokens,
        value?.markets,
        value?.orderbooks,
        value?.orderBooks,
        value?.order_books,
        value?.books,
        value?.items,
        value?.results
      ].filter((item) => item !== undefined);
  for (const child of children) {
    const found = findTokenOrderbookPayload(tokenId, child, depth + 1, seen);
    if (found) return found;
  }

  if (!Array.isArray(value) && depth < 3) {
    for (const child of Object.values(value)) {
      const found = findTokenOrderbookPayload(tokenId, child, depth + 1, seen);
      if (found) return found;
    }
  }

  return undefined;
}

function firstOrderbookPayload(...values: any[]): any | undefined {
  for (const value of values) {
    const unwrapped = unwrapOrderbookPayload(value);
    if (hasOrderbookLevels(unwrapped)) return unwrapped;
  }
  return undefined;
}

function hasOrderbookLevels(value: any): boolean {
  return Boolean(value && typeof value === 'object' && (Array.isArray(value.bids) || Array.isArray(value.asks)));
}

function tokenPayloadMatches(value: any, tokenId: string): boolean {
  if (!value || typeof value !== 'object') return false;
  return [
    value?.tokenId,
    value?.token_id,
    value?.onChainId,
    value?.on_chain_id,
    value?.outcomeTokenId,
    value?.outcome_token_id,
    value?.asset,
    value?.assetId,
    value?.asset_id,
    value?.token?.id,
    value?.token?.tokenId,
    value?.token?.token_id,
    value?.outcome?.onChainId,
    value?.outcome?.tokenId,
    value?.outcome?.token_id
  ].some((candidate) => candidate !== undefined && candidate !== null && String(candidate) === tokenId);
}

export function bestBidAsk(book: Orderbook): { bestBid?: number; bestAsk?: number; mid?: number; spread?: number } {
  const bestBid = book.bids[0]?.price;
  const bestAsk = book.asks[0]?.price;
  const result: { bestBid?: number; bestAsk?: number; mid?: number; spread?: number } = {};
  if (bestBid !== undefined) result.bestBid = bestBid;
  if (bestAsk !== undefined) result.bestAsk = bestAsk;
  if (bestBid !== undefined && bestAsk !== undefined) {
    result.mid = (bestBid + bestAsk) / 2;
    result.spread = bestAsk - bestBid;
  }
  return result;
}

export function normalizePredictMarket(raw: any): Market[] {
  const rewards = normalizePredictRewards(raw) ?? { enabled: false };
  const rewardEnd = optionalIsoTime(raw?.rewards?.current?.endsAt, raw?.rewards?.current?.ends_at);
  const categoryStart = optionalIsoTime(raw?.categoryStartsAt, raw?.category_starts_at, raw?.category?.startsAt, raw?.category?.starts_at);
  // gameStartTime = sports kickoff → market START (same handling as Polymarket) so the short-event 已开赛 guard applies.
  const marketStart = optionalIsoTime(raw?.startsAt, raw?.starts_at, raw?.startTime, raw?.start_time, raw?.startDate, raw?.start_date, raw?.gameStartTime, raw?.game_start_time);
  const startTime = earliestIso(categoryStart, marketStart);
  const orderDeadline = optionalIsoTime(
    raw?.orderDeadline,
    raw?.order_deadline,
    raw?.tradingEndsAt,
    raw?.trading_ends_at,
    raw?.acceptingOrdersUntil,
    raw?.accepting_orders_until,
    raw?.lastOrderTime,
    raw?.last_order_time
  );
  const marketEnd = optionalIsoTime(
    raw?.endTime,
    raw?.end_time,
    raw?.endDate,
    raw?.end_date,
    raw?.closeTime,
    raw?.close_time,
    raw?.closeDate,
    raw?.close_date,
    raw?.closingTime,
    raw?.closing_time,
    raw?.expiry,
    raw?.expiration,
    raw?.expiresAt,
    raw?.expires_at
  );
  const categoryEnd = optionalIsoTime(raw?.categoryEndsAt, raw?.category_ends_at, raw?.category?.endsAt, raw?.category?.ends_at);
  const resolution = optionalIsoTime(
    raw?.resolutionTime,
    raw?.resolution_time,
    raw?.resolutionDate,
    raw?.resolution_date,
    raw?.resolveTime,
    raw?.resolve_time,
    raw?.settlementTime,
    raw?.settlement_time,
    raw?.settlesAt,
    raw?.settles_at
  );
  const endTime = earliestIso(orderDeadline, marketEnd, categoryEnd, resolution, rewards.enabled ? rewardEnd : undefined);
  const base = {
    venue: 'predict' as const,
    marketId: String(raw?.id ?? raw?.market_id ?? raw?.marketId ?? ''),
    conditionId: optionalString(raw?.conditionId, raw?.condition_id, raw?.condition?.id, raw?.condition),
    eventId: optionalString(raw?.eventId, raw?.event_id),
    question: String(raw?.question_zh ?? raw?.questionZh ?? raw?.title_zh ?? raw?.titleZh ?? raw?.question ?? raw?.title ?? 'Predict market'),
    url: raw?.market_url ?? raw?.marketUrl ?? raw?.share_url ?? raw?.url,
    slug: raw?.slug ?? raw?.market_slug ?? raw?.marketSlug,
    volume24hUsd: toFiniteNumber(raw?.stats?.volume24hUsd, raw?.volume_24h, raw?.volume24hUsd, raw?.volume24h, raw?.volume),
    liquidityUsd: toFiniteNumber(raw?.stats?.totalLiquidityUsd, raw?.totalLiquidityUsd, raw?.liquidity_24h, raw?.liquidityUsd, raw?.liquidity),
    acceptingOrders: normalizeTradingStatus(raw),
    ...(startTime ? { startTime, startTimeSource: startTimeSource(categoryStart, marketStart) ?? timeSource('unknown') } : {}),
    ...(endTime ? { endTime, endTimeSource: endTimeSource(orderDeadline, marketEnd, categoryEnd, resolution, rewards.enabled ? rewardEnd : undefined) ?? 'unknown' as const } : {}),
    negRisk: Boolean(raw?.is_neg_risk ?? raw?.isNegRisk ?? false),
    yieldBearing: Boolean(raw?.is_yield_bearing ?? raw?.isYieldBearing ?? raw?.yieldBearing ?? raw?.yield_bearing ?? false),
    feeRateBps: toFiniteNumber(raw?.fee_rate_bps, raw?.feeRateBps),
    tickSize: normalizeTickSize(raw?.tick_size ?? raw?.tickSize ?? 0.01),
    boosted: isPredictBoosted(raw),
    boostStartsAt: optionalString(raw?.boostStartsAt, raw?.boost_starts_at),
    boostEndsAt: optionalString(raw?.boostEndsAt, raw?.boost_ends_at),
    rewards
  };
  const outcomes = Array.isArray(raw?.outcomes) ? raw.outcomes : [];
  const expanded = outcomes
    .map((outcome: any, index: number) => ({
      tokenId: String(outcome?.onChainId ?? outcome?.tokenId ?? outcome?.token_id ?? ''),
      outcome: String(outcome?.name_zh ?? outcome?.nameZh ?? outcome?.outcome_zh ?? outcome?.outcomeZh ?? outcome?.name ?? outcome?.outcome ?? index),
      outcomeIndex: index
    }))
    .filter((item: { tokenId: string }) => item.tokenId);
  if (expanded.length === 0) {
    return [{ ...base, tokenId: String(raw?.token_id ?? raw?.tokenId ?? raw?.clobTokenId ?? raw?.id ?? '') }];
  }
  return expanded.map((item: { tokenId: string; outcome: string; outcomeIndex: number }) => ({
    ...base,
    tokenId: item.tokenId,
    outcome: item.outcome,
    outcomeIndex: item.outcomeIndex,
    outcomeCount: expanded.length
  }));
}

function normalizeTradingStatus(raw: any): boolean {
  const explicit = toOptionalBoolean(raw?.accepting_orders, raw?.acceptingOrders);
  if (explicit !== undefined) return explicit;
  const tradingStatus = String(raw?.tradingStatus ?? raw?.trading_status ?? '').toUpperCase();
  if (tradingStatus) return tradingStatus === 'OPEN';
  return true;
}

function normalizePredictRewards(raw: any): Market['rewards'] {
  const currentReward = raw?.rewards?.current ?? raw?.currentReward ?? raw?.current_reward;
  const currentHourlyRate = toOptionalFiniteNumber(
    currentReward?.hourlyRate,
    currentReward?.hourly_rate,
    currentReward?.ppPerHour,
    currentReward?.pp_per_hour,
    currentReward?.pointsPerHour,
    currentReward?.points_per_hour
  );
  const currentEndsAt = Date.parse(String(currentReward?.endsAt ?? currentReward?.ends_at ?? ''));
  const currentStartsAt = Date.parse(String(currentReward?.startsAt ?? currentReward?.starts_at ?? ''));
  const now = Date.now();
  const hasCurrentReward = Boolean(
    currentReward
    && currentHourlyRate !== undefined
    && currentHourlyRate > 0
    && (!Number.isFinite(currentStartsAt) || currentStartsAt <= now)
    && (!Number.isFinite(currentEndsAt) || now <= currentEndsAt)
  );
  const rules = raw?.liquidity_activation
    ?? raw?.liquidityActivation
    ?? raw?.points_rules
    ?? raw?.reward_rules
    ?? raw?.stats?.liquidity_activation
    ?? raw?.stats?.liquidityActivation
    ?? raw?.stats?.points_rules
    ?? raw?.stats?.reward_rules
    ?? {};
  const maxSpreadCents = normalizeRewardSpread(
    rules?.max_spread ?? rules?.maxSpread ?? rules?.max_spread_cents ?? rules?.maxSpreadCents ?? raw?.stats?.spreadThreshold ?? raw?.spreadThreshold
  );
  const minShares = toFiniteNumber(rules?.min_shares, rules?.minShares, raw?.stats?.shareThreshold, raw?.shareThreshold);
  if (!maxSpreadCents && !minShares) return { enabled: false };
  const level = normalizeRewardLevel(
    rules?.level,
    rules?.rewardLevel,
    rules?.reward_level,
    rules?.lpRewardLevel,
    rules?.lp_reward_level,
    raw?.level,
    raw?.rewardLevel,
    raw?.reward_level,
    raw?.lpRewardLevel,
    raw?.lp_reward_level,
    raw?.tier,
    raw?.rewardTier,
    raw?.reward_tier,
    raw?.stats?.level,
    raw?.stats?.rewardLevel,
    raw?.stats?.reward_level,
    raw?.stats?.lpRewardLevel,
    raw?.stats?.lp_reward_level
  ) ?? inferPredictRewardLevel(raw, minShares, maxSpreadCents);
  const ppPerHour = currentHourlyRate ?? toOptionalFiniteNumber(
    rules?.pp_per_hour,
    rules?.ppPerHour,
    rules?.points_per_hour,
    rules?.pointsPerHour,
    raw?.pp_per_hour,
    raw?.ppPerHour,
    raw?.points_per_hour,
    raw?.pointsPerHour,
    raw?.liquidityRewardsPerHour,
    raw?.liquidity_rewards_per_hour,
    raw?.stats?.pp_per_hour,
    raw?.stats?.ppPerHour,
    raw?.stats?.points_per_hour,
    raw?.stats?.pointsPerHour,
    raw?.stats?.liquidityRewardsPerHour,
    raw?.stats?.liquidity_rewards_per_hour
  );
  return {
    enabled: hasCurrentReward,
    ...(level ? { level } : {}),
    ...(minShares > 0 ? { minShares } : {}),
    ...(maxSpreadCents ? { maxSpreadCents } : {}),
    ...(ppPerHour ? { ppPerHour } : {}),
    reason: hasCurrentReward ? 'predict-current-points' : 'predict-reward-rules-inactive'
  };
}

/**
 * Build a Polymarket market's reward rules. The CLOB sampling set (/sampling-simplified-markets) is the AUTHORITATIVE
 * source for both reward eligibility and parameters (min_size / max_spread / daily rate) — those are exactly the
 * markets Polymarket samples and pays. Gamma's own rewardsMinSize / rewardsMaxSpread tags are unreliable: ~78% of
 * gamma-tagged "reward" markets are NOT in the live sampling set, so trusting them made the router treat big-volume
 * non-reward markets as reward candidates and fall back to a volume/liquidity ranking (picking the wrong markets).
 * So a market is a reward market ONLY when it appears in the CLOB sampling set; `clob` is undefined otherwise.
 */
export function polymarketRewardRules(_raw: any, clob: Market['rewards'] | undefined): Market['rewards'] {
  if (!clob || !clob.enabled) return { enabled: false };
  const level = clob.level ?? inferRewardLevel(clob.minShares, clob.maxSpreadCents);
  return {
    enabled: true,
    ...(level ? { level } : {}),
    ...(clob.minShares && clob.minShares > 0 ? { minShares: clob.minShares } : {}),
    ...(clob.maxSpreadCents ? { maxSpreadCents: clob.maxSpreadCents } : {}),
    ...(clob.dailyRate && clob.dailyRate > 0 ? { dailyRate: clob.dailyRate } : {})
  };
}

export function normalizePolymarketMarket(raw: any, rewardsByToken: Map<string, Market['rewards']>): Market[] {
  const outcomes = toArray(raw?.outcomes);
  const tokenIds = toArray(raw?.clobTokenIds);
  const conditionId = String(raw?.conditionId ?? raw?.condition_id ?? raw?.id ?? '');
  const orderDeadline = optionalIsoTime(
    raw?.orderDeadline,
    raw?.order_deadline,
    raw?.acceptingOrdersUntil,
    raw?.accepting_orders_until,
    raw?.lastOrderTime,
    raw?.last_order_time
  );
  const marketEnd = optionalIsoTime(
    raw?.endDateIso,
    raw?.endDate,
    raw?.end_date,
    raw?.endTime,
    raw?.end_time,
    raw?.closeTime,
    raw?.close_time,
    raw?.closeDate,
    raw?.close_date
  );
  const resolution = optionalIsoTime(
    raw?.resolutionTime,
    raw?.resolution_time,
    raw?.resolutionDate,
    raw?.resolution_date,
    raw?.settlementTime,
    raw?.settlement_time
  );
  const endTime = earliestIso(orderDeadline, marketEnd, resolution);
  // gameStartTime = sports kickoff/tip-off → treat as the market START so the short-event 已开赛 guard can skip +
  // cancel during in-play. isShortTimedEvent (duration <= shortEventMaxDurationMs) keeps long futures unaffected.
  const marketStart = optionalIsoTime(raw?.startsAt, raw?.starts_at, raw?.startTime, raw?.start_time, raw?.startDate, raw?.start_date, raw?.gameStartTime, raw?.game_start_time);
  const base = {
    venue: 'polymarket' as const,
    marketId: String(raw?.id ?? conditionId),
    conditionId,
    question: String(raw?.question_zh ?? raw?.questionZh ?? raw?.title_zh ?? raw?.titleZh ?? raw?.question ?? raw?.title ?? 'Polymarket market'),
    url: raw?.url,
    slug: raw?.slug ?? raw?.market_slug,
    volume24hUsd: toFiniteNumber(raw?.volume24hr, raw?.volume),
    liquidityUsd: toFiniteNumber(raw?.liquidityNum, raw?.liquidity),
    acceptingOrders: toOptionalBoolean(raw?.acceptingOrders, raw?.accepting_orders) ?? true,
    ...(marketStart ? { startTime: marketStart, startTimeSource: startTimeSource(undefined, marketStart) ?? 'unknown' as const } : {}),
    ...(endTime ? { endTime, endTimeSource: endTimeSource(orderDeadline, marketEnd, undefined, resolution) ?? 'unknown' as const } : {}),
    negRisk: Boolean(raw?.negRisk ?? raw?.neg_risk ?? raw?.isNegRisk ?? raw?.is_neg_risk ?? false),
    feeRateBps: 0,
    tickSize: normalizeTickSize(raw?.minimumTickSize ?? raw?.tickSize ?? raw?.tick_size)
  };
  const outcomePrices = toArray(raw?.outcomePrices)
    .map((value) => Number(value))
    .map((value) => (Number.isFinite(value) && value > 0 && value < 1 ? value : undefined));
  return tokenIds.map((tokenId, index) => ({
    ...base,
    tokenId,
    outcome: outcomes[index] ?? String(index),
    outcomeIndex: index,
    outcomeCount: tokenIds.length,
    rewards: polymarketRewardRules(raw, rewardsByToken.get(tokenId)),
    ...(outcomePrices[index] !== undefined ? { metadataPriceUsd: outcomePrices[index] } : {})
  }));
}
