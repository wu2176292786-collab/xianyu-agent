import { describe, expect, it } from "vitest";
import type { AppState, RivalListing } from "@/lib/domain/types";
import { isListSource } from "@/lib/domain/types";
import { MAX_RIVALS_PER_SHOP_TASK, rivalCapFor } from "@/lib/domain/limits";
import { detailBudgetLeft } from "@/lib/research/heat";
import { detailSnapshotFromHeat } from "@/lib/research/pull";
import { pruneRivalsForTask } from "@/lib/research/record";
import {
  ensureShopTask,
  findShopTask,
  shopEntryUrl,
  shopTaskName,
} from "@/lib/research/shop";
import {
  displayImageUrls,
  extractSellerId,
  isSentinelYuan,
  isShopPageUrl,
  isTinyImage,
  parsePageSnapshot,
  sellerFromRecord,
  shopUrlFor,
} from "@/lib/research/snapshot";

const NOW = Date.parse("2026-01-10T12:00:00.000Z");

describe("店铺身份", () => {
  it("从店铺页地址里抠 sellerId", () => {
    expect(extractSellerId("https://www.goofish.com/personal?userId=1234")).toBe("1234");
    expect(extractSellerId("https://www.goofish.com/personal?spm=a21&userId=99")).toBe("99");
    expect(extractSellerId("https://www.goofish.com/item?id=555")).toBeUndefined();
    expect(extractSellerId(undefined)).toBeUndefined();
  });

  it("抽不到就返回空，绝不拿昵称顶替", () => {
    expect(shopUrlFor(undefined)).toBeUndefined();
    expect(shopUrlFor("1234")).toBe("https://www.goofish.com/personal?userId=1234");
  });

  it("认得出哪些地址是店铺页", () => {
    expect(isShopPageUrl("https://www.goofish.com/personal?userId=1")).toBe(true);
    expect(isShopPageUrl("https://www.goofish.com/search?q=x")).toBe(false);
  });

  it("界面上的「进店铺」是普通链接；没有 sellerId 就不给", () => {
    const withId = { sellerId: "1234" } as RivalListing;
    expect(shopEntryUrl(withId)).toContain("userId=1234");
    expect(shopEntryUrl({} as RivalListing)).toBeUndefined();
  });
});

describe("店铺页快照解析", () => {
  const shopSnapshot = {
    capturedAt: new Date(NOW).toISOString(),
    pageUrl: "https://www.goofish.com/personal?userId=777",
    pageType: "shop" as const,
    sellerId: "777",
    sellerName: "老王的店",
    items: [
      {
        layer: "dom",
        itemId: "900001",
        title: "智能体实战课",
        url: "https://www.goofish.com/item?id=900001",
        visibleText: "智能体实战课 ¥99",
      },
      {
        layer: "dom",
        itemId: "900002",
        title: "提示词合集",
        url: "https://www.goofish.com/item?id=900002",
        visibleText: "提示词合集 ¥39",
      },
    ],
  };

  it("个人页不再解析成 0 件，卡片都进来", () => {
    const parsed = parsePageSnapshot(shopSnapshot, NOW);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.every((item) => item.source === "shop")).toBe(true);
  });

  it("卡片自己没有卖家字段，从这一页的身份补上", () => {
    const parsed = parsePageSnapshot(shopSnapshot, NOW);
    expect(parsed.items.map((item) => item.sellerId)).toEqual(["777", "777"]);
    expect(parsed.items[0]!.shopUrl).toContain("userId=777");
  });

  it("解析结果带上这一页是谁的店", () => {
    expect(parsePageSnapshot(shopSnapshot, NOW).shop).toEqual({
      sellerId: "777",
      sellerName: "老王的店",
    });
  });

  it("快照没声明类型时，按地址认出是店铺页", () => {
    const parsed = parsePageSnapshot(
      { ...shopSnapshot, pageType: undefined, sellerId: undefined },
      NOW,
    );
    expect(parsed.items[0]!.source).toBe("shop");
    expect(parsed.shop?.sellerId).toBe("777");
  });

  it("店铺列表卡不会凭空长出浏览量", () => {
    const parsed = parsePageSnapshot(shopSnapshot, NOW);
    expect(parsed.items[0]!.views).toBeUndefined();
    expect(parsed.items[0]!.wants).toBeUndefined();
    expect(isListSource(parsed.items[0]!.source)).toBe(true);
  });
});

