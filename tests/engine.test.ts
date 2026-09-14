import { beforeEach, describe, expect, it } from "vitest";
import { mockAdapter } from "@/lib/adapters/mock";
import {
  actionKey,
  applyActionWithEdits,
  proposeActions,
  runTick,
  toAction,
} from "@/lib/agent/engine";
import { createSeedState } from "@/lib/domain/seed";
import type { AgentAction, AppState, RuleKind } from "@/lib/domain/types";

const NOW = Date.parse("2026-01-10T12:00:00.000Z");

function kinds(state: AppState, now = NOW): RuleKind[] {
  return proposeActions(state, now).map((p) => p.ruleKind);
}

/** 从商品类动作里取出商品 id。 */
function listingIdOf({ payload }: AgentAction): string {
  switch (payload.type) {
    case "adjust_price":
    case "refresh_listing":
    case "delist_listing":
      return payload.listingId;
    default:
      return "";
  }
}

describe("proposeActions", () => {
  let state: AppState;

  beforeEach(() => {
    state = createSeedState(NOW);
  });

  it("在示例数据上给出全部五类建议", () => {
    expect(new Set(kinds(state))).toEqual(
      new Set([
        "auto_reply",
        "shipment_reminder",
        "price_drop",
        "refresh_listing",
        "sold_out_delist",
      ]),
    );
  });

  it("只擦亮超过间隔的在售商品，并遵守每轮上限", () => {
    const rule = state.rules.find((r) => r.kind === "refresh_listing")!;
    const proposals = proposeActions(state, NOW).filter(
      (p) => p.ruleKind === "refresh_listing",
    );
    expect(proposals.length).toBeLessThanOrEqual(rule.params.maxPerRun);

    for (const { payload } of proposals) {
      if (payload.type !== "refresh_listing") throw new Error("payload 类型不对");
      const listing = state.listings.find((l) => l.id === payload.listingId)!;
      expect(listing.status).toBe("on_sale");
      expect(listing.stock).toBeGreaterThan(0);
      const hours = (NOW - Date.parse(listing.lastRefreshedAt)) / 3_600_000;
      expect(hours).toBeGreaterThanOrEqual(rule.params.minHoursSinceRefresh);
    }
  });

  it("关掉规则后就不再产生对应建议", () => {
    state.rules.find((r) => r.kind === "refresh_listing")!.enabled = false;
    expect(kinds(state)).not.toContain("refresh_listing");
  });

  it("降价建议永远不低于商品底价", () => {
    const priceRule = state.rules.find((r) => r.kind === "price_drop")!;
    priceRule.params.stepPercent = 90;

    const proposals = proposeActions(state, NOW).filter((p) => p.ruleKind === "price_drop");
    expect(proposals.length).toBeGreaterThan(0);

    for (const { payload } of proposals) {
      if (payload.type !== "adjust_price") continue;
      const listing = state.listings.find((l) => l.id === payload.listingId)!;
      expect(payload.toCents).toBeGreaterThanOrEqual(listing.floorPriceCents);
      expect(payload.toCents).toBeLessThan(payload.fromCents);
    }
  });

  it("已在队列里的动作不会重复提案", () => {
    const first = proposeActions(state, NOW);
    state.actions = first.map((p) => toAction(p, NOW));
    expect(proposeActions(state, NOW)).toHaveLength(0);
  });

  it("超时未发货的订单才会被备单", () => {
    const proposals = proposeActions(state, NOW).filter(
      (p) => p.ruleKind === "shipment_reminder",
    );
    const orderIds = proposals.map((p) =>
      p.payload.type === "ship_order" ? p.payload.orderId : "",
    );
    // O20240001 付款 30 小时，超过 24 小时阈值；O20240002 只过了 8 小时。
    expect(orderIds).toEqual(["O20240001"]);
  });

  it("建议文案是给人看的，不会漏出英文枚举名", () => {
    const blob = proposeActions(state, NOW)
      .map((p) => `${p.title} ${p.reason}`)
      .join(" ");
    for (const enumName of [
      "bargain",
      "spec_question",
      "shipping_chase",
      "availability",
      "after_sale",
    ]) {
      expect(blob).not.toContain(enumName);
    }
  });

  it("零库存但仍在售的商品会被建议下架", () => {
    const proposals = proposeActions(state, NOW).filter(
      (p) => p.ruleKind === "sold_out_delist",
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0].payload).toMatchObject({
      type: "delist_listing",
      listingId: "L008",
    });
  });
});

