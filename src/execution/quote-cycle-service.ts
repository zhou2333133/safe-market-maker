import type { AppConfig } from '../config/schema.js';
import type { AccountRiskDecision, Balance, OpenOrder, OrderIntent, Orderbook, Position, VenueName } from '../domain/types.js';
import { capitalUsage, isUnreservedPredictCashMakerBuy } from '../risk/capital-risk.js';
import type { SignerProvider } from '../secrets/signer.js';
import type { StateStore } from '../store/sqlite.js';
import { filterSplitIntentsToCompletePairs, hasCompleteOutcomeSet, isPairedEntryMode, splitOrderGroupKey } from '../strategy/paired-inventory.js';
import { rewardQuoteProtection } from '../strategy/rewards/common.js';
import { createRewardOptimizer } from '../strategy/rewards/factory.js';
import type { VenueAdapter } from '../venues/types.js';
import { HttpError } from '../venues/http.js';
import { ExecutionRecorder } from './event-recorder.js';
import { OrderGateService, type OrderGateResult } from './order-gate-service.js';
import { SubmitService, type PendingSubmittedOrder } from './submit-service.js';

export interface QuoteCycleInput {
  venue: VenueName;
  signer: SignerProvider;
  signerAddress: string;
  dayStart: number;
  intents: OrderIntent[];
  books: Map<string, Orderbook>;
  balances: Balance[];
  positions: Position[];
  openOrders: OpenOrder[];
  accountRiskDecision?: AccountRiskDecision;
}

export interface QuoteCycleResult {
  accepted: number;
  rejected: number;
  balanceSkipped: number;
  openOrders: OpenOrder[];
}

export interface QuoteCycleServiceOptions {
  postSubmitGroupVerifyTimeoutMs?: number;
}

export class QuoteCycleService {
  private readonly recorder: ExecutionRecorder;
  private readonly orderGateService: OrderGateService;
  private readonly submitService: SubmitService;

  constructor(
    private readonly config: AppConfig,
    private readonly adapter: VenueAdapter,
    private readonly store: StateStore,
    private readonly options: QuoteCycleServiceOptions = {}
  ) {
    this.recorder = new ExecutionRecorder(store);
    this.orderGateService = new OrderGateService(config, store);
    this.submitService = new SubmitService(config, adapter, store);
  }

