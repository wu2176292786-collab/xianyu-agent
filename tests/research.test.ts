import { beforeEach, describe, expect, it } from "vitest";
import { proposeActions } from "@/lib/agent/engine";
import { createSeedState } from "@/lib/domain/seed";
import type { AppState, ResearchTask } from "@/lib/domain/types";
import {
  findingsFor,
  priceBand,
  revisitQueue,
  wantsTrend,
} from "@/lib/research/analysis";
import {
  ensureCollectorToken,
  newCollectorToken,
  parseImportBody,
  verifyCollectorToken,
} from "@/lib/research/collector";
import {
  DEDUPE_WINDOW_MS,
  alignmentFor,
  describeRecord,
  recordObservations,
} from "@/lib/research/record";
import {
  extractItemId,
  parsePageSnapshot,
  readDelivery,
  readWantsFromText,
} from "@/lib/research/snapshot";

const NOW = Date.parse("2026-01-10T12:00:00.000Z");
const HOUR = 3_600_000;

function snapshotAt(hoursAgo: number, extra: Record<string, unknown>) {
  return {
    capturedAt: new Date(NOW - hoursAgo * HOUR).toISOString(),
    pageUrl: "https://www.goofish.com/item?id=900001",
    pageType: "detail",
    ...extra,
  };
}

describe("itemId 抽取", () => {
  it("从商详地址里抠出 id", () => {
    expect(extractItemId("https://www.goofish.com/item?id=812345")).toBe("812345");
    expect(extractItemId("https://www.goofish.com/item?spm=a.b&id=999#x")).toBe("999");
    expect(extractItemId("https://www.goofish.com/item/700001")).toBe("700001");
  });

  it("认不出来就是 undefined，不猜", () => {
    expect(extractItemId("https://www.goofish.com/personal")).toBeUndefined();
    expect(extractItemId(undefined)).toBeUndefined();
  });
});

describe("可见文字抽取", () => {
  it("认「N人想要」并留下原文片段", () => {
    const hit = readWantsFromText("九成新 · 86人想要 · 包邮发出")!;
    expect(hit.value).toBe(86);
    expect(hit.excerpt).toContain("86人想要");
  });

  it("带千分位也能认", () => {
    expect(readWantsFromText("1,204人想要")?.value).toBe(1204);
    expect(readWantsFromText("想要：312")?.value).toBe(312);
  });

  it("没有「想要」字样时不认孤立数字", () => {
    expect(readWantsFromText("电池健康 92 成色九成新")).toBeUndefined();
  });

  it("交付方式只认看得见的写法", () => {
    expect(readDelivery("全国包邮")).toBe("free_shipping");
    expect(readDelivery("运费到付")).toBe("buyer_pays");
    expect(readDelivery("仅限自提")).toBe("pickup");
    expect(readDelivery("九成新 无拆修")).toBe("unknown");
  });
});