describe("runTick", () => {
  let state: AppState;

  beforeEach(() => {
    state = createSeedState(NOW);
  });

  it("自动执行免审批规则，其余进审批队列", () => {
    const result = runTick(state, mockAdapter, NOW);

    // 擦亮和零库存下架是免审批的
    expect(result.applied.map((a) => a.ruleKind).sort()).toEqual(
      expect.arrayContaining(["refresh_listing", "sold_out_delist"]),
    );
    expect(result.applied.every((a) => a.decidedBy === "agent")).toBe(true);

    // 涉及钱和承诺的动作必须人工确认
    const queuedKinds = new Set(result.queued.map((a) => a.ruleKind));
    expect(queuedKinds).toContain("auto_reply");
    expect(queuedKinds).toContain("price_drop");
    expect(queuedKinds).toContain("shipment_reminder");
    expect(result.failures).toEqual([]);
  });

  it("自动执行真的改变了状态", () => {
    runTick(state, mockAdapter, NOW);
    expect(state.listings.find((l) => l.id === "L008")!.status).toBe("delisted");
    expect(state.lastTickAt).toBe(new Date(NOW).toISOString());
  });

  it("连续巡检不会对同一个对象重复动作", () => {
    const first = runTick(state, mockAdapter, NOW);
    const second = runTick(state, mockAdapter, NOW + 60_000);

    expect(first.queued.length).toBeGreaterThan(0);
    // 待审批的建议还堵在队列里，不会被再提一次
    expect(second.queued).toHaveLength(0);

    const firstKeys = new Set(first.applied.map((a) => actionKey(a.payload)));
    for (const action of second.applied) {
      expect(firstKeys.has(actionKey(action.payload))).toBe(false);
    }
  });

  it("擦亮的每轮上限会把剩下的留到下一轮", () => {
    const rule = state.rules.find((r) => r.kind === "refresh_listing")!;
    rule.params.maxPerRun = 1;

    const first = runTick(state, mockAdapter, NOW);
    expect(first.applied.filter((a) => a.ruleKind === "refresh_listing")).toHaveLength(1);

    const second = runTick(state, mockAdapter, NOW + 60_000);
    expect(second.applied.filter((a) => a.ruleKind === "refresh_listing")).toHaveLength(1);
  });

  it("低置信度的回复草稿即使规则免审批也会进队列", () => {
    const replyRule = state.rules.find((r) => r.kind === "auto_reply")!;
    replyRule.requiresApproval = false;

    const result = runTick(state, mockAdapter, NOW);
    const queuedReplies = result.queued.filter((a) => a.ruleKind === "auto_reply");
    const appliedReplies = result.applied.filter((a) => a.ruleKind === "auto_reply");

    // C002（问港版/漂移）和 C004（问库存）分别是需要人工确认和高置信度的例子
    expect(queuedReplies.length).toBeGreaterThan(0);
    expect(appliedReplies.length).toBeGreaterThan(0);
  });
});