  async process(input: QuoteCycleInput): Promise<QuoteCycleResult> {
    let accepted = 0;
    let rejected = 0;
    let balanceSkipped = 0;
    let remainingBalanceUsd = capitalUsage(this.config, input.balances, input.openOrders).spendableUsd;
    const openOrders = [...input.openOrders];

    const intents = filterSplitIntentsToCompletePairs(this.config, input.intents);
    const groupedIntents = isPairedEntryMode(this.config) ? splitIntentGroups(this.config, intents) : intents.map((intent) => [intent]);

    for (const group of groupedIntents) {
      const gateResults: Array<{ intent: OrderIntent; book: Orderbook; gate: OrderGateResult }> = [];
      const skippedExistingOrders: Array<{ intent: OrderIntent; order: OpenOrder }> = [];
      const submittedGroupIds: string[] = [];
      const effectiveGroup = this.capSplitGroupByCurrentPrices(group);
      for (const intent of group) {
        const book = input.books.get(intent.tokenId);
        if (!book) continue;
        const effectiveIntent = effectiveGroup.get(intent.tokenId) ?? intent;
        const gate = this.orderGateService.evaluate({
          venue: input.venue,
          intent: effectiveIntent,
          book,
          balances: input.balances,
          positions: input.positions,
          openOrders,
          remainingBalanceUsd
        });
        if (gate.status === 'skipped-existing') {
          if (gate.managed) skippedExistingOrders.push({ intent: effectiveIntent, order: gate.existingOrder });
          continue;
        }
        if (gate.status === 'rejected') {
          rejected += 1;
          if (gate.balanceSkipped) balanceSkipped += 1;
          gateResults.push({ intent: effectiveIntent, book, gate });
          continue;
        }
        gateResults.push({ intent: effectiveIntent, book, gate });
      }

      if (isPairedEntryMode(this.config) && gateResults.some((item) => item.gate.status === 'rejected')) {
        await this.cancelIncompleteSplitGroupOrders(input.venue, openOrders, group, submittedGroupIds);
        continue;
      }
      if (isPairedEntryMode(this.config) && gateResults.length === 0) {
        if (skippedExistingOrders.length === group.length && this.existingSplitOrdersMatchGroup(skippedExistingOrders, effectiveGroup)) continue;
        await this.cancelIncompleteSplitGroupOrders(input.venue, openOrders, group, submittedGroupIds);
        continue;
      }
      if (isPairedEntryMode(this.config) && !hasCompleteOutcomeSet(group.map((intent) => intent.market), new Set(group.map((intent) => intent.tokenId)))) {
        await this.cancelIncompleteSplitGroupOrders(input.venue, openOrders, group, submittedGroupIds);
        continue;
      }
      if (isPairedEntryMode(this.config)) {
        if (!this.existingSplitOrdersMatchGroup(skippedExistingOrders, effectiveGroup)) {
          await this.cancelIncompleteSplitGroupOrders(input.venue, openOrders, group, submittedGroupIds);
          continue;
        }
        const result = await this.submitSplitGroup({
          venue: input.venue,
          signer: input.signer,
          signerAddress: input.signerAddress,
          dayStart: input.dayStart,
          group,
          gateResults,
          positions: input.positions,
          openOrders,
          accountRiskDecision: input.accountRiskDecision
        });
        accepted += result.accepted;
        rejected += result.rejected;
        continue;
      }
      let groupCompromised = false;
      for (const item of gateResults) {
        if (item.gate.status !== 'ready') continue;
        const intent = item.intent;
        const book = item.book;
        let submit;
        try {
          submit = await this.submitService.submit({
            venue: input.venue,
            signer: input.signer,
            signerAddress: input.signerAddress,
            dayStart: input.dayStart,
            intent,
            initialBook: book,
            positions: input.positions,
            openOrders,
            accountRiskDecision: input.accountRiskDecision
          });
        } catch (error) {
          if (isPairedEntryMode(this.config)) await this.cancelIncompleteSplitGroupOrders(input.venue, openOrders, group, submittedGroupIds);
          if (isOrderLevelSubmitRejection(error)) {
            rejected += 1;
            this.recordSingleOrderSubmitRejected(input.venue, intent, error);
            continue;
          }
          throw error;
        }
        if (submit.status === 'rejected') {
          rejected += 1;
          if (isPairedEntryMode(this.config)) {
            await this.cancelIncompleteSplitGroupOrders(input.venue, openOrders, group, submittedGroupIds);
            groupCompromised = true;
            break;
          }
          continue;
        }
        if (submit.externalId) submittedGroupIds.push(submit.externalId);
        if (isPairedEntryMode(this.config) && submit.verifiedOpen === false) {
          rejected += 1;
          await this.cancelIncompleteSplitGroupOrders(input.venue, openOrders, group, submittedGroupIds);
          this.recorder.event({
            venue: input.venue,
            severity: 'error',
            type: 'split.pair-submit-unverified',
            message: '双边 SELL 提交后未能在平台开放订单里确认，已停止本组后续提交并尝试撤回',
            details: {
              clientOrderId: item.intent.clientOrderId,
              externalId: submit.externalId,
              submittedGroupIds,
              tokenIds: group.map((groupIntent) => groupIntent.tokenId)
            }
          });
          groupCompromised = true;
          break;
        }
        accepted += 1;
        if (intent.side === 'BUY' && !isUnreservedPredictCashMakerBuy(this.config, intent)) {
          remainingBalanceUsd = Math.max(0, remainingBalanceUsd - intent.notionalUsd);
        }
        if (submit.openOrder) {
          openOrders.push(submit.openOrder);
        }
      }
      if (groupCompromised) continue;
    }

    const result = { accepted, rejected, balanceSkipped, openOrders };
    this.recordSummary(input.venue, result);
    return result;
  }

