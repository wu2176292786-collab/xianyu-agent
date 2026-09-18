import { describe, expect, it } from "vitest";
import { createSeedState } from "@/lib/domain/seed";
import { highlightGaps } from "@/lib/research/analysis";
import { alignmentFor } from "@/lib/research/record";
import {
  ensureListingResearchTask,
  excludeOwnListing,
  filterOwnFromParse,
  keepRelatedSearchItems,
  mergeSearchParses,
  searchItemsReq,
  searchKeywordFromListing,
  specWordsFromListing,
} from "@/lib/research/scout";
import { parsePageSnapshot } from "@/lib/research/snapshot";

const NOW = Date.parse("2026-01-10T12:00:00.000Z");

describe("从本店货抽出搜索词", () => {
  it("短标题整段拿去搜", () => {
    expect(searchKeywordFromListing({ title: "AI图片定制服务" })).toBe("AI图片定制服务");
  });

  it("长标题截到 28 字，不把正文整段塞进搜索", () => {
    const title = "AI agent 开发，工作流自动化，帮你把闲鱼客服和选品研究串起来的一整套";
    expect(searchKeywordFromListing({ title, copy: "很长的正文".repeat(20) })).toBe(
      title.slice(0, 28),
    );
  });
});

describe("规格对齐词", () => {
  it("有标签就用标签", () => {
    expect(
      specWordsFromListing({ title: "随便", tags: ["AI客服", "自动化"] }),
    ).toEqual(["AI客服", "自动化"]);
  });

  it("没标签时从标题拆两段", () => {
    expect(specWordsFromListing({ title: "AI agent 开发，工作流自动化" })).toEqual([
      "AI",
      "agent",
    ]);
  });

  it("一整段中文标题取前四个字当规格", () => {
    expect(specWordsFromListing({ title: "AI图片定制服务" })).toEqual(["AI图片"]);
  });

  it("跳过一人公司这种空词，用陪跑和业务词去对齐", () => {
    expect(
      specWordsFromListing({ title: "一人公司 ai陪跑 内容获客客服自动化" }),
    ).toEqual(["ai陪跑", "内容获客客服自动化"]);
    expect(
      searchKeywordFromListing({ title: "一人公司 ai陪跑 内容获客客服自动化" }),
    ).toBe("ai陪跑 内容获客客服自动化");
  });
});

describe("搜索请求", () => {
  it("带上关键词和页大小", () => {
    expect(searchItemsReq("AI图片定制服务")).toEqual({
      pageNumber: 1,
      keyword: "AI图片定制服务",
      rowsPerPage: 20,
      fromFilter: false,
      searchReqFromPage: "pcSearch",
    });
    expect(searchItemsReq("AI图片定制服务", 3).pageNumber).toBe(3);
  });

  it("三页结果按 itemId 去重后合并", () => {
    const page = (id: string) => ({
      items: [
        {
          itemId: id,
          url: `https://www.goofish.com/item?id=${id}`,
          source: "search" as const,
          delivery: "unknown" as const,
          imageUrls: [],
          missing: [],
          pageUrl: "https://www.goofish.com/search?q=ai",
          at: new Date(NOW).toISOString(),
        },
      ],
      skipped: 0,
      warnings: [],
    });
    const merged = mergeSearchParses([page("1"), page("2"), page("1")]);
    expect(merged.items.map((item) => item.itemId)).toEqual(["1", "2"]);
  });
});

describe("搜索卡价格", () => {
  it("认闲鱼搜索卡上拆开的价格碎片", () => {
    const parsed = parsePageSnapshot(
      {
        capturedAt: new Date(NOW).toISOString(),
        pageUrl: "https://www.goofish.com/search?q=ai",
        pageType: "search",
        api: {
          resultList: [
            {
              data: {
                item: {
                  main: {
                    clickParam: { args: { item_id: "rival-9", price: "8.80" } },
                    exContent: {
                      title: "AI图片定制 包邮现货",
                      price: [{ text: "¥" }, { text: "8.8" }],
                    },
                  },
                },
              },
            },
          ],
        },
      },
      NOW,
    );

    expect(parsed.items[0]?.priceCents).toBe(880);
  });
});

