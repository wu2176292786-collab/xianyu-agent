import { beforeEach, describe, expect, it } from "vitest";
import { mockReader } from "@/lib/adapters/mock-reader";
import { proposeActions } from "@/lib/agent/engine";
import { describeMerge, mergeSnapshot } from "@/lib/agent/sync";
import { createSeedState } from "@/lib/domain/seed";
import type { AppState, PlatformSnapshot } from "@/lib/domain/types";

const NOW = Date.parse("2026-01-10T12:00:00.000Z");

function snapshotOf(state: AppState, now = NOW): PlatformSnapshot {
  return {
    fetchedAt: new Date(now).toISOString(),
    listings: state.listings.map((l) => ({ ...l })),
    conversations: state.conversations.map((c) => ({ ...c, messages: [...c.messages] })),
    orders: state.orders.map((o) => ({ ...o })),
  };
}

describe("mergeSnapshot", () => {
  let state: AppState;

  beforeEach(() => {
    state = createSeedState(NOW);
  });

  it("平台说了算的字段被覆盖，本地的生意数据留着", () => {
    const snapshot = snapshotOf(state);
    const remote = snapshot.listings[0];
    remote.priceCents = 300000;
    remote.views7d = 9999;
    remote.stock = 5;
    // 平台上根本没有这些字段，快照里的值应该被忽略
    remote.floorPriceCents = 1;
    remote.costCents = 1;
    remote.floorConfirmed = false;

    const local = state.listings[0];
    const floorBefore = local.floorPriceCents;
    const costBefore = local.costCents;

    mergeSnapshot(state, snapshot, NOW);

    const merged = state.listings.find((l) => l.id === remote.id)!;
    expect(merged.priceCents).toBe(300000);
    expect(merged.views7d).toBe(9999);
    expect(merged.stock).toBe(5);
    expect(merged.floorPriceCents).toBe(floorBefore);
    expect(merged.costCents).toBe(costBefore);
    expect(merged.floorConfirmed).toBe(true);
  });

  it("新商品的底价是估出来的，必须标成未确认", () => {
    const snapshot = snapshotOf(state);
    snapshot.listings.push({
      ...snapshot.listings[0],
      id: "L-new",
      title: "同步进来的新宝贝",
      priceCents: 100000,
      floorPriceCents: 1,
      floorConfirmed: true,
      status: "on_sale",
      stock: 1,
    });

    const summary = mergeSnapshot(state, snapshot, NOW);
    const added = state.listings.find((l) => l.id === "L-new")!;

    expect(summary.newListings).toBe(1);
    expect(added.floorConfirmed).toBe(false);
    expect(added.floorPriceCents).toBe(90000); // 挂牌价的九折，只是个占位
    expect(summary.needsFloorPrice).toBe(1);
  });

  it("底价没确认的商品，自动降价绝不碰", () => {
    const snapshot = snapshotOf(state);
    // 造一件铁定命中降价规则的商品：上架很久、没什么浏览
    snapshot.listings.push({
      ...snapshot.listings[0],
      id: "L-stale",
      title: "同步进来的滞销品",
      priceCents: 100000,
      status: "on_sale",
      stock: 1,
      views7d: 3,
      createdAt: new Date(NOW - 90 * 86400_000).toISOString(),
      lastRefreshedAt: new Date(NOW - 90 * 86400_000).toISOString(),
    });
    mergeSnapshot(state, snapshot, NOW);

    const targets = () =>
      proposeActions(state, NOW)
        .filter((p) => p.payload.type === "adjust_price")
        .map((p) => (p.payload.type === "adjust_price" ? p.payload.listingId : ""));

    expect(targets()).not.toContain("L-stale");

    // 人工确认底价之后才进入候选
    const listing = state.listings.find((l) => l.id === "L-stale")!;
    listing.floorPriceCents = 60000;
    listing.floorConfirmed = true;
    expect(targets()).toContain("L-stale");
  });

  it("新消息会追加进已有会话并重新标成待回复", () => {
    const snapshot = snapshotOf(state);
    const remote = snapshot.conversations.find((c) => c.id === "C006")!;
    remote.messages.push({
      id: "C006-M3",
      author: "buyer",
      text: "那我再想想",
      createdAt: new Date(NOW).toISOString(),
    });

    const summary = mergeSnapshot(state, snapshot, NOW);
    const local = state.conversations.find((c) => c.id === "C006")!;

    expect(summary.newMessages).toBe(1);
    expect(local.messages).toHaveLength(3);
    expect(local.status).toBe("needs_reply");
  });

  it("已经有的消息不会重复追加", () => {
    const first = mergeSnapshot(state, snapshotOf(state), NOW);
    const second = mergeSnapshot(state, snapshotOf(state), NOW + 1000);
    expect(first.newMessages).toBe(0);
    expect(second.newMessages).toBe(0);
    expect(state.conversations.find((c) => c.id === "C002")!.messages).toHaveLength(3);
  });

  it("已关闭的会话不会被新消息重新叫醒", () => {
    const snapshot = snapshotOf(state);
    const closed = snapshot.conversations.find((c) => c.id === "C007")!;
    closed.messages.push({
      id: "C007-M3",
      author: "buyer",
      text: "再看看",
      createdAt: new Date(NOW).toISOString(),
    });

    mergeSnapshot(state, snapshot, NOW);
    expect(state.conversations.find((c) => c.id === "C007")!.status).toBe("closed");
  });

  it("订单按 id 更新，新订单直接加进来", () => {
    const snapshot = snapshotOf(state);
    snapshot.orders[0].status = "shipped";
    snapshot.orders.push({
      ...snapshot.orders[0],
      id: "O-new",
      status: "pending_shipment",
    });

    const summary = mergeSnapshot(state, snapshot, NOW);
    expect(summary.updatedOrders).toBe(1);
    expect(summary.newOrders).toBe(1);
    expect(state.orders.find((o) => o.id === "O-new")).toBeDefined();
  });

  it("平台没返回的商品保留在本地，一次抓取失败不会丢数据", () => {
    const snapshot = snapshotOf(state);
    snapshot.listings = snapshot.listings.slice(0, 2);

    mergeSnapshot(state, snapshot, NOW);
    expect(state.listings).toHaveLength(11);
  });

  it("同步不会动审批队列和活动记录", () => {
    state.actions = [
      {
        id: "keep-me",
        ruleId: "R-refresh",
        ruleKind: "refresh_listing",
        title: "别把我弄没了",
        reason: "",
        risk: "low",
        status: "pending",
        createdAt: new Date(NOW).toISOString(),
        payload: { type: "refresh_listing", listingId: "L001" },
      },
    ];
    const activityBefore = state.activity.length;

    mergeSnapshot(state, snapshotOf(state), NOW);

    expect(state.actions.map((a) => a.id)).toEqual(["keep-me"]);
    expect(state.activity).toHaveLength(activityBefore);
    expect(state.lastSyncAt).toBe(new Date(NOW).toISOString());
  });

  it("没有变化时如实说没有变化", () => {
    expect(describeMerge(mergeSnapshot(state, snapshotOf(state), NOW))).toBe("没有变化");
  });
});

describe("MockXianyuReader", () => {
  it("拉回来的快照带着平台侧本来就会有的变化", async () => {
    const state = createSeedState(NOW);
    const snapshot = await mockReader.fetchSnapshot(state, NOW);

    expect(snapshot.listings).toHaveLength(state.listings.length);
    const grew = snapshot.listings.some((remote) => {
      const local = state.listings.find((l) => l.id === remote.id)!;
      return remote.views7d > local.views7d;
    });
    expect(grew).toBe(true);
  });

  it("同一个时间点拉两次结果一样，同步是幂等的", async () => {
    const state = createSeedState(NOW);
    const a = await mockReader.fetchSnapshot(state, NOW);
    const b = await mockReader.fetchSnapshot(state, NOW);
    expect(b).toEqual(a);
  });
});