  private async cancelSubmittedGroupOrders(
    venue: VenueName,
    openOrders: OpenOrder[],
    group: OrderIntent[],
    submittedExternalIds: string[] = [],
    options: { includeExistingManagedGroupOrders?: boolean } = { includeExistingManagedGroupOrders: true }
  ): Promise<void> {
    const tokenIds = new Set(group.map((intent) => intent.tokenId));
    const managedIds = new Set(this.store.listManagedOpenOrders(venue).map((order) => order.externalId).filter(Boolean));
    const ids = [
      ...submittedExternalIds,
      ...(options.includeExistingManagedGroupOrders === false
        ? []
        : openOrders
          .filter((order) => order.side === 'SELL' && tokenIds.has(order.tokenId) && managedIds.has(order.externalId))
          .map((order) => order.externalId))
    ].filter(Boolean);
    if (ids.length === 0) return;
    await this.submitService.cancelSubmittedOrders(venue, ids);
    for (let i = openOrders.length - 1; i >= 0; i -= 1) {
      if (ids.includes(openOrders[i]?.externalId ?? '')) openOrders.splice(i, 1);
    }
  }

  private async cancelIncompleteSplitGroupOrders(
    venue: VenueName,
    openOrders: OpenOrder[],
    group: OrderIntent[],
    submittedExternalIds: string[] = []
  ): Promise<void> {
    await this.cancelSubmittedGroupOrders(venue, openOrders, group, submittedExternalIds);
    this.recorder.event({
      venue,
      severity: 'warn',
      type: 'split.pair-incomplete-cancel',
      message: '双边 SELL 组未完整通过，已撤回同组机器人开放订单',
      details: {
        tokenIds: group.map((intent) => intent.tokenId),
        submittedExternalIds
      }
    });
  }

  private recordSummary(venue: VenueName, result: QuoteCycleResult): void {
    this.recorder.metric('run.accepted_orders', result.accepted, venue);
    this.recorder.metric('run.rejected_orders', result.rejected, venue);
    this.recorder.metric('run.balance_skipped_orders', result.balanceSkipped, venue);
    this.recorder.runCheckpoint(venue, {
      accepted: result.accepted,
      rejected: result.rejected,
      balanceSkipped: result.balanceSkipped
    });
  }