describe("快照解析：三层抽取", () => {
  it("页面接口优先，并记下是哪一层给的", () => {
    const parsed = parsePageSnapshot(
      snapshotAt(0, {
        api: { data: { itemDO: { itemId: "900001", title: "Switch OLED 白色", wantCnt: 88, soldPrice: 1699 } } },
        visibleText: "12人想要",
      }),
      NOW,
    );

    expect(parsed.items).toHaveLength(1);
    const [item] = parsed.items;
    expect(item.wants).toBe(88);
    expect(item.wantsFrom).toBe("api");
    expect(item.priceCents).toBe(169900);
  });

  it("接口里没有就退到内嵌 JSON", () => {
    const parsed = parsePageSnapshot(
      snapshotAt(0, {
        api: { data: { itemDO: { itemId: "900001", title: "Switch OLED" } } },
        hydration: { data: { wantCnt: 45 } },
      }),
      NOW,
    );

    expect(parsed.items[0].wants).toBe(45);
    expect(parsed.items[0].wantsFrom).toBe("hydration");
  });

  it("两层都没有才读可见文字，并把原文存进证据", () => {
    const parsed = parsePageSnapshot(
      snapshotAt(0, { visibleText: "Switch OLED 白色 · 63人想要 · 包邮" }),
      NOW,
    );

    const [item] = parsed.items;
    // itemId 从 pageUrl 兜底
    expect(item.itemId).toBe("900001");
    expect(item.wants).toBe(63);
    expect(item.wantsFrom).toBe("dom");
    expect(item.excerpt).toContain("63人想要");
    expect(item.delivery).toBe("free_shipping");
  });

  it("抽不到「想要」时记成缺失，不写成 0", () => {
    const parsed = parsePageSnapshot(
      snapshotAt(0, { visibleText: "成色九成新 无拆修" }),
      NOW,
    );

    const [item] = parsed.items;
    expect(item.wants).toBeUndefined();
    expect(item.missing).toContain("wants");
    expect(item.missing).toContain("price");
  });

  it("认不出 itemId 的记录被跳过并计数", () => {
    const parsed = parsePageSnapshot(
      { capturedAt: new Date(NOW).toISOString(), pageUrl: "https://www.goofish.com/personal" },
      NOW,
    );

    expect(parsed.items).toHaveLength(0);
    expect(parsed.skipped).toBe(1);
  });

  it("认不出商品时，这条原因排在其它提醒前面", () => {
    const parsed = parsePageSnapshot({ pageUrl: "https://www.goofish.com/personal" }, NOW);

    expect(parsed.items).toHaveLength(0);
    // 「没有 capturedAt」只是提醒，挡住入库的是认不出商品
    expect(parsed.warnings[0]).toContain("没认出任何商品");
    expect(parsed.warnings.some((w) => w.includes("capturedAt"))).toBe(true);
  });

  it("不是合法 JSON 时给出人话提示，而不是抛异常", () => {
    const parsed = parsePageSnapshot("{不是 json", NOW);
    expect(parsed.items).toHaveLength(0);
    expect(parsed.warnings[0]).toContain("JSON");
  });

  it("搜索页的多张卡片各自成一条，默认按可见文字记层级", () => {
    const parsed = parsePageSnapshot(
      {
        capturedAt: new Date(NOW).toISOString(),
        pageUrl: "https://www.goofish.com/search?q=switch",
        items: [
          { itemId: "900101", title: "Switch OLED 白", price: 1680, visibleText: "30人想要 包邮" },
          { itemId: "900102", title: "Switch OLED 黑", price: 1580 },
          { title: "没有 itemId 的卡片" },
        ],
      },
      NOW,
    );

    expect(parsed.items).toHaveLength(2);
    expect(parsed.skipped).toBe(1);
    expect(parsed.items[0].source).toBe("search");
    expect(parsed.items[0].wants).toBe(30);
    expect(parsed.items[0].wantsFrom).toBe("dom");
    // 整页文字不能归给某一张卡片
    expect(parsed.items[1].wants).toBeUndefined();
  });
});

describe("快照解析：采集端读到的 DOM 字段", () => {
  it("接口和内嵌 JSON 都没有时，用采集端读的字段，并记成 dom 层", () => {
    const parsed = parsePageSnapshot(
      snapshotAt(0, {
        dom: { itemId: "900001", title: "Switch OLED 白色", wants: 71, price: 1666 },
        visibleText: "71人想要 · 包邮",
      }),
      NOW,
    );

    const [item] = parsed.items;
    expect(item.wants).toBe(71);
    expect(item.wantsFrom).toBe("dom");
    expect(item.priceCents).toBe(166600);
    expect(item.priceFrom).toBe("dom");
    expect(item.delivery).toBe("free_shipping");
  });

  it("页面接口有的字段，不会被采集端读的值顶掉", () => {
    const parsed = parsePageSnapshot(
      snapshotAt(0, {
        api: { data: { itemDO: { itemId: "900001", title: "Switch OLED", wantCnt: 88 } } },
        dom: { itemId: "900001", wants: 71, price: 1666 },
      }),
      NOW,
    );

    const [item] = parsed.items;
    expect(item.wants).toBe(88);
    expect(item.wantsFrom).toBe("api");
    // 接口里没有价格，这一项才轮到采集端
    expect(item.priceCents).toBe(166600);
    expect(item.priceFrom).toBe("dom");
  });
});

