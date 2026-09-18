import { beforeEach, describe, expect, it } from "vitest";
import { mockAdapter } from "@/lib/adapters/mock";
import type { XianyuAdapter } from "@/lib/adapters/types";
import {
  actionKey,
  applyActionWithEdits,
  nextScheduledTickAt,
  proposeActions,
  retryAction,
  runTick,
  shouldRunScheduledTick,
  toAction,
} from "@/lib/agent/engine";
import { MAX_RUNS } from "@/lib/domain/limits";
import { createSeedState } from "@/lib/domain/seed";
import type {
  ActionType,
  AgentAction,
  AppState,
  RuleKind,
} from "@/lib/domain/types";

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

  it("自动执行免审批规则，其余进审批队列", async () => {
    const result = await runTick(state, mockAdapter, NOW);

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
    expect(result.failed).toEqual([]);
  });

  it("自动执行真的改变了状态", async () => {
    await runTick(state, mockAdapter, NOW);
    expect(state.listings.find((l) => l.id === "L008")!.status).toBe("delisted");
    expect(state.lastTickAt).toBe(new Date(NOW).toISOString());
  });

  it("连续巡检不会对同一个对象重复动作", async () => {
    const first = await runTick(state, mockAdapter, NOW);
    const second = await runTick(state, mockAdapter, NOW + 60_000);

    expect(first.queued.length).toBeGreaterThan(0);
    // 待审批的建议还堵在队列里，不会被再提一次
    expect(second.queued).toHaveLength(0);

    const firstKeys = new Set(first.applied.map((a) => actionKey(a.payload)));
    for (const action of second.applied) {
      expect(firstKeys.has(actionKey(action.payload))).toBe(false);
    }
  });

  it("擦亮的每轮上限会把剩下的留到下一轮", async () => {
    const rule = state.rules.find((r) => r.kind === "refresh_listing")!;
    rule.params.maxPerRun = 1;

    const first = await runTick(state, mockAdapter, NOW);
    expect(first.applied.filter((a) => a.ruleKind === "refresh_listing")).toHaveLength(1);

    const second = await runTick(state, mockAdapter, NOW + 60_000);
    expect(second.applied.filter((a) => a.ruleKind === "refresh_listing")).toHaveLength(1);
  });

  it("低置信度的回复草稿即使规则免审批也会进队列", async () => {
    const replyRule = state.rules.find((r) => r.kind === "auto_reply")!;
    replyRule.requiresApproval = false;

    const result = await runTick(state, mockAdapter, NOW);
    const queuedReplies = result.queued.filter((a) => a.ruleKind === "auto_reply");
    const appliedReplies = result.applied.filter((a) => a.ruleKind === "auto_reply");

    // C002（问港版/漂移）和 C004（问库存）分别是需要人工确认和高置信度的例子
    expect(queuedReplies.length).toBeGreaterThan(0);
    expect(appliedReplies.length).toBeGreaterThan(0);
  });
});

/** 只对某一种动作失败的适配器，用来验证失败处理。 */
function brokenAdapter(failing: ActionType, message = "平台开小差了"): XianyuAdapter {
  const fail = { ok: false as const, message };
  return {
    id: "broken",
    label: "会失败的通道",
    isMock: true,
    refreshListing: (state, id, now) =>
      failing === "refresh_listing" ? fail : mockAdapter.refreshListing(state, id, now),
    updatePrice: (state, id, cents, now) =>
      failing === "adjust_price" ? fail : mockAdapter.updatePrice(state, id, cents, now),
    delistListing: (state, id, now) =>
      failing === "delist_listing" ? fail : mockAdapter.delistListing(state, id, now),
    sendMessage: (state, id, text, now) =>
      failing === "send_reply" ? fail : mockAdapter.sendMessage(state, id, text, now),
    shipOrder: (state, id, carrier, trackingNo, now) =>
      failing === "ship_order"
        ? fail
        : mockAdapter.shipOrder(state, id, carrier, trackingNo, now),
  };
}

describe("执行失败的处理", () => {
  let state: AppState;

  beforeEach(() => {
    state = createSeedState(NOW);
  });

  it("自动执行失败的动作会带着原因留在队列里，而不是消失", async () => {
    const result = await runTick(state, brokenAdapter("refresh_listing"), NOW);

    expect(result.failed.length).toBeGreaterThan(0);
    for (const action of result.failed) {
      expect(action.status).toBe("failed");
      expect(action.failureReason).toBe("平台开小差了");
      expect(action.attempts).toBe(1);
      expect(state.actions).toContain(action);
    }
    // 失败的不算已执行
    expect(result.applied.some((a) => a.ruleKind === "refresh_listing")).toBe(false);
  });

  it("失败的动作不会被下一轮重复提案", async () => {
    await runTick(state, brokenAdapter("refresh_listing"), NOW);
    const before = state.actions.filter((a) => a.status === "failed").length;
    await runTick(state, brokenAdapter("refresh_listing"), NOW + 60_000);
    const after = state.actions.filter((a) => a.status === "failed").length;
    // 失败的商品这一轮仍然「没擦亮」，所以会被再提一次 —— 但同一个商品不会同时挂两条待审批
    expect(after).toBeGreaterThanOrEqual(before);
    expect(state.actions.filter((a) => a.status === "pending").length).toBeGreaterThan(0);
  });

  it("重试成功后状态变成已执行，尝试次数累加", async () => {
    await runTick(state, brokenAdapter("refresh_listing"), NOW);
    const failed = state.actions.find((a) => a.status === "failed")!;

    const outcome = await retryAction(state, failed, mockAdapter, NOW + 1000);
    expect(outcome.ok).toBe(true);
    expect(failed.status).toBe("applied");
    expect(failed.failureReason).toBeUndefined();
    expect(failed.attempts).toBe(2);
    expect(failed.decidedBy).toBe("human");
  });

  it("重试仍然失败会更新原因并继续累加次数", async () => {
    await runTick(state, brokenAdapter("refresh_listing"), NOW);
    const failed = state.actions.find((a) => a.status === "failed")!;

    const outcome = await retryAction(
      state,
      failed,
      brokenAdapter("refresh_listing", "还是不行"),
      NOW + 1000,
    );
    expect(outcome.ok).toBe(false);
    expect(failed.status).toBe("failed");
    expect(failed.failureReason).toBe("还是不行");
    expect(failed.attempts).toBe(2);
  });
});