  private recordSingleOrderSubmitRejected(venue: VenueName, intent: OrderIntent, error: unknown): void {
    this.recorder.event({
      venue,
      severity: 'warn',
      type: 'order.submit-rejected',
      message: '单边订单被平台拒绝，本轮继续尝试其他安全候选',
      details: {
        clientOrderId: intent.clientOrderId,
        tokenId: intent.tokenId,
        side: intent.side,
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof HttpError ? { httpStatus: error.status, httpBody: error.body } : {})
      }
    });
  }

  private async submitSplitGroup(input: {
    venue: VenueName;
    signer: SignerProvider;
    signerAddress: string;
    dayStart: number;
    group: OrderIntent[];
    gateResults: Array<{ intent: OrderIntent; book: Orderbook; gate: OrderGateResult }>;
    positions: Position[];
    openOrders: OpenOrder[];
    accountRiskDecision?: AccountRiskDecision;
  }): Promise<{ accepted: number; rejected: number }> {
    const preparedGateResults = await this.prepareSplitGroupForSubmit(input.venue, input.group, input.gateResults);
    if (!preparedGateResults) {
      await this.cancelIncompleteSplitGroupOrders(input.venue, input.openOrders, input.group);
      return { accepted: 0, rejected: 1 };
    }
    const submittedGroup: PendingSubmittedOrder[] = [];
    for (const item of preparedGateResults) {
      if (item.gate.status !== 'ready') continue;
      let submit;
      try {
        submit = await this.submitService.submit({
          venue: input.venue,
          signer: input.signer,
          signerAddress: input.signerAddress,
          dayStart: input.dayStart,
          intent: item.intent,
          initialBook: item.book,
          positions: input.positions,
          openOrders: input.openOrders,
          repriceRewardQuote: false,
          verifyOpen: false,
          accountRiskDecision: input.accountRiskDecision
        });
      } catch (error) {
        await this.cancelIncompleteSplitGroupOrders(input.venue, input.openOrders, input.group, submittedGroup.map((order) => order.externalId));
        if (isFatalSubmitException(error)) throw error;
        this.recorder.event({
          venue: input.venue,
          severity: 'warn',
          type: 'split.pair-submit-rejected',
          message: '双边 SELL 组提交被平台拒绝，已撤回同组订单并等待下一轮重新评估',
          details: {
            error: error instanceof Error ? error.message : String(error),
            submittedGroupIds: submittedGroup.map((order) => order.externalId),
            tokenIds: input.group.map((intent) => intent.tokenId)
          }
        });
        return { accepted: 0, rejected: 1 };
      }
      if (submit.status === 'rejected') {
        await this.cancelIncompleteSplitGroupOrders(input.venue, input.openOrders, input.group, submittedGroup.map((order) => order.externalId));
        return { accepted: 0, rejected: 1 };
      }
      if (!submit.externalId || !submit.submittedIntent) {
        await this.cancelIncompleteSplitGroupOrders(input.venue, input.openOrders, input.group, submittedGroup.map((order) => order.externalId));
        this.recorder.event({
          venue: input.venue,
          severity: 'error',
          type: 'split.pair-submit-unverified',
          message: '双边 SELL 组里有订单没有返回平台订单 ID，已尝试撤回本组',
          details: {
            clientOrderId: item.intent.clientOrderId,
            submittedGroupIds: submittedGroup.map((order) => order.externalId),
            tokenIds: input.group.map((intent) => intent.tokenId)
          }
        });
        return { accepted: 0, rejected: 1 };
      }
      submittedGroup.push({
        clientOrderId: item.intent.clientOrderId,
        externalId: submit.externalId,
        intent: submit.submittedIntent,
        submitRaw: submit.raw
      });
    }

    const existingGroupOrders = this.groupExistingOpenOrders(input.openOrders, input.group);
    const completeExistingCount = existingGroupOrders.length;
    if (submittedGroup.length === 0) {
      if (completeExistingCount === input.group.length) return { accepted: 0, rejected: 0 };
      await this.cancelIncompleteSplitGroupOrders(input.venue, input.openOrders, input.group);
      return { accepted: 0, rejected: 1 };
    }

    const verification = await this.submitService.verifySubmittedOpenOrders(
      input.venue,
      input.signerAddress,
      submittedGroup,
      this.options.postSubmitGroupVerifyTimeoutMs
    );
    if (!verification.ok) {
      if (isDelayedOpenOrderVisibility(verification, submittedGroup.length, completeExistingCount)) {
        const verifiedSubmittedOrders = verification.verified.map(({ submitted, order }) => this.submitService.recordVerifiedSubmittedOpenOrder(input.venue, submitted, order));
        if (verifiedSubmittedOrders.length > 0) input.openOrders.push(...verifiedSubmittedOrders);
        const verifiedIds = new Set(verification.verified.map((entry) => entry.submitted.externalId));
        const unverifiedSubmitted = submittedGroup.filter((submitted) => !verifiedIds.has(submitted.externalId));
        const pending = this.submitService.recordPendingSubmittedOpenOrders(input.venue, unverifiedSubmitted, verification);
        input.openOrders.push(...pending.pendingOrders);
        const prospectiveOrders = mergeOpenOrdersByExternalId([...existingGroupOrders, ...verifiedSubmittedOrders, ...pending.pendingOrders]);
        if (this.splitGroupOverBudget(prospectiveOrders)) {
          await this.cancelSubmittedGroupOrders(input.venue, input.openOrders, input.group, submittedGroup.map((order) => order.externalId));
          this.recordSplitGroupBudgetExceeded(input.venue, prospectiveOrders);
          return { accepted: 0, rejected: 1 };
        }
        this.recorder.event({
          venue: input.venue,
          severity: 'warn',
          type: 'split.pair-submit-pending-confirmation',
          message: '双边 SELL 已提交成功，等待平台开放订单接口确认完整显示',
          details: {
            pending,
            verifiedOrderIds: verifiedSubmittedOrders.map((order) => order.externalId),
            submittedGroupIds: submittedGroup.map((order) => order.externalId),
            tokenIds: input.group.map((intent) => intent.tokenId)
          }
        });
        return { accepted: 0, rejected: 0 };
      }
      const submittedIds = submittedGroup.map((order) => order.externalId);
      await this.cancelSubmittedGroupOrders(input.venue, input.openOrders, input.group, submittedIds, {
        includeExistingManagedGroupOrders: submittedGroup.length >= input.group.length
      });
      this.recorder.event({
        venue: input.venue,
        severity: 'error',
        type: 'split.pair-submit-unverified',
        message: submittedGroup.length >= input.group.length
          ? '双边 SELL 提交后未能作为完整组在平台开放订单里确认，已尝试撤回本组'
          : '补充的双边 SELL 订单未能在平台开放订单里确认，已撤回本次新提交订单，保留已有订单',
        details: {
          verification,
          submittedGroupIds: submittedIds,
          keptExistingOrderIds: existingGroupOrders.map((order) => order.externalId),
          tokenIds: input.group.map((intent) => intent.tokenId)
        }
      });
      return { accepted: 0, rejected: 1 };
    }

    const verifiedSubmittedOrders = verification.orders.map(({ submitted, order }) => this.submitService.recordVerifiedSubmittedOpenOrder(input.venue, submitted, order));
    const verifiedOrders = mergeOpenOrdersByExternalId([...existingGroupOrders, ...verifiedSubmittedOrders]);
    input.openOrders.push(...verifiedSubmittedOrders);
    if (this.splitGroupOverBudget(verifiedOrders)) {
      await this.cancelSubmittedGroupOrders(input.venue, input.openOrders, input.group, submittedGroup.map((order) => order.externalId));
      this.recordSplitGroupBudgetExceeded(input.venue, verifiedOrders);
      return { accepted: 0, rejected: 1 };
    }
    this.recorder.event({
      venue: input.venue,
      type: 'split.pair-submit-verified',
      message: `双边 SELL 已完整确认：${verifiedOrders.length} 个订单`,
      details: {
        attempts: verification.attempts,
        orderIds: verifiedOrders.map((order) => order.externalId),
        existingOrderIds: existingGroupOrders.map((order) => order.externalId),
        submittedOrderIds: verifiedSubmittedOrders.map((order) => order.externalId),
        tokenIds: input.group.map((intent) => intent.tokenId)
      }
    });
    return { accepted: verifiedSubmittedOrders.length, rejected: 0 };
  }

  private async prepareSplitGroupForSubmit(
    venue: VenueName,
    group: OrderIntent[],
    gateResults: Array<{ intent: OrderIntent; book: Orderbook; gate: OrderGateResult }>
  ): Promise<Array<{ intent: OrderIntent; book: Orderbook; gate: OrderGateResult }> | undefined> {
    if (!isPairedEntryMode(this.config) || (this.config.strategy.enforceRewardMinimum ?? true)) return gateResults;
    const ready = gateResults.filter((item) => item.gate.status === 'ready');
    if (ready.length === 0) return gateResults;
    const finalByToken = new Map<string, { intent: OrderIntent; book: Orderbook }>();
    const finalConfig = {
      ...this.config,
      strategy: {
        ...this.config.strategy,
        quoteSide: 'sell' as const,
        inventorySkewEnabled: false
      }
    };
    const finalOptimizer = createRewardOptimizer(venue, finalConfig);
    for (const item of ready) {
      let freshBook: Orderbook;
      try {
        freshBook = await this.adapter.getOrderbook(item.intent.tokenId);
      } catch {
        return undefined;
      }
      const freshQuote = finalOptimizer.buildQuote(item.intent.market, freshBook, item.intent.side, {
        config: finalConfig,
        positions: [{ venue, tokenId: item.intent.tokenId, size: Number.MAX_SAFE_INTEGER, notionalUsd: Number.MAX_SAFE_INTEGER }]
      });
      if (!freshQuote) {
        this.recorder.event({
          venue,
          severity: 'warn',
          type: 'split.pair-final-price-rejected',
          message: '最终重定价无法生成通过双边 SELL 保护的报价，放弃本组',
          details: {
            tokenId: item.intent.tokenId,
            tokenIds: group.map((intent) => intent.tokenId)
          }
        });
        return undefined;
      }
      finalByToken.set(item.intent.tokenId, {
        book: freshBook,
        intent: {
          ...item.intent,
          price: freshQuote.price,
          notionalUsd: Number((item.intent.size * freshQuote.price).toFixed(4)),
          reason: `${item.intent.reason}|final-repriced:${freshQuote.reason}`,
          reward: {
            optimizer: finalOptimizer.constructor.name,
            score: freshQuote.rewardScore,
            level: freshQuote.rewardLevel,
            ...(freshQuote.minRewardShares ? { minShares: freshQuote.minRewardShares } : {}),
            ...(freshQuote.maxRewardSpreadCents ? { maxSpreadCents: freshQuote.maxRewardSpreadCents } : {})
          }
        }
      });
    }
    const groupWithFinalPrices = group.map((intent) => finalByToken.get(intent.tokenId)?.intent ?? intent);
    const capped = this.capSplitGroupByCurrentPrices(groupWithFinalPrices);
    const unsafe = [...capped.values()].find((intent) => intent.price < this.config.risk.minPrice || intent.price > this.config.risk.maxPrice);
    if (unsafe) {
      this.recorder.event({
        venue,
        severity: 'warn',
        type: 'split.pair-final-price-rejected',
        message: `最终重定价 ${unsafe.price} 超出安全价格带，放弃本组双边 SELL`,
        details: {
          tokenId: unsafe.tokenId,
          price: unsafe.price,
          minPrice: this.config.risk.minPrice,
          maxPrice: this.config.risk.maxPrice,
          tokenIds: group.map((intent) => intent.tokenId)
        }
      });
      return undefined;
    }
    const unprotected = [...capped.values()]
      .map((intent) => ({ intent, final: finalByToken.get(intent.tokenId) }))
      .find(({ intent, final }) => final && !rewardQuoteProtection(this.config, intent.side, intent.price, final.book, intent.market).ok);
    if (unprotected?.final) {
      const protection = rewardQuoteProtection(this.config, unprotected.intent.side, unprotected.intent.price, unprotected.final.book, unprotected.intent.market);
      this.recorder.event({
        venue,
        severity: 'warn',
        type: 'split.pair-final-price-rejected',
        message: `最终重定价 ${unprotected.intent.price} 未通过双边 SELL 保护，放弃本组`,
        details: {
          tokenId: unprotected.intent.tokenId,
          price: unprotected.intent.price,
          protection,
          tokenIds: group.map((intent) => intent.tokenId)
        }
      });
      return undefined;
    }
    return gateResults.map((item) => {
      if (item.gate.status !== 'ready') return item;
      const final = finalByToken.get(item.intent.tokenId);
      const intent = capped.get(item.intent.tokenId) ?? final?.intent ?? item.intent;
      return { ...item, intent, book: final?.book ?? item.book };
    });
  }

  private capSplitGroupByCurrentPrices(group: OrderIntent[]): Map<string, OrderIntent> {
    if (!isPairedEntryMode(this.config)) return new Map(group.map((intent) => [intent.tokenId, intent] as const));
    if (this.config.strategy.enforceRewardMinimum ?? true) return new Map(group.map((intent) => [intent.tokenId, intent] as const));
    if (group.length === 0) return new Map();
    const totalGroupPrice = group.reduce((sum, intent) => sum + Math.max(0, intent.price), 0);
    const targetShares = Math.min(...group.map((intent) =>
      Math.min(
        intent.size,
        this.config.risk.orderSizeUsd / Math.max(intent.price, 0.0001),
        this.config.risk.orderSizeUsd / Math.max(totalGroupPrice, 0.0001)
      )
    ));
    if (!Number.isFinite(targetShares) || targetShares <= 0) return new Map(group.map((intent) => [intent.tokenId, intent] as const));
    const roundedShares = Number(targetShares.toFixed(4));
    return new Map(group.map((intent) => {
      const capped = {
        ...intent,
        size: roundedShares,
        notionalUsd: Number((intent.price * roundedShares).toFixed(4)),
        reason: intent.size === roundedShares ? intent.reason : `${intent.reason}|paired-budget-capped`
      };
      return [intent.tokenId, capped] as const;
    }));
  }

  private existingSplitOrdersMatchGroup(
    skippedExistingOrders: Array<{ intent: OrderIntent; order: OpenOrder }>,
    effectiveGroup: Map<string, OrderIntent>
  ): boolean {
    if (!isPairedEntryMode(this.config)) return true;
    const tolerance = 0.0001;
    for (const { intent, order } of skippedExistingOrders) {
      const target = effectiveGroup.get(intent.tokenId) ?? intent;
      if (Math.abs(order.size - target.size) > Math.max(tolerance, target.size * 0.001)) return false;
      if (Math.abs(order.price - target.price) > 0.000001) return false;
      if (!(this.config.strategy.enforceRewardMinimum ?? true) && order.price * order.size > this.config.risk.orderSizeUsd + 0.01) return false;
    }
    return true;
  }

  private splitGroupOverBudget(orders: OpenOrder[]): boolean {
    if (!isPairedEntryMode(this.config) || (this.config.strategy.enforceRewardMinimum ?? true)) return false;
    const total = orders
      .filter((order) => ['OPEN', 'PENDING_OPEN'].includes(order.status))
      .reduce((sum, order) => sum + order.price * order.size, 0);
    return total > this.config.risk.orderSizeUsd + 0.01;
  }

  private recordSplitGroupBudgetExceeded(venue: VenueName, orders: OpenOrder[]): void {
    this.recorder.event({
      venue,
      severity: 'error',
      type: 'split.pair-budget-exceeded-cancel',
      message: '双边 SELL 组最终金额超过 split 总预算，已撤回同组机器人订单',
      details: {
        orderSizeUsd: this.config.risk.orderSizeUsd,
        totalNotionalUsd: Number(orders.reduce((sum, order) => sum + order.price * order.size, 0).toFixed(4)),
        orders: orders.map((order) => ({
          externalId: order.externalId,
          tokenId: order.tokenId,
          side: order.side,
          price: order.price,
          size: order.size,
          notionalUsd: Number((order.price * order.size).toFixed(4)),
          status: order.status
        }))
      }
    });
  }

  private groupExistingOpenOrders(openOrders: OpenOrder[], group: OrderIntent[]): OpenOrder[] {
    const tokenIds = new Set(group.map((intent) => intent.tokenId));
    return latestOpenOrdersByToken(openOrders.filter((order) => order.status === 'OPEN' && order.side === 'SELL' && tokenIds.has(order.tokenId)));
  }
}

