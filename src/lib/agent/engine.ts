import { mockTrackingNumber, suggestCarrier } from "@/lib/adapters/mock";
import type { AdapterResult, XianyuAdapter } from "@/lib/adapters/types";
import type {
  ActionPayload,
  AgentAction,
  AppState,
  AutomationRule,
  Conversation,
  Listing,
  Order,
  RiskLevel,
  RuleKind,
} from "@/lib/domain/types";
import { daysSince, hoursSince, parseYuanToCents, yuan } from "@/lib/format";
import {
  INTENT_LABEL,
  awaitingSellerReply,
  classifyIntent,
  draftReply,
  lastBuyerMessage,
} from "./reply";

export interface Proposal {
  ruleId: string;
  ruleKind: RuleKind;
  title: string;
  reason: string;
  risk: RiskLevel;
  payload: ActionPayload;
  /** 即便规则设置为自动执行，也强制走人工审批（例如低置信度的回复草稿） */
  forceApproval?: boolean;
}

export function actionKey(payload: ActionPayload): string {
  switch (payload.type) {
    case "refresh_listing":
    case "delist_listing":
      return `${payload.type}:${payload.listingId}`;
    case "adjust_price":
      return `${payload.type}:${payload.listingId}`;
    case "send_reply":
      return `${payload.type}:${payload.conversationId}`;
    case "ship_order":
      return `${payload.type}:${payload.orderId}`;
  }
}

function findRule(state: AppState, kind: RuleKind): AutomationRule | undefined {
  return state.rules.find((r) => r.kind === kind && r.enabled);
}

function roundToYuan(cents: number): number {
  return Math.round(cents / 100) * 100;
}

function proposeRefresh(state: AppState, now: number): Proposal[] {
  const rule = findRule(state, "refresh_listing");
  if (!rule) return [];
  const minHours = rule.params.minHoursSinceRefresh ?? 24;
  const maxPerRun = rule.params.maxPerRun ?? 5;

  return state.listings
    .filter((l) => l.status === "on_sale" && l.stock > 0)
    .map((l) => ({ listing: l, stale: hoursSince(l.lastRefreshedAt, now) }))
    .filter(({ stale }) => stale >= minHours)
    .sort((a, b) => b.stale - a.stale)
    .slice(0, maxPerRun)
    .map(({ listing, stale }) => ({
      ruleId: rule.id,
      ruleKind: rule.kind,
      title: `擦亮「${listing.title}」`,
      reason: `距上次擦亮已 ${Math.floor(stale)} 小时（阈值 ${minHours} 小时），擦亮后可重新排到搜索前排。`,
      risk: "low" as const,
      payload: { type: "refresh_listing", listingId: listing.id },
    }));
}

function proposePriceDrop(state: AppState, now: number): Proposal[] {
  const rule = findRule(state, "price_drop");
  if (!rule) return [];
  const staleDays = rule.params.staleDays ?? 14;
  const maxViews = rule.params.maxViews7d ?? 300;
  const stepPercent = rule.params.stepPercent ?? 5;
  const maxPerRun = rule.params.maxPerRun ?? 2;

  const candidates = state.listings
    .filter(
      (l) =>
        l.status === "on_sale" &&
        l.stock > 0 &&
        l.priceCents > l.floorPriceCents &&
        daysSince(l.createdAt, now) >= staleDays &&
        l.views7d <= maxViews,
    )
    .sort((a, b) => daysSince(b.createdAt, now) - daysSince(a.createdAt, now))
    .slice(0, maxPerRun);

  const proposals: Proposal[] = [];
  for (const listing of candidates) {
    const target = Math.max(
      listing.floorPriceCents,
      roundToYuan(listing.priceCents * (1 - stepPercent / 100)),
    );
    if (target >= listing.priceCents) continue;
    const hitFloor = target === listing.floorPriceCents;
    proposals.push({
      ruleId: rule.id,
      ruleKind: rule.kind,
      title: `降价 ${yuan(listing.priceCents)} → ${yuan(target)}：${listing.title}`,
      reason:
        `上架 ${Math.floor(daysSince(listing.createdAt, now))} 天，近 7 天仅 ${listing.views7d} 次浏览` +
        `（阈值 ${maxViews}）。按 ${stepPercent}% 下调${hitFloor ? "，已触及你设定的底价，不会再低" : ""}。`,
      risk: "medium",
      payload: {
        type: "adjust_price",
        listingId: listing.id,
        fromCents: listing.priceCents,
        toCents: target,
      },
    });
  }
  return proposals;
}