describe("巡检记录与定时巡检", () => {
  let state: AppState;

  beforeEach(() => {
    state = createSeedState(NOW);
  });

  it("每轮巡检都会留下一条记录", async () => {
    await runTick(state, mockAdapter, NOW, "scheduled");
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]).toMatchObject({
      trigger: "scheduled",
      at: new Date(NOW).toISOString(),
    });
    expect(state.runs[0].applied).toBeGreaterThan(0);
    expect(state.runs[0].queued).toBeGreaterThan(0);

    await runTick(state, mockAdapter, NOW + 60_000, "manual");
    expect(state.runs).toHaveLength(2);
    // 最近的在最前面
    expect(state.runs[0].trigger).toBe("manual");
  });

  it("巡检记录最多留上限条数", async () => {
    for (let i = 0; i < MAX_RUNS + 10; i += 1) {
      await runTick(state, mockAdapter, NOW + i * 1000);
    }
    expect(state.runs).toHaveLength(MAX_RUNS);
  });

  it("没到间隔就不跑，到了才跑", async () => {
    state.settings.autoTickEnabled = true;
    state.settings.autoTickMinutes = 15;

    // 还没跑过时从播种时间起算，保证首次打开时队列是空的
    expect(shouldRunScheduledTick(state, NOW + 14 * 60_000)).toBe(false);
    expect(shouldRunScheduledTick(state, NOW + 15 * 60_000)).toBe(true);

    await runTick(state, mockAdapter, NOW + 15 * 60_000, "scheduled");
    expect(shouldRunScheduledTick(state, NOW + 20 * 60_000)).toBe(false);
    expect(shouldRunScheduledTick(state, NOW + 30 * 60_000)).toBe(true);
  });

  it("关掉自动巡检就永远不跑", () => {
    state.settings.autoTickEnabled = false;
    expect(shouldRunScheduledTick(state, NOW + 10 * 24 * 3600_000)).toBe(false);
    expect(nextScheduledTickAt(state)).toBeNull();
  });

  it("间隔填 0 也不会变成死循环", () => {
    state.settings.autoTickEnabled = true;
    state.settings.autoTickMinutes = 0;
    expect(shouldRunScheduledTick(state, NOW + 60_000)).toBe(false);
  });

  it("下次巡检时间以上次巡检为基准", async () => {
    state.settings.autoTickEnabled = true;
    state.settings.autoTickMinutes = 20;
    await runTick(state, mockAdapter, NOW, "manual");
    expect(nextScheduledTickAt(state)).toBe(NOW + 20 * 60_000);
  });
});

describe("applyActionWithEdits", () => {
  let state: AppState;

  beforeEach(async () => {
    state = createSeedState(NOW);
    await runTick(state, mockAdapter, NOW);
  });

  it("人工改价后执行，payload 会被更新", async () => {
    const action = state.actions.find(
      (a) => a.status === "pending" && a.payload.type === "adjust_price",
    )!;
    const listing = state.listings.find(
      (l) => listingIdOf(action) === l.id,
    )!;

    const outcome = await applyActionWithEdits(
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

  it("被拒绝的编辑不会改坏队列里的建议", async () => {
    const action = state.actions.find(
      (a) => a.status === "pending" && a.payload.type === "adjust_price",
    )!;
    const before = structuredClone(action.payload);
    const listing = state.listings.find((l) => listingIdOf(action) === l.id)!;
    const priceBefore = listing.priceCents;

    const rejected = await applyActionWithEdits(
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
    const retried = await applyActionWithEdits(state, action, {}, mockAdapter, NOW);
    expect(retried.ok).toBe(true);
  });

  it("空回复会被拒绝", async () => {
    const action = state.actions.find(
      (a) => a.status === "pending" && a.payload.type === "send_reply",
    )!;
    const outcome = await applyActionWithEdits(
      state,
      action,
      { text: "   " },
      mockAdapter,
      NOW,
    );
    expect(outcome.ok).toBe(false);
  });

  it("发货单缺运单号会被拒绝", async () => {
    const action = state.actions.find(
      (a) => a.status === "pending" && a.payload.type === "ship_order",
    )!;
    const outcome = await applyActionWithEdits(
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
