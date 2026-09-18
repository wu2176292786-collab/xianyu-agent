import { lstat, mkdtemp, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { proposeActions } from "@/lib/agent/engine";
import { createSeedState } from "@/lib/domain/seed";
import type { AppState, ResearchTask, RivalListing } from "@/lib/domain/types";
import { competitionBrief } from "@/lib/research/brief";
import {
  findingsFor,
  heatGap,
  latestHeat,
  overlappingSpecWords,
  priceBand,
  nextDueTaskId,
  researchDueCount,
  researchDueTaskIds,
  revisitQueue,
  viewsTrend,
  wantsTrend,
  watchBoard,
} from "@/lib/research/analysis";
import { previousShopDay, shopDay } from "@/lib/format";
import {
  dailyCompare,
  hasTodayDetailHeat,
  heatPauseHolds,
  heatRunDue,
  latestDetailHeat,
  needsWatchPull,
  needsHeatFill,
  triedDetailToday,
} from "@/lib/research/heat";
import {
  watchCapacity,
  watchEligibility,
  watchPullQueue,
} from "@/lib/research/monitoring";
import { parseLoginState } from "@/lib/adapters/live/login-state";
import {
  contextOptionsFromLogin,
  cookiesToSeed,
  isBlankPageText,
  isRiskRet,
  isRiskText,
} from "@/lib/research/browse-item";
import {
  ensureCollectorToken,
  newCollectorToken,
  parseImportBody,
  verifyCollectorToken,
} from "@/lib/research/collector";
import {
  insertKeywordTask,
  parseCreateTaskBody,
  parseDeleteTaskBody,
  removeResearchTaskFromState,
} from "@/lib/research/task-write";
import {
  exportTaskCopy,
  latestPriceCents,
  rivalCopyText,
  rivalPolishDraft,
  safeExportName,
} from "@/lib/research/copy";
import { MAX_OBSERVATION_EXCERPT, MAX_OBSERVATIONS_PER_RIVAL, MAX_RIVALS_PER_TASK } from "@/lib/domain/limits";
import {
  DEDUPE_WINDOW_MS,
  alignmentFor,
  describeRecord,
  mergeImageUrls,
  pruneResearch,
  pruneRivalObservations,
  recordObservations,
  researchViewStamp,
} from "@/lib/research/record";
import {
  collectImageUrls,
  extractItemId,
  heatFromItemHtml,
  normalizeImageUrl,
  displayImageUrls,
  parsePageSnapshot,
  readDelivery,
  readRichTextDesc,
  readViewsFromText,
  readWantsFromText,
} from "@/lib/research/snapshot";
import { heatFromVisibleText } from "@/lib/research/browse-item";
import { detailSnapshotFromHeat, shouldSkipHeatApi } from "@/lib/research/pull";

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

  it("认商详上的「N人想要 | N浏览」", () => {
    const text = "19人想要 | 1192浏览";
    expect(readWantsFromText(text)?.value).toBe(19);
    expect(readViewsFromText(text)?.value).toBe(1192);
    expect(readViewsFromText("浏览 3,204 次")?.value).toBe(3204);
    expect(readWantsFromText("122人想要|1217浏览")?.value).toBe(122);
    expect(readViewsFromText("122人想要|1217浏览")?.value).toBe(1217);
  });

  it("从打开后的页面文字抠想要和浏览", () => {
    expect(heatFromVisibleText("122人想要|1217浏览")).toMatchObject({
      wants: 122,
      views: 1217,
    });
  });

  it("从商详 HTML 抠想要和浏览", () => {
    const html =
      '<div class="meta">122人想要|1217浏览</div><script>void 0</script>';
    expect(heatFromItemHtml(html)).toMatchObject({ wants: 122, views: 1217 });
  });

  it("用户点补热度时不再回过头打商详接口", () => {
    expect(shouldSkipHeatApi({ htmlOnly: true })).toBe(true);
    expect(
      shouldSkipHeatApi({
        browser: { readItemHeat: async () => undefined, close: async () => undefined },
      }),
    ).toBe(true);
    expect(shouldSkipHeatApi({})).toBe(false);
  });

  it("风控页文案要先认出来，不能当成浏览", () => {
    expect(isRiskText("请完成验证后继续浏览")).toBe(true);
    expect(isRiskText("滑动验证")).toBe(true);
    expect(isRiskText("122人想要|1217浏览")).toBe(false);
  });

  it("「网络不见了」是通用报错页，不算风控", () => {
    // 下架、接口失败、cookie 不对，看到的都是这一页。
    // 当成风控的话，一件打不开的货就能把整条链路停六小时。
    expect(isBlankPageText("网络不见了 >ω<")).toBe(true);
    expect(isRiskText("网络不见了 >ω<")).toBe(false);
    expect(isBlankPageText("122人想要|1217浏览")).toBe(false);
  });

  it("接口被拦时状态码还是 200，只能从 ret 看出来", () => {
    expect(isRiskRet({ ret: ["FAIL_SYS_USER_VALIDATE::需要验证"] })).toBe(true);
    expect(isRiskRet({ ret: ["RGV587_ERROR::异常访问"] })).toBe(true);
    expect(isRiskRet({ ret: "FAIL_SYS_ILLEGAL_ACCESS" })).toBe(true);
    expect(isRiskRet({ ret: ["SUCCESS::调用成功"] })).toBe(false);
    // 登录态过期不是风控，别把它也停六小时
    expect(isRiskRet({ ret: ["FAIL_SYS_SESSION_EXPIRED::过期"] })).toBe(false);
    expect(isRiskRet(undefined)).toBe(false);
    expect(isRiskRet("一段文字")).toBe(false);
  });

  it("接口被拦时，商品页抠到的热度也能落成商详观察", () => {
    const parsed = parsePageSnapshot(
      detailSnapshotFromHeat({
        itemId: "812345001",
        pageUrl: "https://www.goofish.com/item?id=812345001",
        wants: 122,
        views: 1217,
        visibleText: "122人想要|1217浏览",
      }),
      NOW,
    );
    expect(parsed.items[0]).toMatchObject({
      itemId: "812345001",
      source: "detail",
      wants: 122,
      views: 1217,
    });
  });

  it("交付方式只认看得见的写法", () => {
    expect(readDelivery("全国包邮")).toBe("free_shipping");
    expect(readDelivery("运费到付")).toBe("buyer_pays");
    expect(readDelivery("仅限自提")).toBe("pickup");
    expect(readDelivery("九成新 无拆修")).toBe("unknown");
  });
});