describe("applyActionWithEdits", () => {
  let state: AppState;

  beforeEach(() => {
    state = createSeedState(NOW);
    runTick(state, mockAdapter, NOW);
  });

  it("人工改价后执行，payload 会被更新", () => {
    const action = state.actions.find(
      (a) => a.status === "pending" && a.payload.type === "adjust_price",
    )!;
    const listing = state.listings.find(
      (l) => listingIdOf(action) === l.id,
    )!;

    const outcome = applyActionWithEdits(
      state,
      action,
      { priceInput: String(listing.floorPriceCents / 100) },
      mockAdapter,
      NOW,
    );

    expect(outcome.ok).toBe(true);
    expect(action.payload).toMatchObject({ toCents: listing.floorPriceCents });
    expect(listing.priceCents).toBe(listing.floorPriceCents);
  });

  it("被拒绝的编辑不会改坏队列里的建议", () => {
    const action = state.actions.find(
      (a) => a.status === "pending" && a.payload.type === "adjust_price",
    )!;
    const before = structuredClone(action.payload);
    const listing = state.listings.find((l) => listingIdOf(action) === l.id)!;
    const priceBefore = listing.priceCents;

    const rejected = applyActionWithEdits(
      state,
      action,
      { priceInput: "1" },
      mockAdapter,
      NOW,
    );
    expect(rejected.ok).toBe(false);
    expect(action.payload).toEqual(before);
    expect(listing.priceCents).toBe(priceBefore);

    // 改坏之后原样通过，仍然应该成功
    const retried = applyActionWithEdits(state, action, {}, mockAdapter, NOW);
    expect(retried.ok).toBe(true);
  });

  it("空回复会被拒绝", () => {
    const action = state.actions.find(
      (a) => a.status === "pending" && a.payload.type === "send_reply",
    )!;
    const outcome = applyActionWithEdits(
      state,
      action,
      { text: "   " },
      mockAdapter,
      NOW,
    );
    expect(outcome.ok).toBe(false);
  });

  it("发货单缺运单号会被拒绝", () => {
    const action = state.actions.find(
      (a) => a.status === "pending" && a.payload.type === "ship_order",
    )!;
    const outcome = applyActionWithEdits(
      state,
      action,
      { trackingNo: "" },
      mockAdapter,
      NOW,
    );
    expect(outcome.ok).toBe(false);
    expect(state.orders.find((o) => o.id === "O20240001")!.status).toBe("pending_shipment");
  });
});

describe("MockXianyuAdapter", () => {
  let state: AppState;

  beforeEach(() => {
    state = createSeedState(NOW);
  });

  it("拒绝把价格改到底价以下", () => {
    const listing = state.listings[0];
    const result = mockAdapter.updatePrice(
      state,
      listing.id,
      listing.floorPriceCents - 100,
      NOW,
    );
    expect(result.ok).toBe(false);
    expect(state.listings[0].priceCents).toBe(listing.priceCents);
  });

  it("发货会扣库存并在库存归零时标记售罄", () => {
    const order = state.orders.find((o) => o.id === "O20240001")!;
    const before = state.listings.find((l) => l.id === order.listingId)!.stock;

    const result = mockAdapter.shipOrder(state, order.id, "顺丰速运", "SF123", NOW);
    expect(result.ok).toBe(true);
    expect(state.orders.find((o) => o.id === order.id)!.status).toBe("shipped");

    const after = state.listings.find((l) => l.id === order.listingId)!;
    expect(after.stock).toBe(before - 1);
    if (after.stock === 0) expect(after.status).toBe("sold_out");
  });

  it("重复发货会被拒绝", () => {
    mockAdapter.shipOrder(state, "O20240001", "顺丰速运", "SF123", NOW);
    const second = mockAdapter.shipOrder(state, "O20240001", "顺丰速运", "SF124", NOW);
    expect(second.ok).toBe(false);
  });

  it("回复后会话状态变为等待买家", () => {
    const result = mockAdapter.sendMessage(state, "C001", "可以的", NOW);
    expect(result.ok).toBe(true);
    const conversation = state.conversations.find((c) => c.id === "C001")!;
    expect(conversation.status).toBe("awaiting_buyer");
    expect(conversation.messages.at(-1)).toMatchObject({
      author: "seller",
      viaAgent: true,
    });
  });
});