function latestOrderForConversation(
  state: AppState,
  conversation: Conversation,
): Order | undefined {
  return state.orders
    .filter(
      (o) => o.listingId === conversation.listingId && o.buyerName === conversation.buyerName,
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
}

function proposeReplies(state: AppState): Proposal[] {
  const rule = findRule(state, "auto_reply");
  if (!rule) return [];
  const maxPerRun = rule.params.maxPerRun ?? 6;

  return state.conversations
    .filter(awaitingSellerReply)
    .sort((a, b) => {
      const at = Date.parse(a.messages.at(-1)?.createdAt ?? "");
      const bt = Date.parse(b.messages.at(-1)?.createdAt ?? "");
      return at - bt;
    })
    .slice(0, maxPerRun)
    .map((conversation) => {
      const listing = state.listings.find((l) => l.id === conversation.listingId);
      const draft = draftReply({
        conversation,
        listing,
        settings: state.settings,
        order: latestOrderForConversation(state, conversation),
      });
      const risk: RiskLevel =
        draft.intent === "after_sale"
          ? "high"
          : draft.intent === "bargain"
            ? "medium"
            : "low";
      return {
        ruleId: rule.id,
        ruleKind: rule.kind,
        title: `回复「${conversation.buyerName}」（${INTENT_LABEL[draft.intent]}）`,
        reason:
          `买家消息判定为「${INTENT_LABEL[draft.intent]}」，置信度 ${(draft.confidence * 100).toFixed(0)}%。` +
          (draft.counterOfferCents
            ? `还价 ${yuan(draft.counterOfferCents)}，不低于底价。`
            : "") +
          (draft.needsHumanEdit ? "涉及无法自动核实的细节，建议人工确认后再发。" : ""),
        risk,
        payload: {
          type: "send_reply" as const,
          conversationId: conversation.id,
          text: draft.text,
        },
        forceApproval: draft.needsHumanEdit || draft.confidence < 0.6,
      };
    });
}

function proposeShipments(state: AppState, now: number): Proposal[] {
  const rule = findRule(state, "shipment_reminder");
  if (!rule) return [];
  const graceHours = rule.params.graceHours ?? state.settings.shipWithinHours;

  return state.orders
    .filter(
      (o) => o.status === "pending_shipment" && o.paidAt && hoursSince(o.paidAt, now) >= graceHours,
    )
    .map((order) => ({
      ruleId: rule.id,
      ruleKind: rule.kind,
      title: `备货发出订单 ${order.id}`,
      reason: `买家 ${order.buyerName} 已付款 ${Math.floor(
        hoursSince(order.paidAt!, now),
      )} 小时，超过承诺的 ${graceHours} 小时时效，再拖会影响店铺体验分。`,
      risk: "high" as const,
      payload: {
        type: "ship_order" as const,
        orderId: order.id,
        carrier: suggestCarrier(order.id),
        trackingNo: mockTrackingNumber(order.id, now),
      },
    }));
}

function proposeDelist(state: AppState): Proposal[] {
  const rule = findRule(state, "sold_out_delist");
  if (!rule) return [];

  return state.listings
    .filter((l) => l.status === "on_sale" && l.stock <= 0)
    .map((listing) => ({
      ruleId: rule.id,
      ruleKind: rule.kind,
      title: `下架零库存商品「${listing.title}」`,
      reason: "库存为 0 但仍在售，继续挂着可能超卖并引发纠纷。",
      risk: "low" as const,
      payload: { type: "delist_listing" as const, listingId: listing.id },
    }));
}

/** 纯函数：给定状态和时间，算出这一轮 Agent 想做的事。 */
export function proposeActions(state: AppState, now: number): Proposal[] {
  const pendingKeys = new Set(
    state.actions.filter((a) => a.status === "pending").map((a) => actionKey(a.payload)),
  );

  return [
    ...proposeReplies(state),
    ...proposeShipments(state, now),
    ...proposePriceDrop(state, now),
    ...proposeRefresh(state, now),
    ...proposeDelist(state),
  ].filter((proposal) => !pendingKeys.has(actionKey(proposal.payload)));
}

export function applyAction(
  state: AppState,
  action: AgentAction,
  adapter: XianyuAdapter,
  now: number,
): AdapterResult {
  const { payload } = action;
  switch (payload.type) {
    case "refresh_listing":
      return adapter.refreshListing(state, payload.listingId, now);
    case "adjust_price":
      return adapter.updatePrice(state, payload.listingId, payload.toCents, now);
    case "delist_listing":
      return adapter.delistListing(state, payload.listingId, now);
    case "send_reply":
      return adapter.sendMessage(state, payload.conversationId, payload.text, now);
    case "ship_order":
      return adapter.shipOrder(
        state,
        payload.orderId,
        payload.carrier,
        payload.trackingNo,
        now,
      );
  }
}

export interface ActionEdits {
  text?: string;
  /** 元为单位的价格输入，解析失败会被拒绝 */
  priceInput?: string;
  carrier?: string;
  trackingNo?: string;
}

/**
 * 人工改完内容再执行。
 *
 * 先在 payload 副本上改，执行成功了才写回 —— 一次被拒绝的编辑
 * （比如把价格填到底价以下）不能把队列里的建议改坏。
 */
export function applyActionWithEdits(
  state: AppState,
  action: AgentAction,
  edits: ActionEdits,
  adapter: XianyuAdapter,
  now: number,
): AdapterResult {
  const payload = { ...action.payload };

  if (payload.type === "send_reply" && edits.text !== undefined) {
    if (!edits.text.trim()) return { ok: false, message: "回复内容不能为空。" };
    payload.text = edits.text.trim();
  }
  if (payload.type === "adjust_price" && edits.priceInput !== undefined) {
    const cents = parseYuanToCents(edits.priceInput);
    if (cents === null) return { ok: false, message: "价格格式不对，试试 199 或 199.50。" };
    payload.toCents = cents;
  }
  if (payload.type === "ship_order") {
    if (edits.carrier !== undefined) payload.carrier = edits.carrier.trim();
    if (edits.trackingNo !== undefined) payload.trackingNo = edits.trackingNo.trim();
    if (!payload.carrier || !payload.trackingNo) {
      return { ok: false, message: "请填写快递公司和运单号。" };
    }
  }

  const outcome = applyAction(state, { ...action, payload }, adapter, now);
  if (outcome.ok) action.payload = payload;
  return outcome;
}

let actionCounter = 0;

export function newActionId(now: number): string {
  actionCounter += 1;
  return `ACT-${now.toString(36)}-${actionCounter.toString(36)}`;
}

export function toAction(
  proposal: Proposal,
  now: number,
  status: AgentAction["status"] = "pending",
  decidedBy?: AgentAction["decidedBy"],
): AgentAction {
  return {
    id: newActionId(now),
    ruleId: proposal.ruleId,
    ruleKind: proposal.ruleKind,
    title: proposal.title,
    reason: proposal.reason,
    risk: proposal.risk,
    status,
    createdAt: new Date(now).toISOString(),
    decidedAt: status === "pending" ? undefined : new Date(now).toISOString(),
    decidedBy,
    payload: proposal.payload,
  };
}

export interface TickResult {
  queued: AgentAction[];
  applied: AgentAction[];
  failures: string[];
  messages: string[];
}

/** 跑一轮 Agent：产生提案，自动执行低风险项，其余进审批队列。 */
export function runTick(
  state: AppState,
  adapter: XianyuAdapter,
  now: number,
): TickResult {
  const proposals = proposeActions(state, now);
  const result: TickResult = { queued: [], applied: [], failures: [], messages: [] };

  for (const proposal of proposals) {
    const rule = state.rules.find((r) => r.id === proposal.ruleId);
    const needsApproval = rule?.requiresApproval !== false || proposal.forceApproval === true;

    if (needsApproval) {
      const action = toAction(proposal, now);
      state.actions.unshift(action);
      result.queued.push(action);
      continue;
    }

    const action = toAction(proposal, now, "applied", "agent");
    const outcome = applyAction(state, action, adapter, now);
    if (outcome.ok) {
      state.actions.unshift(action);
      result.applied.push(action);
      result.messages.push(outcome.message);
    } else {
      result.failures.push(outcome.message);
    }
  }

  // 顺带刷新会话的意图标签，让收件箱的分类跟当前消息保持一致。
  for (const conversation of state.conversations) {
    const listing = state.listings.find((l) => l.id === conversation.listingId);
    const last = lastBuyerMessage(conversation);
    if (last) conversation.intent = classifyIntent(last.text, listing);
  }

  state.actions = state.actions.slice(0, 200);
  state.lastTickAt = new Date(now).toISOString();
  return result;
}

export function listingFor(state: AppState, id: string): Listing | undefined {
  return state.listings.find((l) => l.id === id);
}