describe("从商详认卖家", () => {
  const detailApi = {
    api: "mtop.taobao.idle.pc.detail",
    ret: ["SUCCESS::调用成功"],
    data: {
      itemDO: { itemId: "900001", title: "智能体课" },
      sellerDO: { userId: "777", nick: "老王的店" },
    },
  };

  it("从商详响应里认出卖家", () => {
    expect(sellerFromRecord(detailApi)).toEqual({
      sellerId: "777",
      sellerName: "老王的店",
    });
  });

  it("补热度那条路要把卖家一起带进快照", () => {
    const parsed = parsePageSnapshot(
      detailSnapshotFromHeat({
        itemId: "900001",
        pageUrl: "https://www.goofish.com/item?id=900001",
        wants: 10,
        views: 133,
        sellerId: "777",
        sellerName: "老王的店",
      }),
      NOW,
    );

    // 商详地址上没有 userId，只能靠响应带过来
    expect(parsed.items[0]!.sellerId).toBe("777");
    expect(parsed.items[0]!.shopUrl).toContain("userId=777");
    expect(parsed.items[0]!.sellerName).toBe("老王的店");
  });

  it("没认出卖家时不编一个", () => {
    expect(sellerFromRecord(undefined).sellerId).toBeUndefined();
    const parsed = parsePageSnapshot(
      detailSnapshotFromHeat({
        itemId: "900001",
        pageUrl: "https://www.goofish.com/item?id=900001",
        wants: 10,
      }),
      NOW,
    );
    expect(parsed.items[0]!.sellerId).toBeUndefined();
    expect(parsed.items[0]!.shopUrl).toBeUndefined();
  });
});

describe("商详响应要整份交给解析", () => {
  // 字段名照真实响应，值是假的
  const detailApi = {
    api: "mtop.taobao.idle.pc.detail",
    ret: ["SUCCESS::调用成功"],
    data: {
      itemDO: {
        itemId: "900001",
        title: "AI赋能企业增长营",
        desc: "两天线下营，八大核心模块，含餐含资料。",
        soldPrice: "499",
        browseCnt: 13,
        imageInfos: [
          { url: "https://img.alicdn.com/bao/uploaded/i1/real-cover.jpg", major: true },
          { url: "https://img.alicdn.com/bao/uploaded/i1/real-second.jpg" },
        ],
      },
      sellerDO: { userId: "1686044325", nick: "厉害猫秦老板" },
    },
  };

  it("正文、大图、价格、浏览、卖家都要抽出来", () => {
    const parsed = parsePageSnapshot(
      {
        capturedAt: new Date(NOW).toISOString(),
        pageUrl: "https://www.goofish.com/item?id=900001",
        pageType: "detail",
        api: detailApi,
        dom: { itemId: "900001" },
      },
      NOW,
    );

    const item = parsed.items[0]!;
    expect(item.copy).toContain("八大核心模块");
    expect(item.imageUrls).toContain("https://img.alicdn.com/bao/uploaded/i1/real-cover.jpg");
    expect(item.views).toBe(13);
    expect(item.priceCents).toBe(49900);
    expect(item.sellerId).toBe("1686044325");
  });

  it("只拼几个数的老快照抽不到正文和图 —— 这就是之前的毛病", () => {
    const parsed = parsePageSnapshot(
      detailSnapshotFromHeat({
        itemId: "900001",
        pageUrl: "https://www.goofish.com/item?id=900001",
        views: 13,
      }),
      NOW,
    );
    expect(parsed.items[0]!.copy).toBeUndefined();
    expect(parsed.items[0]!.imageUrls).toEqual([]);
  });
});

describe("挡掉「价格面议」的哨兵值", () => {
  it("全 9 的数是待议，不是九十九万", () => {
    expect(isSentinelYuan(999999)).toBe(true);
    expect(isSentinelYuan(9999999)).toBe(true);
    expect(isSentinelYuan(99.99)).toBe(false);
    expect(isSentinelYuan(999)).toBe(false);
    // 恰好很贵但不是全 9 的照常记
    expect(isSentinelYuan(1000000)).toBe(false);
  });

  it("商详给哨兵值时不记价格，列表卡的真实价留着", () => {
    const parsed = parsePageSnapshot(
      {
        capturedAt: new Date(NOW).toISOString(),
        pageUrl: "https://www.goofish.com/item?id=900002",
        pageType: "detail",
        api: {
          api: "mtop.taobao.idle.pc.detail",
          data: { itemDO: { itemId: "900002", title: "AI GEO运营", soldPrice: "999999" } },
        },
      },
      NOW,
    );
    expect(parsed.items[0]!.priceCents).toBeUndefined();
  });
});