describe("搜偏的货不入库", () => {
  it("二手书对不上陪跑服务", () => {
    const kept = keepRelatedSearchItems(
      [
        {
          itemId: "book-1",
          title: "二手书 高等数学 教材",
          url: "https://www.goofish.com/item?id=book-1",
          source: "search",
          delivery: "unknown",
          imageUrls: [],
          missing: [],
          pageUrl: "https://www.goofish.com/item?id=book-1",
          at: new Date(NOW).toISOString(),
        },
        {
          itemId: "svc-1",
          title: "ai陪跑 获客客服自动化",
          url: "https://www.goofish.com/item?id=svc-1",
          source: "search",
          delivery: "unknown",
          imageUrls: [],
          missing: [],
          pageUrl: "https://www.goofish.com/item?id=svc-1",
          at: new Date(NOW).toISOString(),
        },
      ],
      { name: "对手", keyword: "ai陪跑", mustInclude: ["ai陪跑"] },
    );
    expect(kept.map((item) => item.itemId)).toEqual(["svc-1"]);
  });
});

describe("排除自己的货", () => {
  it("搜索结果里出现本店 itemId 时丢掉", () => {
    const parsed = parsePageSnapshot(
      {
        capturedAt: new Date(NOW).toISOString(),
        pageUrl: "https://www.goofish.com/search?q=ai",
        pageType: "search",
        api: {
          resultList: [
            {
              data: {
                item: {
                  main: {
                    clickParam: { args: { item_id: "mine-1" } },
                    exContent: { title: "AI图片定制服务" },
                  },
                },
              },
            },
            {
              data: {
                item: {
                  main: {
                    clickParam: { args: { item_id: "rival-9" } },
                    exContent: { title: "AI图片定制 包邮现货" },
                  },
                },
              },
            },
          ],
        },
      },
      NOW,
    );

    const kept = excludeOwnListing(parsed.items, "mine-1");
    expect(kept.map((item) => item.itemId)).toEqual(["rival-9"]);
    expect(filterOwnFromParse(parsed, "mine-1").items).toHaveLength(1);
  });
});

describe("研究任务复用", () => {
  it("同一件货复用进行中的任务，不每点一次新建", () => {
    const state = createSeedState(NOW);
    const listing = state.listings[0];
    const first = ensureListingResearchTask(state, listing, NOW);
    const second = ensureListingResearchTask(state, listing, NOW + 1000);
    expect(second.id).toBe(first.id);
    expect(state.research.tasks.filter((task) => task.linkedListingId === listing.id)).toHaveLength(
      1,
    );
  });

  it("还没有任务时建一个，挂上本店货和搜索词", () => {
    const state = createSeedState(NOW);
    const listing = {
      ...state.listings[0],
      id: "new-ai-1",
      title: "AI图片定制服务",
      tags: [],
    };
    state.listings.push(listing);
    const task = ensureListingResearchTask(state, listing, NOW);
    expect(task.linkedListingId).toBe("new-ai-1");
    expect(task.keyword).toBe("AI图片定制服务");
    expect(task.mustInclude).toEqual(["AI图片"]);
    expect(task.name).toContain("对手");
  });
});

describe("对手卖点", () => {
  it("只指出本店没写、同行标题里有的字", () => {
    const state = createSeedState(NOW);
    const listing = state.listings.find((item) => item.title.includes("Switch"))!;
    const comparable = state.research.rivals.filter((rival) => rival.alignment === "comparable");
    const finding = highlightGaps(listing, comparable);
    expect(finding?.id).toBe("highlight_gap");
    expect(finding?.text).toContain("包邮");
    expect(finding?.evidence.length).toBeGreaterThan(0);
    expect(finding?.evidence.every((item) => item.url.startsWith("https://"))).toBe(true);
  });
});