function splitIntentGroups(config: AppConfig, intents: OrderIntent[]): OrderIntent[][] {
  const groups = new Map<string, OrderIntent[]>();
  for (const intent of intents) {
    const key = splitOrderGroupKey(config, intent);
    const list = groups.get(key) ?? [];
    list.push(intent);
    groups.set(key, list);
  }
  return [...groups.values()].filter((group) => hasCompleteOutcomeSet(group.map((intent) => intent.market), new Set(group.map((intent) => intent.tokenId))));
}

function isDelayedOpenOrderVisibility(
  verification: { missing: string[]; mismatches: Array<unknown>; reason: string },
  submittedCount: number,
  existingCount = 0
): boolean {
  return submittedCount + existingCount > 1
    && verification.reason === 'not-found-in-open-orders'
    && verification.missing.length > 0
    && verification.mismatches.length === 0;
}

function mergeOpenOrdersByExternalId(orders: OpenOrder[]): OpenOrder[] {
  const byId = new Map<string, OpenOrder>();
  for (const order of orders) byId.set(order.externalId, order);
  return [...byId.values()];
}

function latestOpenOrdersByToken(orders: OpenOrder[]): OpenOrder[] {
  const byToken = new Map<string, OpenOrder>();
  for (const order of orders) byToken.set(order.tokenId, order);
  return [...byToken.values()];
}