describe("打开商详用的浏览器上下文", () => {
  const exported = {
    cookie: "unb=1; cookie2=a",
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh) Chrome/152.0.0.0",
      "Accept-Language": "zh-CN,zh;q=0.9",
    },
    env: {
      navigator: { platform: "MacIntel", maxTouchPoints: 0, hardwareConcurrency: 10 },
      screen: { width: 1512, height: 982, devicePixelRatio: 2 },
      intl: { timeZone: "Asia/Shanghai", locale: "zh-CN" },
    },
  };

  it("照着导出登录态那台机器还原屏幕、时区和缩放", () => {
    const state = parseLoginState(exported)!;
    const options = contextOptionsFromLogin(state);

    expect(options.userAgent).toBe("Mozilla/5.0 (Macintosh) Chrome/152.0.0.0");
    expect(options.screen).toEqual({ width: 1512, height: 982 });
    expect(options.deviceScaleFactor).toBe(2);
    expect(options.timezoneId).toBe("Asia/Shanghai");
    expect(options.locale).toBe("zh-CN");
    expect(options.hasTouch).toBe(false);
    // viewport 要比屏幕矮一条浏览器界面，不能和屏幕一样高
    expect(options.viewport.width).toBe(1512);
    expect(options.viewport.height).toBeLessThan(982);
  });

  it("没有指纹时退回保守默认值，不瞎编一个屏幕", () => {
    const state = parseLoginState("unb=1; cookie2=a")!;
    const options = contextOptionsFromLogin(state);

    expect(options.screen).toBeUndefined();
    expect(options.deviceScaleFactor).toBeUndefined();
    expect(options.hasTouch).toBeUndefined();
    expect(options.viewport).toEqual({ width: 1280, height: 900 });
    expect(options.timezoneId).toBe("Asia/Shanghai");
  });
});

describe("补热度 profile 锁", () => {
  it("从 SingletonLock 目标里认出 pid", async () => {
    const { pidFromSingletonTarget, processExists, releaseStaleHeatProfile } =
      await import("@/lib/research/browse-item");
    expect(pidFromSingletonTarget("MacBook-12345")).toBe(12345);
    expect(pidFromSingletonTarget("host-1")).toBe(1);
    expect(pidFromSingletonTarget("broken")).toBeUndefined();
    expect(processExists(process.pid)).toBe(true);
    expect(processExists(999_999_999)).toBe(false);

    const dir = await mkdtemp(path.join(os.tmpdir(), "xianyu-heat-lock-"));
    expect(await releaseStaleHeatProfile(dir)).toBe(true);
    await symlink(`dead-host-999999999`, path.join(dir, "SingletonLock"));
    expect(await releaseStaleHeatProfile(dir)).toBe(true);
    await expect(lstat(path.join(dir, "SingletonLock"))).rejects.toThrow();

    await symlink(`${os.hostname()}-${process.pid}`, path.join(dir, "SingletonLock"));
    expect(await releaseStaleHeatProfile(dir)).toBe(false);
  });
});

describe("往持久 profile 里补 cookie", () => {
  const wanted = [
    { name: "cookie2" },
    { name: "unb" },
    { name: "_m_h5_tk" },
    { name: "x5sec" },
  ];

  it("profile 里已有的自刷新令牌不能拿快照里的旧值盖掉", () => {
    const seeded = cookiesToSeed(wanted, new Set(["_m_h5_tk", "x5sec"]), false);
    expect(seeded.map((c) => c.name)).toEqual(["cookie2", "unb"]);
  });

  it("profile 里没有的照样要补上", () => {
    const seeded = cookiesToSeed(wanted, new Set(), false);
    expect(seeded).toHaveLength(4);
  });

  it("用户重新导了登录态就整个换掉", () => {
    const seeded = cookiesToSeed(wanted, new Set(["_m_h5_tk", "x5sec"]), true);
    expect(seeded).toHaveLength(4);
  });
});

