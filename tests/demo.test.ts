import { beforeEach, describe, expect, it } from "vitest";
import { clearDemoData, describeClearDemo } from "@/lib/domain/demo";
import { DEMO_SHOP_NAME, createSeedState } from "@/lib/domain/seed";
import type { AppState, Listing } from "@/lib/domain/types";

const NOW = Date.parse("2026-01-10T12:00:00.000Z");

/** 一件同步进来的真实商品：itemId 是平台的 13 位数字。 */
function realListing(id: string): Listing {
  return {
    id,
    title: "真实商品",
    category: "",
    emoji: "📦",
    priceCents: 12800,
    floorPriceCents: 11500,
    floorConfirmed: false,
    costCents: 0,
    stock: 1,
    status: "on_sale",
    createdAt: new Date(NOW).toISOString(),
    lastRefreshedAt: new Date(NOW).toISOString(),
    views7d: 0,
    wants: 0,
    inquiries7d: 0,
    tags: [],
    metricsUnknown: true,
  };
}

describe("清除示例数据", () => {
  let state: AppState;

  beforeEach(() => {
    state = createSeedState(NOW);
    // 混进真实数据，就是同步之后的样子
    state.listings.push(realListing("1008994613456"), realListing("1041833271251"));
    state.conversations.push({
      id: "8001",
      buyerName: "真实买家",
      buyerEmoji: "🐟",
      listingId: "1008994613456",
      status: "needs_reply",
      intent: "other",
      messages: [
        {
          id: "8001-last",
          author: "buyer",
          text: "还在吗",
          createdAt: new Date(NOW).toISOString(),
        },
      ],
    });
  });

  it("示例数据清掉，真实数据留着", () => {
    const summary = clearDemoData(state);

    expect(state.listings.map((l) => l.id)).toEqual(["1008994613456", "1041833271251"]);
    expect(state.conversations.map((c) => c.id)).toEqual(["8001"]);
    expect(state.orders).toHaveLength(0);
    expect(summary.listings).toBe(11);
    expect(summary.conversations).toBe(7);
  });

  /**
   * 判断靠的是种子里写死的 id，不是「长得像不像」。
   * 真实 itemId 永远不会撞上 `L001`。
   */
  it("认的是种子里的 id，不是 id 的长相", () => {
    state.listings.push(realListing("L999"));
    clearDemoData(state);
    expect(state.listings.map((l) => l.id)).toContain("L999");
  });

  it("流量趋势整个清掉 —— 平台不给这类数据，留着的都是假的", () => {
    expect(state.metrics.length).toBeGreaterThan(0);
    clearDemoData(state);
    expect(state.metrics).toEqual([]);
  });

  it("指向示例商品的建议一起清掉，指向真实商品的留着", () => {
    state.actions.push(
      {
        id: "A-demo",
        ruleId: "R1",
        ruleKind: "refresh_listing",
        title: "擦亮示例商品",
        reason: "",
        risk: "low",
        status: "pending",
        createdAt: new Date(NOW).toISOString(),
        payload: { type: "refresh_listing", listingId: "L001" },
      },
      {
        id: "A-real",
        ruleId: "R1",
        ruleKind: "refresh_listing",
        title: "擦亮真实商品",
        reason: "",
        risk: "low",
        status: "pending",
        createdAt: new Date(NOW).toISOString(),
        payload: { type: "refresh_listing", listingId: "1008994613456" },
      },
    );

    clearDemoData(state);
    expect(state.actions.map((a) => a.id)).toEqual(["A-real"]);
  });

  it("示例研究任务连同它下面的同行商品一起清掉，不留孤儿", () => {
    expect(state.research.tasks.length).toBeGreaterThan(0);
    expect(state.research.rivals.length).toBeGreaterThan(0);

    clearDemoData(state);
    expect(state.research.tasks).toEqual([]);
    expect(state.research.rivals).toEqual([]);
  });

  it("自己新建的研究任务不受影响", () => {
    state.research.tasks.push({
      id: "RT-mine",
      name: "我自己的研究",
      keyword: "",
      mustInclude: [],
      mustExclude: [],
      revisitHours: 48,
      status: "active",
      createdAt: new Date(NOW).toISOString(),
    });
    state.research.rivals.push({
      id: "RV-mine",
      taskId: "RT-mine",
      itemId: "900001",
      title: "同行",
      url: "https://www.goofish.com/item?id=900001",
      addedAt: new Date(NOW).toISOString(),
      alignment: "uncertain",
      alignmentBy: "auto",
      observations: [],
    });

    clearDemoData(state);
    expect(state.research.tasks.map((t) => t.id)).toEqual(["RT-mine"]);
    expect(state.research.rivals.map((r) => r.id)).toEqual(["RV-mine"]);
  });

  it("给了平台真名就换掉示例店铺名", () => {
    expect(state.settings.shopName).toBe(DEMO_SHOP_NAME);
    clearDemoData(state, "tb578526545");
    expect(state.settings.shopName).toBe("tb578526545");
  });

  it("没拿到平台真名就不动店铺名", () => {
    clearDemoData(state, "   ");
    expect(state.settings.shopName).toBe(DEMO_SHOP_NAME);
  });

  it("规则和通道设置不受影响 —— 那是配置，不是示例数据", () => {
    const rules = state.rules.length;
    clearDemoData(state);
    expect(state.rules).toHaveLength(rules);
    expect(state.channel).toBeDefined();
    expect(state.settings.shipWithinHours).toBe(24);
  });

  it("清过一次之后再清，如实说没有可清的", () => {
    clearDemoData(state);
    expect(describeClearDemo(clearDemoData(state))).toBe("没有示例数据需要清除");
  });
});