describe("采集端配对密钥", () => {
  it("生成的是够长的随机串，两次不会一样", () => {
    const a = newCollectorToken();
    const b = newCollectorToken();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it("只认一模一样的密钥", () => {
    const token = newCollectorToken();
    expect(verifyCollectorToken(token, token)).toBe(true);
    expect(verifyCollectorToken(token, `${token}x`)).toBe(false);
    expect(verifyCollectorToken(token, token.slice(0, -1))).toBe(false);
    expect(verifyCollectorToken(token, undefined)).toBe(false);
    expect(verifyCollectorToken(token, null)).toBe(false);
  });

  it("老状态里没有密钥就补一个，已有的不动", () => {
    const state = createSeedState(NOW);
    const seeded = state.research.collectorToken;
    expect(seeded).toMatch(/^[0-9a-f]{32}$/);
    expect(ensureCollectorToken(state)).toBe(seeded);

    delete state.research.collectorToken;
    const added = ensureCollectorToken(state);
    expect(added).toMatch(/^[0-9a-f]{32}$/);
    expect(state.research.collectorToken).toBe(added);
  });

  it("请求体缺什么就说缺什么", () => {
    expect(parseImportBody(null).ok).toBe(false);
    expect(parseImportBody({ taskId: "T", snapshot: {} })).toMatchObject({
      ok: false,
      message: expect.stringContaining("密钥"),
    });
    expect(parseImportBody({ token: "t", snapshot: {} })).toMatchObject({
      ok: false,
      message: expect.stringContaining("任务"),
    });
    expect(parseImportBody({ token: "t", taskId: "T" })).toMatchObject({
      ok: false,
      message: expect.stringContaining("快照"),
    });
    expect(parseImportBody({ token: "t", taskId: "T", snapshot: { a: 1 } })).toMatchObject({
      ok: true,
      value: { token: "t", taskId: "T" },
    });
  });
});

describe("规格对齐判定", () => {
  const task: ResearchTask = {
    id: "T1",
    name: "t",
    keyword: "",
    mustInclude: ["OLED"],
    mustExclude: ["续航版"],
    revisitHours: 48,
    status: "active",
    createdAt: new Date(NOW).toISOString(),
  };

  it("命中必须不含判为不同款，优先于必须含", () => {
    expect(alignmentFor(task, "Switch OLED 续航版 混发")).toBe("different");
  });

  it("命中全部必须含判为可比，大小写不敏感", () => {
    expect(alignmentFor(task, "switch oled 白色")).toBe("comparable");
  });

  it("拿不准就是存疑", () => {
    expect(alignmentFor(task, "任天堂游戏机 白色")).toBe("uncertain");
    expect(alignmentFor(task, undefined)).toBe("uncertain");
  });
});

describe("入库：只追加不覆盖", () => {
  let state: AppState;
  const taskId = "RT001";

  beforeEach(() => {
    state = createSeedState(NOW);
  });

  it("同一 itemId 二次导入是追加观察，旧证据留着", () => {
    const first = parsePageSnapshot(
      snapshotAt(30, {
        api: { data: { itemDO: { itemId: "900001", title: "Switch OLED 白色", wantCnt: 50, soldPrice: 1700 } } },
      }),
      NOW,
    );
    const second = parsePageSnapshot(
      snapshotAt(2, {
        api: { data: { itemDO: { itemId: "900001", title: "Switch OLED 白色", wantCnt: 62, soldPrice: 1650 } } },
      }),
      NOW,
    );

    const a = recordObservations(state, taskId, first, NOW);
    const b = recordObservations(state, taskId, second, NOW);

    expect(a.added).toBe(1);
    expect(b.added).toBe(0);
    expect(b.observed).toBe(1);

    const rival = state.research.rivals.find((r) => r.itemId === "900001")!;
    expect(rival.observations).toHaveLength(2);
    expect(rival.observations[0].wants).toBe(50);
    expect(rival.observations[1].wants).toBe(62);
  });

  it("窗口内的重复观察只留一条，且留下字段更完整的那条", () => {
    const withoutPrice = parsePageSnapshot(
      snapshotAt(1, { visibleText: "44人想要" }),
      NOW,
    );
    const withPrice = parsePageSnapshot(
      {
        ...snapshotAt(1, {
          api: { data: { itemDO: { itemId: "900001", title: "Switch OLED", wantCnt: 44, soldPrice: 1699 } } },
        }),
        // 和上一条只差几分钟，属于「刷新了一下」
        capturedAt: new Date(NOW - HOUR + DEDUPE_WINDOW_MS / 2).toISOString(),
      },
      NOW,
    );

    recordObservations(state, taskId, withoutPrice, NOW);
    const second = recordObservations(state, taskId, withPrice, NOW);

    const rival = state.research.rivals.find((r) => r.itemId === "900001")!;
    expect(second.deduped).toBe(1);
    expect(second.observed).toBe(0);
    expect(rival.observations).toHaveLength(1);
    expect(rival.observations[0].priceCents).toBe(169900);
  });

  it("抽不到「想要」的观察会被如实计数", () => {
    const parsed = parsePageSnapshot(snapshotAt(0, { visibleText: "成色九成新" }), NOW);
    const summary = recordObservations(state, taskId, parsed, NOW);

    expect(summary.missingWants).toBe(1);
    expect(describeRecord(summary)).toContain("没抽到「想要」");
  });

  it("自动判定不会覆盖人工标过的对齐结论", () => {
    const parsed = parsePageSnapshot(
      snapshotAt(3, {
        api: { data: { itemDO: { itemId: "900001", title: "任天堂游戏机 白色", wantCnt: 10 } } },
      }),
      NOW,
    );
    recordObservations(state, taskId, parsed, NOW);

    const rival = state.research.rivals.find((r) => r.itemId === "900001")!;
    expect(rival.alignment).toBe("uncertain");

    rival.alignment = "comparable";
    rival.alignmentBy = "human";
    recordObservations(state, taskId, parsed, NOW);
    expect(rival.alignment).toBe("comparable");
  });

  it("同行商品不会进本店商品表，规则引擎也不会对它们提案", () => {
    const before = state.listings.length;
    const parsed = parsePageSnapshot(
      snapshotAt(0, {
        api: { data: { itemDO: { itemId: "900001", title: "Switch OLED 白色", wantCnt: 50 } } },
      }),
      NOW,
    );
    recordObservations(state, taskId, parsed, NOW);

    expect(state.listings).toHaveLength(before);
    const proposals = proposeActions(state, NOW);
    const touched = proposals.map((p) =>
      "listingId" in p.payload ? p.payload.listingId : "",
    );
    expect(touched).not.toContain("900001");
  });
});

describe("想要趋势", () => {
  let state: AppState;

  beforeEach(() => {
    state = createSeedState(NOW);
  });

  it("两次商详观察算出增量、间隔和日均增速", () => {
    const rival = state.research.rivals.find((r) => r.itemId === "812345001")!;
    const trend = wantsTrend(rival);

    expect(trend.previous).toBe(82);
    expect(trend.latest).toBe(93);
    expect(trend.delta).toBe(11);
    expect(trend.hours).toBeCloseTo(48, 5);
    expect(trend.perDay).toBeCloseTo(5.5, 5);
  });

  it("只有一次观察时说明原因，不假装算出了变化", () => {
    const rival = state.research.rivals.find((r) => r.itemId === "812345003")!;
    const trend = wantsTrend(rival);

    expect(trend.latest).toBe(26);
    expect(trend.delta).toBeUndefined();
    expect(trend.note).toContain("再回访");
  });

  it("搜索页观察不参与趋势计算", () => {
    const rival = state.research.rivals.find((r) => r.itemId === "812345003")!;
    rival.observations.push({
      id: "OBX",
      at: new Date(NOW - HOUR).toISOString(),
      source: "search",
      wants: 999,
      wantsFrom: "dom",
      delivery: "unknown",
      pageUrl: "https://www.goofish.com/search?q=switch",
      missing: ["price", "delivery"],
    });

    expect(wantsTrend(rival).latest).toBe(26);
    expect(wantsTrend(rival).delta).toBeUndefined();
  });
});

describe("价格带", () => {
  let state: AppState;

  beforeEach(() => {
    state = createSeedState(NOW);
  });

  it("只用可比同行，并如实报出排除了几件", () => {
    const rivals = state.research.rivals;
    const band = priceBand(rivals);

    // 三件可比：1699 / 1750 / 1580
    expect(band.count).toBe(3);
    expect(band.minCents).toBe(158000);
    expect(band.medianCents).toBe(169900);
    expect(band.maxCents).toBe(175000);
    expect(band.excludedUncertain).toBe(1);
    expect(band.excludedDifferent).toBe(1);
  });

  it("可比但一次价格都没抽到的会被单独计数", () => {
    const rival = state.research.rivals.find((r) => r.itemId === "812345005")!;
    rival.alignment = "comparable";

    const band = priceBand(state.research.rivals);
    expect(band.count).toBe(3);
    expect(band.missingPrice).toBe(1);
  });
});

describe("回访清单", () => {
  let state: AppState;

  beforeEach(() => {
    state = createSeedState(NOW);
  });

  it("按上次观察时间和回访间隔算，不到期的不出现", () => {
    const task = state.research.tasks[0];
    const due = revisitQueue(task, state.research.rivals, NOW);

    // 62 小时前观察过一次的那件超过了 48 小时
    expect(due.map((d) => d.rival.itemId)).toContain("812345003");
    // 6 小时前刚观察过
    expect(due.map((d) => d.rival.itemId)).not.toContain("812345001");
    // 判为不同款的不用回访
    expect(due.map((d) => d.rival.itemId)).not.toContain("812345004");
  });

  it("间隔调长之后就没有到期的了", () => {
    const task = state.research.tasks[0];
    task.revisitHours = 240;
    expect(revisitQueue(task, state.research.rivals, NOW)).toHaveLength(0);
  });
});

describe("观察结论", () => {
  let state: AppState;

  beforeEach(() => {
    state = createSeedState(NOW);
  });

  it("每条结论都挂得上证据，或者干脆没有结论", () => {
    const task = state.research.tasks[0];
    const listing = state.listings.find((l) => l.id === task.linkedListingId);
    const findings = findingsFor(task, state.research.rivals, listing, NOW);

    expect(findings.length).toBeGreaterThan(0);
    const priceGap = findings.find((f) => f.id === "price_gap")!;
    expect(priceGap.evidence.length).toBeGreaterThan(0);
    expect(priceGap.evidence.every((e) => e.url.startsWith("https://"))).toBe(true);
  });

  it("结论里的价格来自观察点，不是编的", () => {
    const task = state.research.tasks[0];
    const listing = state.listings.find((l) => l.id === task.linkedListingId)!;
    const findings = findingsFor(task, state.research.rivals, listing, NOW);
    const priceGap = findings.find((f) => f.id === "price_gap")!;

    // 本店 1790，可比中位 1699 → 高出 5%
    expect(priceGap.text).toContain("¥1,790.00");
    expect(priceGap.text).toContain("¥1,699.00");
    expect(priceGap.severity).toBe("attention");
  });

  it("可比同行不足两件时只说样本不够，不给建议", () => {
    const task = state.research.tasks[0];
    for (const rival of state.research.rivals) rival.alignment = "uncertain";

    const findings = findingsFor(task, state.research.rivals, undefined, NOW);
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe("sample");
    expect(findings[0].evidence).toHaveLength(0);
  });

  it("指出谁在涨，并把涨幅挂上证据", () => {
    const task = state.research.tasks[0];
    const findings = findingsFor(task, state.research.rivals, undefined, NOW);
    const momentum = findings.find((f) => f.id === "wants_momentum")!;

    expect(momentum.text).toContain("2 件的「想要」在涨");
    expect(momentum.evidence[0].label).toContain("82→93");
  });
});