describe("每日热度的排队", () => {
  const today = shopDay(NOW);
  const yesterday = previousShopDay(today);

  function rival(
    id: string,
    extra: Partial<RivalListing> = {},
    lastDetail?: string,
  ): RivalListing {
    return {
      id,
      taskId: "T1",
      itemId: id,
      title: id,
      url: `https://www.goofish.com/item?id=${id}`,
      addedAt: `${yesterday}T08:00:00.000+08:00`,
      alignment: "comparable",
      alignmentBy: "auto",
      observations: lastDetail
        ? [{ id: `O${id}`, at: lastDetail, source: "detail", wants: 1, views: 2 }]
        : [],
      ...extra,
    } as RivalListing;
  }

  it("只有盯住且可比的货会进入监控队列", () => {
    expect(needsWatchPull(rival("A"), NOW)).toBe(true);
    expect(needsWatchPull(rival("B", { watched: true }), NOW)).toBe(true);
    expect(needsWatchPull(rival("C", { alignment: "different" }), NOW)).toBe(false);
    expect(watchPullQueue([rival("A"), rival("B", { watched: true })], NOW).map((item) => item.id)).toEqual(["B"]);
  });

  it("监控间隔按小时计算，不再被当天边界卡住", () => {
    const observedAt = new Date(NOW - 2 * 60 * 60 * 1000).toISOString();
    const watched = rival("两小时前", { watched: true }, observedAt);

    expect(needsWatchPull(watched, NOW, 3)).toBe(false);
    expect(needsWatchPull(watched, NOW, 2)).toBe(true);
    expect(watchPullQueue([watched], NOW, 3)).toHaveLength(0);
    expect(watchPullQueue([watched], NOW, 2).map((item) => item.id)).toEqual(["两小时前"]);
  });

  it("本监控间隔内采集失败不会反复占用队列", () => {
    const tried = rival("一小时前试过", {
      watched: true,
      lastDetailTryAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    });

    expect(watchPullQueue([tried], NOW, 2)).toHaveLength(0);
    expect(watchPullQueue([tried], NOW + 60 * 60 * 1000, 2).map((item) => item.id)).toEqual([
      "一小时前试过",
    ]);
  });

  it("已到监控间隔的货按最久没采排序，从没采过的排最前", () => {
    const queue = watchPullQueue(
      [
        rival("刚采过昨晚", { watched: true }, `${yesterday}T22:00:00.000+08:00`),
        rival("从没采过", { watched: true }),
        rival("昨天一早", { watched: true }, `${yesterday}T07:00:00.000+08:00`),
      ],
      NOW,
    );
    expect(queue.map((item) => item.id)).toEqual(["从没采过", "昨天一早"]);
  });

  it("没盯住的货不会挤进监控队列", () => {
    const queue = watchPullQueue(
      [
        rival("从没采过"),
        rival("盯住的", { watched: true }, new Date(NOW - 30 * 60 * 60 * 1000).toISOString()),
      ],
      NOW,
    );
    expect(queue.map((item) => item.id)).toEqual(["盯住的"]);
  });

  it("今天试过的让位，哪怕一次都没读到 —— 否则下架的货会把名额吃光", () => {
    const stuck = rival("下架了", {
      watched: true,
      lastDetailTryAt: `${today}T09:00:00.000+08:00`,
    });
    const waiting = rival("排在后面", { watched: true }, `${yesterday}T07:00:00.000+08:00`);

    expect(triedDetailToday(stuck, NOW)).toBe(true);
    expect(watchPullQueue([stuck, waiting], NOW).map((item) => item.id)).toEqual([
      "排在后面",
    ]);
  });

  it("试过的日子翻篇了就重新排队", () => {
    const yesterdayTry = rival("昨天试过", {
      watched: true,
      lastDetailTryAt: `${yesterday}T09:00:00.000+08:00`,
    });
    expect(triedDetailToday(yesterdayTry, NOW)).toBe(false);
    expect(watchPullQueue([yesterdayTry], NOW)).toHaveLength(1);
  });

  it("今天已经采到的不再排队", () => {
    const done = rival("今天采过", { watched: true }, `${today}T09:00:00.000+08:00`);
    expect(watchPullQueue([done], NOW)).toHaveLength(0);
  });

  it("手动与自动共用失败退避，失败后不会在同一间隔重开商详", () => {
    const tried = rival("失败后", {
      watched: true,
      lastDetailTryAt: new Date(NOW - HOUR).toISOString(),
    });
    expect(watchEligibility(tried, NOW, 2)).toMatchObject({
      eligible: false,
      reason: "retry_interval",
    });
    expect(watchEligibility(tried, NOW + HOUR, 2)).toMatchObject({ eligible: true });
  });

  it("监控数量超过安全预算时给出可保存的最短间隔", () => {
    expect(watchCapacity(61, 24)).toMatchObject({
      minimumIntervalHours: 25,
      withinBudget: false,
    });
    expect(watchCapacity(61, 25).withinBudget).toBe(true);
  });
});