describe("挡掉徽标和占位图", () => {
  it("尺寸写在文件名里的小图不能当商品图", () => {
    // 列表卡上的「包邮」角标
    expect(isTinyImage("https://gw.alicdn.com/imgextra/i1/O1CN01_-tps-84-60.png")).toBe(true);
    // 懒加载占位图
    expect(isTinyImage("https://img.alicdn.com/imgextra/i4/O1CN01_-tps-2-2.png")).toBe(true);
    // 真商品图
    expect(isTinyImage("https://img.alicdn.com/imgextra/i4/O1CN01_-tps-800-800.jpg")).toBe(false);
    expect(isTinyImage("https://img.alicdn.com/bao/uploaded/i1/real-cover.jpg")).toBe(false);
  });

  it("已经入库的垃圾图在渲染时就会被滤掉", () => {
    expect(
      displayImageUrls([
        "https://img.alicdn.com/bao/uploaded/i1/real-cover.jpg",
        "https://gw.alicdn.com/imgextra/i1/O1CN01_-tps-84-60.png",
        "https://img.alicdn.com/imgextra/i4/O1CN01_-tps-2-2.png",
      ]),
    ).toEqual(["https://img.alicdn.com/bao/uploaded/i1/real-cover.jpg"]);
  });
});

describe("店铺任务", () => {
  function emptyState(): AppState {
    return { research: { tasks: [], rivals: [] } } as unknown as AppState;
  }

  it("认人认 sellerId，不认昵称", () => {
    expect(shopTaskName("老王的店", "777")).toBe("店铺 · 老王的店");
    expect(shopTaskName(undefined, "777")).toBe("店铺 · 777");
  });

  it("同一家店复用同一个任务，不每采一页新建一个", () => {
    const state = emptyState();
    const first = ensureShopTask(state, { sellerId: "777", sellerName: "老王的店" }, NOW);
    const again = ensureShopTask(state, { sellerId: "777" }, NOW + 10_000);

    expect(again.id).toBe(first.id);
    expect(state.research.tasks).toHaveLength(1);
    expect(first.kind).toBe("shop");
  });

  it("昵称改了跟着改，任务身份不变", () => {
    const state = emptyState();
    const first = ensureShopTask(state, { sellerId: "777", sellerName: "老王的店" }, NOW);
    ensureShopTask(state, { sellerId: "777", sellerName: "新名字" }, NOW + 10_000);

    expect(first.name).toBe("店铺 · 新名字");
    expect(first.sellerId).toBe("777");
  });

  it("不同的店各是各的任务", () => {
    const state = emptyState();
    ensureShopTask(state, { sellerId: "777" }, NOW);
    ensureShopTask(state, { sellerId: "888" }, NOW + 1000);

    expect(state.research.tasks).toHaveLength(2);
    expect(findShopTask(state.research.tasks, "888")?.sellerId).toBe("888");
    expect(findShopTask(state.research.tasks, "999")).toBeUndefined();
  });
});

describe("店铺任务的容量", () => {
  function rivals(count: number): RivalListing[] {
    return Array.from({ length: count }, (_, index) => ({
      id: `R${index}`,
      taskId: "T1",
      itemId: `${index}`,
      title: `货 ${index}`,
      url: "",
      addedAt: new Date(NOW - index * 1000).toISOString(),
      alignment: "comparable",
      alignmentBy: "auto",
      observations: [],
    })) as RivalListing[];
  }

  it("关键词任务 80 件，店铺任务放宽到 200", () => {
    expect(rivalCapFor("keyword")).toBe(80);
    expect(rivalCapFor(undefined)).toBe(80);
    expect(rivalCapFor("shop")).toBe(MAX_RIVALS_PER_SHOP_TASK);
  });

  it("整店 150 件在关键词任务里会被砍掉，在店铺任务里留得下", () => {
    expect(pruneRivalsForTask(rivals(150), "keyword")).toHaveLength(80);
    expect(pruneRivalsForTask(rivals(150), "shop")).toHaveLength(150);
  });
});

describe("每天开商详的预算", () => {
  function tried(count: number, at: string): RivalListing[] {
    return Array.from({ length: count }, (_, index) => ({
      id: `R${index}`,
      lastDetailTryAt: at,
    })) as RivalListing[];
  }

  it("按今天试过的件数扣预算", () => {
    const today = new Date(NOW).toISOString();
    expect(detailBudgetLeft(tried(10, today), NOW, 60)).toBe(50);
    expect(detailBudgetLeft(tried(60, today), NOW, 60)).toBe(0);
    // 用超了也不给负数
    expect(detailBudgetLeft(tried(80, today), NOW, 60)).toBe(0);
  });

  it("昨天试过的不占今天的预算", () => {
    const yesterday = new Date(NOW - 24 * 3600_000).toISOString();
    expect(detailBudgetLeft(tried(60, yesterday), NOW, 60)).toBe(60);
  });
});