function isFatalSubmitException(error: unknown): boolean {
  if (error instanceof HttpError) return error.status === 401 || error.status === 403;
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return lower.includes('jwt is required')
    || lower.includes('private_key')
    || lower.includes('private key')
    || lower.includes('私钥')
    || lower.includes('签名');
}

export function isOrderLevelSubmitRejection(error: unknown): boolean {
  if (error instanceof HttpError) return error.status === 400 || error.status === 422;
  // Polymarket's CLOB SDK throws a PLAIN Error (not an HttpError) for per-order rejections — createOrder sees
  // response.success === false and rethrows the message. The big one for the over-rest farming model is
  // "not enough balance / allowance" when resting orders would exceed the wallet (with negRisk netting): that is a
  // per-ORDER problem (skip THAT order, keep the rest), never a reason to kill the loop — a dead loop can't cancel its
  // GTD orders or keep farming. Same for post-only-would-cross and sub-minimum size. Matched on message because the
  // SDK gives us no status code here.
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return [
    'not enough balance',
    'balance is not enough',
    'not enough allowance',
    'would cross',
    'would match',
    'marketable',
    'post only',
    'post-only',
    'min size',
    'minimum size',
    'order size',
    'too small',
    'invalid price',
    'tick size',
    'order rejected'
  ].some((needle) => message.includes(needle));
}