describe("自动补数的冷却", () => {
  const GAP = 30 * 60 * 1000;

  it("没跑过就该跑", () => {
    expect(heatRunDue(undefined, NOW, GAP)).toBe(true);
    expect(heatRunDue({}, NOW, GAP)).toBe(true);
  });

  it("后台每 30 秒问一次，但不到间隔不开浏览器", () => {
    const pull = { lastAttemptAt: new Date(NOW).toISOString() };
    expect(heatRunDue(pull, NOW + 30_000, GAP)).toBe(false);
    expect(heatRunDue(pull, NOW + GAP - 1, GAP)).toBe(false);
    expect(heatRunDue(pull, NOW + GAP, GAP)).toBe(true);
  });

  it("时间戳坏了就当没跑过，不能一直卡住", () => {
    expect(heatRunDue({ lastAttemptAt: "不是时间" }, NOW, GAP)).toBe(true);
  });
});

describe("撞风控后的暂停", () => {
  const paused = {
    pauseUntil: new Date(NOW + 6 * HOUR).toISOString(),
    pauseLoginStamp: "file:100",
  };

  it("时间没到就一直拦着", () => {
    expect(heatPauseHolds(paused, NOW, "file:100")).toBe(true);
  });

  it("时间到了自然解除", () => {
    expect(heatPauseHolds(paused, NOW + 7 * HOUR, "file:100")).toBe(false);
  });

  it("换了新登录态就提前解除，不用干等满六小时", () => {
    expect(heatPauseHolds(paused, NOW, "file:200")).toBe(false);
  });

  it("读不到登录态版本时按原来的时间算", () => {
    expect(heatPauseHolds(paused, NOW, undefined)).toBe(true);
  });

  it("没暂停过就不拦", () => {
    expect(heatPauseHolds(undefined, NOW, "file:100")).toBe(false);
    expect(heatPauseHolds({}, NOW, "file:100")).toBe(false);
    expect(heatPauseHolds({ pauseUntil: "不是时间" }, NOW, "file:100")).toBe(false);
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

  it("接口里的 0 不当真，改认页面上的「19人想要 | 1192浏览」", () => {
    const parsed = parsePageSnapshot(
      snapshotAt(0, {
        api: {
          data: {
            itemDO: {
              itemId: "900001",
              title: "Switch OLED",
              wantCnt: 0,
              browseCnt: 0,
            },
          },
        },
        visibleText: "19人想要 | 1192浏览",
      }),
      NOW,
    );

    expect(parsed.items[0].wants).toBe(19);
    expect(parsed.items[0].wantsFrom).toBe("dom");
    expect(parsed.items[0].views).toBe(1192);
    expect(parsed.items[0].viewsFrom).toBe("dom");
  });

  it("字段不在老路径上时，也能从嵌套 wantCnt / browseCnt 抽出", () => {
    const parsed = parsePageSnapshot(
      snapshotAt(0, {
        api: {
          result: {
            item: {
              itemId: "900001",
              title: "Switch OLED",
              extra: { wantCnt: "122", browseCnt: "1217" },
            },
          },
        },
      }),
      NOW,
    );
    expect(parsed.items[0]?.wants).toBe(122);
    expect(parsed.items[0]?.views).toBe(1217);
  });

  it("剥掉信封的商详也能抽出浏览", () => {
    const parsed = parsePageSnapshot(
      snapshotAt(0, {
        api: {
          itemDO: {
            itemId: "900001",
            title: "Switch OLED",
            wantCnt: 19,
            browseCnt: 1192,
          },
        },
      }),
      NOW,
    );

    expect(parsed.items[0].wants).toBe(19);
    expect(parsed.items[0].views).toBe(1192);
    expect(parsed.items[0].wantsFrom).toBe("api");
    expect(parsed.items[0].viewsFrom).toBe("api");
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

describe("快照解析：图片和文案", () => {
  it("丢掉头像和 data URL，补全协议", () => {
    expect(normalizeImageUrl("//img.alicdn.com/bao/uploaded/i1/a.jpg")).toBe(
      "https://img.alicdn.com/bao/uploaded/i1/a.jpg",
    );
    expect(
      normalizeImageUrl(
        "http://img.alicdn.com/bao/uploaded/i1/O1CN01demo_!!123-0-xy_item.jpg",
      ),
    ).toBe("https://img.alicdn.com/bao/uploaded/i1/O1CN01demo_!!123-0-xy_item.jpg");
    expect(normalizeImageUrl("https://img.alicdn.com/bao/avatar/1.png")).toBeUndefined();
    expect(normalizeImageUrl("data:image/png;base64,xxx")).toBeUndefined();
    expect(normalizeImageUrl("not-a-url")).toBeUndefined();
    expect(
      normalizeImageUrl("https://www.goofish.com/item?id=1082520169649&categoryId=1"),
    ).toBeUndefined();
    expect(
      displayImageUrls([
        "https://www.goofish.com/item?id=1082520169649",
        "http://img.alicdn.com/bao/uploaded/i1/cover.jpg",
      ]),
    ).toEqual(["https://img.alicdn.com/bao/uploaded/i1/cover.jpg"]);
  });

  it("认已经剥掉信封的商详正文，并保住换行", () => {
    const parsed = parsePageSnapshot(
      snapshotAt(0, {
        api: {
          itemDO: {
            itemId: "1083266969053",
            title: "WorkBuddy智能体实战课",
            desc: "WorkBuddy智能体实战课\n\n36节高清视频，从安装配置到AI办公。\n适合想落地的人。",
            imageInfos: [
              { url: "http://img.alicdn.com/bao/uploaded/i1/cover.jpg", major: true },
            ],
          },
        },
      }),
      NOW,
    );

    const [item] = parsed.items;
    expect(item.itemId).toBe("1083266969053");
    expect(item.copy).toContain("36节高清视频");
    expect(item.copy).toContain("\n\n");
    expect(item.copyFrom).toBe("api");
    expect(item.imageUrls[0]).toContain("cover.jpg");
  });

  it("从商详接口抽出封面和正文", () => {
    const parsed = parsePageSnapshot(
      snapshotAt(0, {
        api: {
          data: {
            itemDO: {
              itemId: "900001",
              title: "Switch OLED 白色",
              wantCnt: 10,
              soldPrice: 1699,
              picUrl: "//img.alicdn.com/bao/uploaded/i1/cover.jpg",
              images: ["https://img.alicdn.com/bao/uploaded/i1/a.jpg", "https://img.alicdn.com/bao/uploaded/i1/b.jpg"],
              desc: "原盒全套，自用一年，功能正常。",
            },
          },
        },
      }),
      NOW,
    );

    const [item] = parsed.items;
    expect(item.imageUrls[0]).toContain("cover.jpg");
    expect(item.imageUrls).toContain("https://img.alicdn.com/bao/uploaded/i1/a.jpg");
    expect(item.copy).toBe("原盒全套，自用一年，功能正常。");
    expect(item.copyFrom).toBe("api");
    expect(item.missing).not.toContain("images");
    expect(item.missing).not.toContain("copy");
  });

  it("认已经剥掉信封的搜索列表，并抽出主图", () => {
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
                    clickParam: { args: { item_id: "1083266969053" } },
                    exContent: {
                      title: "WorkBuddy智能体课",
                      picUrl: "//img.alicdn.com/bao/uploaded/i1/workbuddy.jpg",
                    },
                    targetUrl: "https://www.goofish.com/item?id=1083266969053",
                  },
                },
              },
            },
          ],
        },
      },
      NOW,
    );

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].itemId).toBe("1083266969053");
    expect(parsed.items[0].title).toBe("WorkBuddy智能体课");
    expect(parsed.items[0].imageUrls).toEqual([
      "https://img.alicdn.com/bao/uploaded/i1/workbuddy.jpg",
    ]);
  });

  it("搜索卡的商详链接不当图片", () => {
    const parsed = parsePageSnapshot(
      {
        capturedAt: new Date(NOW).toISOString(),
        pageUrl: "https://www.goofish.com/search?q=ai",
        pageType: "search",
        items: [
          {
            layer: "api",
            itemId: "1082520169649",
            title: "混了链接的卡片",
            targetUrl: "https://www.goofish.com/item?id=1082520169649",
            imageUrls: [
              "https://www.goofish.com/item?id=1082520169649&categoryId=1",
              "http://img.alicdn.com/bao/uploaded/i1/real.jpg",
            ],
          },
        ],
      },
      NOW,
    );

    expect(parsed.items[0].imageUrls).toEqual([
      "https://img.alicdn.com/bao/uploaded/i1/real.jpg",
    ]);
  });

  it("认闲鱼搜索卡片里的主图", () => {
    const parsed = parsePageSnapshot(
      {
        capturedAt: new Date(NOW).toISOString(),
        pageUrl: "https://www.goofish.com/search?q=ai",
        items: [
          {
            layer: "api",
            itemId: "108326",
            title: "WorkBuddy智能体课",
            picUrl: "//img.alicdn.com/bao/uploaded/i1/workbuddy.jpg",
            description: "从 0 装到能办公，36 节高清视频。",
          },
        ],
      },
      NOW,
    );

    expect(parsed.items[0].imageUrls).toEqual([
      "https://img.alicdn.com/bao/uploaded/i1/workbuddy.jpg",
    ]);
    expect(parsed.items[0].copy).toContain("36 节");
  });

  it("采集端读到的 imageUrls / description 记成 dom 层", () => {
    const parsed = parsePageSnapshot(
      snapshotAt(0, {
        dom: {
          itemId: "900001",
          title: "Switch OLED",
          imageUrls: ["https://img.alicdn.com/bao/uploaded/i1/dom.jpg"],
          description: "九成新，原盒在，走闲鱼包邮。",
        },
      }),
      NOW,
    );

    expect(parsed.items[0].imageUrls).toEqual([
      "https://img.alicdn.com/bao/uploaded/i1/dom.jpg",
    ]);
    expect(parsed.items[0].copy).toContain("九成新");
    expect(parsed.items[0].copyFrom).toBe("dom");
  });

  it("能从 richTextDesc 里抽出字", () => {
    expect(
      readRichTextDesc(
        JSON.stringify({
          children: [{ text: "第一段卖点" }, { children: [{ text: "第二段说明" }] }],
        }),
      ),
    ).toBe("第一段卖点\n第二段说明");
  });

  it("collectImageUrls 不会把卖家头像当商品图", () => {
    expect(
      collectImageUrls({
        avatar: "https://img.alicdn.com/bao/avatar/seller.png",
        picUrl: "https://img.alicdn.com/bao/uploaded/i1/good.jpg",
      }),
    ).toEqual(["https://img.alicdn.com/bao/uploaded/i1/good.jpg"]);
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

  it("采集端新建任务只要名字，删除会连同行一起移出", () => {
    expect(parseCreateTaskBody({ token: "t", name: "  盯价  " })).toEqual({
      ok: true,
      token: "t",
      name: "盯价",
    });
    expect(parseCreateTaskBody({ token: "t", name: "   " }).ok).toBe(false);
    expect(parseDeleteTaskBody({ token: "t" }).ok).toBe(false);

    const state = createSeedState(NOW);
    const seedId = state.research.tasks[0]!.id;
    const created = insertKeywordTask(state, { name: "插件新建" }, NOW);
    expect(created).toMatchObject({ ok: true, taskId: expect.stringMatching(/^RT/) });
    expect(state.research.tasks[0]).toMatchObject({
      name: "插件新建",
      kind: "keyword",
    });

    const before = state.research.rivals.filter((rival) => rival.taskId === seedId).length;
    expect(before).toBeGreaterThan(0);
    const removed = removeResearchTaskFromState(state, seedId, NOW);
    expect(removed.ok).toBe(true);
    expect(removed.message).toContain("一并移出");
    expect(state.research.tasks.some((task) => task.id === seedId)).toBe(false);
    expect(state.research.rivals.some((rival) => rival.taskId === seedId)).toBe(false);
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

  it("陪跑服务碰上二手书标题判为不同款", () => {
    const service = {
      ...task,
      name: "对手 · 一人公司 ai陪跑",
      keyword: "ai陪跑 内容获客客服自动化",
      mustInclude: ["ai陪跑"],
      mustExclude: [],
    };
    expect(alignmentFor(service, "二手书 高等数学 教材 出版社")).toBe("different");
    expect(alignmentFor(service, "【二手】获客9787115498427")).toBe("different");
    expect(alignmentFor(service, "ai陪跑 客服自动化 一对一")).toBe("comparable");
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

  it("二次导入会补上图片和文案，观察只追加", () => {
    const first = parsePageSnapshot(
      snapshotAt(20, {
        api: { data: { itemDO: { itemId: "900001", title: "Switch OLED", wantCnt: 10, soldPrice: 1600 } } },
      }),
      NOW,
    );
    const second = parsePageSnapshot(
      snapshotAt(1, {
        api: {
          data: {
            itemDO: {
              itemId: "900001",
              title: "Switch OLED",
              wantCnt: 12,
              soldPrice: 1600,
              picUrl: "https://img.alicdn.com/bao/uploaded/i1/later.jpg",
              desc: "原盒在，功能正常。",
            },
          },
        },
      }),
      NOW,
    );

    recordObservations(state, taskId, first, NOW);
    recordObservations(state, taskId, second, NOW);

    const rival = state.research.rivals.find((r) => r.itemId === "900001")!;
    expect(rival.observations).toHaveLength(2);
    expect(rival.imageUrls).toEqual(["https://img.alicdn.com/bao/uploaded/i1/later.jpg"]);
    expect(rival.copy).toBe("原盒在，功能正常。");
  });

  it("后采到的图排前面，旧图留着", () => {
    expect(
      mergeImageUrls(
        ["https://img.alicdn.com/old.jpg"],
        ["https://img.alicdn.com/new.jpg", "https://img.alicdn.com/old.jpg"],
      ),
    ).toEqual(["https://img.alicdn.com/new.jpg", "https://img.alicdn.com/old.jpg"]);
  });

  it("观察超过上限时丢掉最旧的，摘录截短", () => {
    const rival = state.research.rivals.find((row) => row.itemId === "812345001")!;
    rival.observations = Array.from({ length: MAX_OBSERVATIONS_PER_RIVAL + 5 }, (_, i) => ({
      id: `OBcap${i}`,
      at: new Date(NOW + i * DEDUPE_WINDOW_MS * 2).toISOString(),
      source: "detail" as const,
      wants: 100 + i,
      delivery: "unknown" as const,
      pageUrl: rival.url,
      missing: [],
      excerpt: "x".repeat(400),
    }));

    pruneRivalObservations(rival);

    expect(rival.observations).toHaveLength(MAX_OBSERVATIONS_PER_RIVAL);
    expect(rival.observations[0]!.wants).toBe(105);
    expect(rival.observations.at(-1)!.wants).toBe(144);
    expect(
      rival.observations.every(
        (observation) => (observation.excerpt?.length ?? 0) <= MAX_OBSERVATION_EXCERPT,
      ),
    ).toBe(true);
  });

  it("任务里的同行超上限时盯住的不丢", () => {
    const taskId = "RT001";
    const extras = Array.from({ length: MAX_RIVALS_PER_TASK + 5 }, (_, index) => ({
      id: `RVcap${index}`,
      taskId,
      itemId: `cap${index}`,
      title: `同行 ${index}`,
      url: `https://www.goofish.com/item?id=cap${index}`,
      addedAt: new Date(NOW - (MAX_RIVALS_PER_TASK + 5 - index) * HOUR).toISOString(),
      alignment: "uncertain" as const,
      alignmentBy: "auto" as const,
      watched: index === 0,
      observations: [
        {
          id: `OBcapr${index}`,
          at: new Date(NOW - (MAX_RIVALS_PER_TASK + 5 - index) * HOUR).toISOString(),
          source: "search" as const,
          delivery: "unknown" as const,
          pageUrl: `https://www.goofish.com/item?id=cap${index}`,
          missing: [],
        },
      ],
    }));
    state.research.rivals = extras;

    pruneResearch(state);

    expect(state.research.rivals).toHaveLength(MAX_RIVALS_PER_TASK);
    expect(state.research.rivals.some((rival) => rival.itemId === "cap0" && rival.watched)).toBe(
      true,
    );
    expect(state.research.rivals.some((rival) => rival.itemId === "cap1")).toBe(false);
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

  it("入库后研究台短戳会变，给打开着的研究页当刷新信号", () => {
    const before = researchViewStamp(state);
    const parsed = parsePageSnapshot(
      snapshotAt(0, {
        pageUrl: "https://www.goofish.com/item?id=812399001",
        api: { data: { itemDO: { itemId: "812399001", title: "新同行", wantCnt: 12 } } },
      }),
      NOW,
    );
    const summary = recordObservations(state, taskId, parsed, NOW);
    expect(summary.added).toBe(1);
    expect(researchViewStamp(state)).not.toBe(before);
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

  it("表格热度会显示搜索页抽到的想要，0 不当真", () => {
    const rival = state.research.rivals.find((r) => r.itemId === "812345003")!;
    rival.observations = [
      {
        id: "OBS",
        at: new Date(NOW).toISOString(),
        source: "search",
        wants: 19,
        views: 1192,
        wantsFrom: "dom",
        viewsFrom: "dom",
        delivery: "unknown",
        pageUrl: "https://www.goofish.com/search?q=ai",
        missing: ["price", "delivery"],
      },
    ];
    expect(latestHeat(rival)).toEqual({
      wants: 19,
      wantsFrom: "dom",
      views: 1192,
      viewsFrom: "dom",
    });

    rival.observations[0]!.wants = 0;
    rival.observations[0]!.views = 0;
    expect(latestHeat(rival).wants).toBeUndefined();
    expect(latestHeat(rival).views).toBeUndefined();
    expect(heatGap(rival).views).toBe("还没打开商品页");
    expect(needsHeatFill(rival)).toBe(true);
  });

  it("商详打开过但没抽到热度，还要再补", () => {
    const rival = state.research.rivals.find((r) => r.itemId === "812345003")!;
    rival.observations = [
      {
        id: "OBS",
        at: new Date(NOW).toISOString(),
        source: "detail",
        delivery: "unknown",
        pageUrl: "https://www.goofish.com/item?id=812345003",
        missing: ["wants", "views"],
      },
    ];
    expect(needsHeatFill(rival)).toBe(true);
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

  it("按北京时间对比今天和昨天的想要、浏览", () => {
    const rival = state.research.rivals.find((r) => r.itemId === "812345001")!;
    const today = shopDay(NOW);
    const yesterday = previousShopDay(today);
    rival.observations[0]!.at = `${yesterday}T12:00:00.000+08:00`;
    rival.observations[1]!.at = `${today}T12:00:00.000+08:00`;

    expect(dailyCompare(rival, "wants", NOW)).toEqual({
      today: 93,
      yesterday: 82,
      delta: 11,
    });
    expect(dailyCompare(rival, "views", NOW)).toEqual({
      today: 1192,
      yesterday: 1112,
      delta: 80,
    });
    expect(needsWatchPull(rival, NOW)).toBe(false);
    expect(hasTodayDetailHeat(rival, NOW)).toBe(true);
    expect(latestDetailHeat(rival)).toMatchObject({ wants: 93, views: 1192 });

    rival.observations[1]!.at = `${yesterday}T18:00:00.000+08:00`;
    expect(needsWatchPull(rival, NOW)).toBe(true);
    expect(hasTodayDetailHeat(rival, NOW)).toBe(false);
    expect(needsHeatFill(rival)).toBe(false);
  });

  it("昨天缺数时用更早的商详做较上次，不把那天写成昨天", () => {
    const rival = state.research.rivals.find((r) => r.itemId === "812345001")!;
    const today = shopDay(NOW);
    const twoDaysAgo = previousShopDay(previousShopDay(today));
    rival.observations[0]!.at = `${twoDaysAgo}T12:00:00.000+08:00`;
    rival.observations[1]!.at = `${today}T12:00:00.000+08:00`;

    expect(dailyCompare(rival, "wants", NOW)).toEqual({
      today: 93,
      previous: 82,
      previousDay: twoDaysAgo,
      delta: 11,
      note: "昨天没采到",
    });
    expect(dailyCompare(rival, "wants", NOW).yesterday).toBeUndefined();
  });

  it("盯住的商品单独进监控板，并算出想要和浏览的变化", () => {
    const task = state.research.tasks[0];
    const board = watchBoard(task, state.research.rivals, NOW);
    expect(board.map((item) => item.rival.itemId)).toEqual(["812345001"]);
    expect(board[0]?.wants.latest).toBe(93);
    expect(board[0]?.wants.delta).toBe(11);
    expect(board[0]?.views.latest).toBe(1192);
    expect(board[0]?.views.delta).toBe(80);
    expect(viewsTrend(board[0]!.rival).previous).toBe(1112);
    expect(researchDueCount(task, state.research.rivals, NOW)).toBe(0);
    expect(board[0]?.triedThisInterval).toBe(false);
  });
});

describe("待回访任务跳转顺序", () => {
  it("只收进行中且有待回访的任务，并按列表顺序往下走", () => {
    const tasks = [
      { id: "t1", status: "active" },
      { id: "t2", status: "archived" },
      { id: "t3", status: "active" },
    ] as ResearchTask[];
    const dueOf = (id: string) => (id === "t1" || id === "t3" ? 1 : 0);

    const ids = tasks
      .filter((task) => task.status === "active")
      .filter((task) => dueOf(task.id) > 0)
      .map((task) => task.id);
    expect(ids).toEqual(["t1", "t3"]);
    expect(nextDueTaskId(ids)).toBe("t1");
    expect(nextDueTaskId(ids, "t1")).toBe("t3");
    expect(nextDueTaskId(ids, "t3")).toBe("t1");
    expect(nextDueTaskId(ids, "other")).toBe("t1");
    expect(nextDueTaskId([])).toBeUndefined();
  });

  it("researchDueTaskIds 跟角标同一套计数", () => {
    const state = createSeedState(NOW);
    const ids = researchDueTaskIds(
      state.research.tasks,
      state.research.rivals,
      NOW,
    );
    const counted = state.research.tasks
      .filter((task) => task.status === "active")
      .filter(
        (task) => researchDueCount(task, state.research.rivals, NOW) > 0,
      )
      .map((task) => task.id);
    expect(ids).toEqual(counted);
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

  it("必须含和必须不含有交集时标出来", () => {
    const task = { ...state.research.tasks[0], mustInclude: ["ai"], mustExclude: ["ai", "配件"] };
    expect(overlappingSpecWords(task)).toEqual(["ai"]);
  });

  it("一个同行都没有时，说清楚下一步是采集而不是等 Agent", () => {
    const task = state.research.tasks[0];
    const findings = findingsFor(task, [], undefined, NOW);
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe("empty");
    expect(findings[0].text).toContain("看对手");
    expect(findings[0].text).toContain(task.keyword);
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

describe("商品文案导出", () => {
  it("拼出标题、价格、正文和回链", () => {
    const state = createSeedState(NOW);
    const rival = state.research.rivals.find((r) => r.itemId === "812345001")!;
    const text = rivalCopyText(rival);

    expect(text).toContain("Nintendo Switch OLED");
    expect(text).toContain("¥1,699.00");
    expect(text).toContain("自用一年");
    expect(text).toContain("https://www.goofish.com/item?id=812345001");
    expect(latestPriceCents(rival)).toBe(169900);
  });

  it("送给模型的草稿不含商品回链", () => {
    const state = createSeedState(NOW);
    const rival = state.research.rivals.find((r) => r.itemId === "812345001")!;
    const draft = rivalPolishDraft(rival);

    expect(draft).toContain("标题：");
    expect(draft).toContain("Nintendo Switch OLED");
    expect(draft).toContain("¥1,699.00");
    expect(draft).toContain("自用一年");
    expect(draft).not.toContain("https://www.goofish.com");
  });

  it("导出文件名去掉非法字符", () => {
    expect(safeExportName('AI/智能体:"落地"')).toBe("AI_智能体_落地-文案.txt");
  });

  it("整份任务导出带序号，润色稿优先", () => {
    const state = createSeedState(NOW);
    const task = state.research.tasks[0];
    const rival = state.research.rivals[0];
    rival.polishedCopy = "OLED 白色主机，带塞尔达，包邮。";

    const text = exportTaskCopy(task, [rival]);
    expect(text).toContain(`# ${task.name}`);
    expect(text).toContain("【1】");
    expect(text).toContain("OLED 白色主机，带塞尔达，包邮。");
    expect(text).not.toContain("自用一年");
  });
});

describe("对照分析材料", () => {
  it("把本店价和同行价写进材料，供模型守卫", () => {
    const state = createSeedState(NOW);
    const task = state.research.tasks[0];
    const listing = state.listings.find((item) => item.id === task.linkedListingId)!;
    const brief = competitionBrief({
      task,
      listing,
      rivals: state.research.rivals,
      now: NOW,
    });

    expect(brief).toContain(listing.title);
    expect(brief).toContain("¥1,790.00");
    expect(brief).toContain("Nintendo Switch OLED");
    expect(brief).toContain("¥1,699.00");
    expect(brief).toContain("【规则结论】");
    expect(brief).not.toMatch(/建议定价 ¥?\d/);
  });

  it("不把存疑的二手书正文塞给模型", () => {
    const state = createSeedState(NOW);
    const task = {
      ...state.research.tasks[0],
      name: "对手 · 一人公司 ai陪跑",
      keyword: "ai陪跑",
      mustInclude: ["ai陪跑"],
    };
    const listing = {
      ...state.listings[0],
      title: "一人公司 ai陪跑 内容获客客服自动化",
    };
    const rival = {
      ...state.research.rivals[0],
      taskId: task.id,
      title: "二手书 高等数学 第七版 出版社正版",
      copy: "ISBN 9787302 教材",
      alignment: "uncertain" as const,
    };
    const brief = competitionBrief({
      task,
      listing,
      rivals: [rival],
      now: NOW,
    });
    expect(brief).toContain("没有规格可比的同行");
    expect(brief).not.toContain("高等数学");
    expect(brief).not.toContain("ISBN");
  });
});
