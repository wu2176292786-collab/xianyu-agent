import { beforeEach, describe, expect, it } from "vitest";
import { mockReader } from "@/lib/adapters/mock-reader";
import { proposeActions } from "@/lib/agent/engine";
import {
  adoptAccount,
  describeMerge,
  mergeSnapshot,
  recordShopHeat,
  shopHeatFromListings,
} from "@/lib/agent/sync";
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

  it("历史消息进来时丢掉会话列表那条摘要，并补上商品标题", () => {
    const snapshot = snapshotOf(state);
    const remote = snapshot.conversations.find((c) => c.id === "C002")!;
    remote.listingTitle = "追觅S7剃须刀";
    remote.listingPriceCents = 26800;
    remote.messages = [
      {
        id: "real-1",
        author: "buyer",
        text: "还在吗",
        createdAt: new Date(NOW - 60_000).toISOString(),
      },
      {
        id: "real-2",
        author: "seller",
        text: "在的",
        createdAt: new Date(NOW).toISOString(),
      },
    ];

    const before = state.conversations.find((c) => c.id === "C002")!.messages.length;
    const summary = mergeSnapshot(state, snapshot, NOW);
    const local = state.conversations.find((c) => c.id === "C002")!;

    expect(local.listingTitle).toBe("追觅S7剃须刀");
    expect(local.listingPriceCents).toBe(26800);
    expect(local.messages.every((m) => !m.id.endsWith("-last"))).toBe(true);
    expect(local.messages.map((m) => m.id)).toEqual(
      expect.arrayContaining(["real-1", "real-2"]),
    );
    expect(local.messages.length).toBeGreaterThanOrEqual(before);
    expect(summary.newMessages).toBeGreaterThan(0);
    expect(local.status).toBe("awaiting_buyer");
  });

  it("会话列表更新的最后一条会覆盖同 id 的摘要", () => {
    const conversation = state.conversations.find((c) => c.id === "C006")!;
    conversation.messages = [
      {
        id: "C006-last",
        author: "seller",
        text: "好的",
        createdAt: new Date(NOW - 3_600_000).toISOString(),
      },
    ];
    conversation.status = "awaiting_buyer";

    const snapshot = snapshotOf(state);
    const remote = snapshot.conversations.find((c) => c.id === "C006")!;
    remote.messages = [
      {
        id: "C006-last",
        author: "buyer",
        text: "248 可出嘛",
        createdAt: new Date(NOW).toISOString(),
      },
    ];
    remote.status = "needs_reply";

    const summary = mergeSnapshot(state, snapshot, NOW);
    const local = state.conversations.find((c) => c.id === "C006")!;

    expect(summary.newMessages).toBe(1);
    expect(local.messages).toHaveLength(1);
    expect(local.messages[0]).toMatchObject({
      id: "C006-last",
      author: "buyer",
      text: "248 可出嘛",
    });
    expect(local.status).toBe("needs_reply");
  });

  it("历史页没覆盖到时，也会把更新的最后一条摘要合进来", () => {
    const conversation = state.conversations.find((c) => c.id === "C002")!;
    conversation.messages = [
      {
        id: "real-1",
        author: "buyer",
        text: "还在吗",
        createdAt: new Date(NOW - 3_600_000).toISOString(),
      },
      {
        id: "real-2",
        author: "seller",
        text: "在的",
        createdAt: new Date(NOW - 3_000_000).toISOString(),
      },
    ];
    conversation.status = "awaiting_buyer";

    const snapshot = snapshotOf(state);
    const remote = snapshot.conversations.find((c) => c.id === "C002")!;
    remote.messages = [
      {
        id: "C002-last",
        author: "buyer",
        text: "248 可出嘛",
        createdAt: new Date(NOW).toISOString(),
      },
    ];

    const summary = mergeSnapshot(state, snapshot, NOW);
    const local = state.conversations.find((c) => c.id === "C002")!;

    expect(summary.newMessages).toBe(1);
    expect(local.messages.at(-1)).toMatchObject({
      author: "buyer",
      text: "248 可出嘛",
    });
    expect(local.status).toBe("needs_reply");
  });

  it("已经有的消息不会重复追加", () => {
    const first = mergeSnapshot(state, snapshotOf(state), NOW);
    const second = mergeSnapshot(state, snapshotOf(state), NOW + 1000);
    expect(first.newMessages).toBe(0);
    expect(second.newMessages).toBe(0);
    expect(state.conversations.find((c) => c.id === "C002")!.messages).toHaveLength(3);
  });

  it("拉到真实历史后，丢掉只剩摘要的旧会话", () => {
    const snapshot = snapshotOf(state);
    state.conversations.push({
      id: "stale-summary",
      buyerName: "旧买家",
      buyerEmoji: "🐟",
      listingId: "",
      status: "awaiting_buyer",
      intent: "other",
      messages: [
        {
          id: "stale-summary-last",
          author: "seller",
          text: "在的",
          createdAt: new Date(NOW).toISOString(),
        },
      ],
    });
    mergeSnapshot(state, snapshot, NOW);
    expect(state.conversations.find((conversation) => conversation.id === "stale-summary")).toBeUndefined();
    expect(state.conversations.find((conversation) => conversation.id === "C002")).toBeDefined();
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

  it("换了闲鱼账号就丢掉上一号的商品、会话和订单", () => {
    state.settings.accountUserId = "1111";
    const snapshot = snapshotOf(state);
    snapshot.accountUserId = "2222";
    snapshot.shopName = "新号店铺";
    snapshot.listings = [
      {
        ...state.listings[0]!,
        id: "new-item",
        title: "新账号的商品",
      },
    ];
    snapshot.conversations = [];
    snapshot.orders = [];

    mergeSnapshot(state, snapshot, NOW);

    expect(state.settings.accountUserId).toBe("2222");
    expect(state.settings.shopName).toBe("新号店铺");
    expect(state.listings.map((listing) => listing.id)).toEqual(["new-item"]);
    expect(state.conversations).toEqual([]);
    expect(state.orders).toEqual([]);
  });

  it("同一账号重新导入登录态不会清空店铺", () => {
    state.settings.accountUserId = "1111";
    const before = state.listings.length;
    expect(adoptAccount(state, "1111")).toBe(false);
    expect(state.listings).toHaveLength(before);
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

  it("总览曝光只加已经同步到浏览的在售商品", () => {
    expect(
      shopHeatFromListings([
        { ...state.listings[0]!, status: "on_sale", views7d: 16, metricsUnknown: false },
        { ...state.listings[1]!, status: "on_sale", views7d: 6, metricsUnknown: false },
        { ...state.listings[2]!, status: "on_sale", views7d: 99, metricsUnknown: true },
        { ...state.listings[3]!, status: "sold_out", views7d: 80, metricsUnknown: false },
      ]),
    ).toEqual({ known: 2, views: 22, wants: state.listings[0]!.wants + state.listings[1]!.wants, inquiries: state.listings[0]!.inquiries7d + state.listings[1]!.inquiries7d });
  });

  it("真实通道同步后会记下今天的店铺曝光", () => {
    state.channel.read = "live";
    state.metrics = [];
    state.listings = state.listings.slice(0, 2).map((listing) => ({
      ...listing,
      status: "on_sale" as const,
      views7d: listing.id === state.listings[0]!.id ? 16 : 6,
      metricsUnknown: false,
    }));

    mergeSnapshot(state, snapshotOf(state), NOW);

    expect(state.metrics).toHaveLength(1);
    expect(state.metrics[0]).toMatchObject({ views: 22 });
    expect(recordShopHeat(state, NOW)?.views).toBe(22);
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
