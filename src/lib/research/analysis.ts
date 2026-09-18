import type {
  Listing,
  ResearchTask,
  RivalListing,
  RivalObservation,
} from "@/lib/domain/types";
import { isListSource } from "@/lib/domain/types";
import { hoursSince, yuan } from "@/lib/format";
import {
  type DailyCompare,
  clampWatchIntervalHours,
  dailyCompare,
} from "./heat";
import { watchEligibility } from "./monitoring";
import { lastObservedAt } from "./record";
import { readDelivery } from "./snapshot";

/**
 * 「想要」趋势。
 *
 * **只比较商详对商详。** 搜索卡片上的「想要」有时不展示、有时是另一套字段，
 * 和商详混算会造出假涨跌。搜索页的观察照样存着，但不参与这里的计算。
 */
export interface WantsTrend {
  latest?: number;
  latestAt?: string;
  previous?: number;
  previousAt?: string;
  /** 两次商详观察之间的增量 */
  delta?: number;
  /** 两次观察间隔多少小时 */
  hours?: number;
  /** 折算成日均增速 */
  perDay?: number;
  /** 算不出来时，给人看的原因 */
  note?: string;
}

function detailMetric(
  rival: RivalListing,
  field: "wants" | "views",
): RivalObservation[] {
  return rival.observations
    .filter((o) => o.source === "detail" && presentCount(o[field]) !== undefined)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

function presentCount(value: number | undefined): number | undefined {
  return value !== undefined && value > 0 ? value : undefined;
}

/**
 * 表格上给人看的热度：有数就亮出来。
 *
 * 趋势仍只比商详对商详；这里把搜索页抽到的「想要 / 浏览」也显示，
 * 否则从搜索结果加进来的同行全是「—」。
 */
export function latestHeat(rival: RivalListing): {
  wants?: number;
  wantsFrom?: RivalObservation["wantsFrom"];
  views?: number;
  viewsFrom?: RivalObservation["viewsFrom"];
} {
  const ranked = [...rival.observations].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at),
  );
  const pick = <K extends "wants" | "views">(field: K) => {
    const details = ranked.filter(
      (o) => o.source === "detail" && presentCount(o[field]) !== undefined,
    );
    const any = ranked.filter((o) => presentCount(o[field]) !== undefined);
    return (details.at(-1) ?? any.at(-1)) as RivalObservation | undefined;
  };
  const want = pick("wants");
  const view = pick("views");
  return {
    wants: presentCount(want?.wants),
    wantsFrom: want?.wantsFrom,
    views: presentCount(view?.views),
    viewsFrom: view?.viewsFrom,
  };
}

/** 表格上空着的热度该怎么解释，避免看起来像采集失败。 */
export function heatGap(rival: RivalListing): {
  wants?: string;
  views?: string;
} {
  // 搜索卡和店铺列表卡都没有浏览，只有商详才有
  const onlyList =
    rival.observations.length > 0 &&
    rival.observations.every((observation) => isListSource(observation.source));
  if (onlyList) {
    return {
      wants: "还没打开商品页",
      views: "还没打开商品页",
    };
  }
  return {
    wants: "商详还没抽到想要",
    views: "商详还没抽到浏览",
  };
}

export function metricTrend(
  rival: RivalListing,
  field: "wants" | "views",
): WantsTrend {
  const label = field === "wants" ? "想要" : "浏览";
  const points = detailMetric(rival, field);
  if (points.length === 0) {
    return { note: `还没有一次商详观察抽到「${label}」。` };
  }

  const latest = points.at(-1)!;
  if (points.length === 1) {
    return {
      latest: latest[field],
      latestAt: latest.at,
      note: "只有一次观察，再回访一次才能看出变化。",
    };
  }

  const previous = points.at(-2)!;
  const hours = (Date.parse(latest.at) - Date.parse(previous.at)) / 3_600_000;
  const delta = latest[field]! - previous[field]!;

  return {
    latest: latest[field],
    latestAt: latest.at,
    previous: previous[field],
    previousAt: previous.at,
    delta,
    hours,
    perDay: hours >= 1 ? (delta / hours) * 24 : undefined,
  };
}

export function wantsTrend(rival: RivalListing): WantsTrend {
  return metricTrend(rival, "wants");
}

export function viewsTrend(rival: RivalListing): WantsTrend {
  return metricTrend(rival, "views");
}

/** 最近一次带价格的观察。价格没有商详 / 搜索的口径差异，所以两种都算。 */
function latestPriced(rival: RivalListing): RivalObservation | undefined {
  return [...rival.observations]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .filter((o) => o.priceCents !== undefined)
    .at(-1);
}

export interface PriceBand {
  /** 进入计算的同行数 */
  count: number;
  minCents: number;
  medianCents: number;
  maxCents: number;
  /** 因为规格存疑被排除的 */
  excludedUncertain: number;
  /** 判为不同款被排除的 */
  excludedDifferent: number;
  /** 规格可比、但一次价格都没抽到的 */
  missingPrice: number;
}

/**
 * 价格带。
 *
 * **只用规格「可比」的同行。** 存疑和不同款一律排除，并如实报出排除了几件 ——
 * 拿日版当国行比，比不比更糟。
 */
export function priceBand(rivals: RivalListing[]): PriceBand {
  const band: PriceBand = {
    count: 0,
    minCents: 0,
    medianCents: 0,
    maxCents: 0,
    excludedUncertain: rivals.filter((r) => r.alignment === "uncertain").length,
    excludedDifferent: rivals.filter((r) => r.alignment === "different").length,
    missingPrice: 0,
  };

  const prices: number[] = [];
  for (const rival of rivals.filter((r) => r.alignment === "comparable")) {
    const observation = latestPriced(rival);
    if (!observation) {
      band.missingPrice += 1;
      continue;
    }
    prices.push(observation.priceCents!);
  }

  if (prices.length === 0) return band;

  prices.sort((a, b) => a - b);
  const middle = Math.floor(prices.length / 2);
  band.count = prices.length;
  band.minCents = prices[0];
  band.maxCents = prices[prices.length - 1];
  band.medianCents =
    prices.length % 2 === 1
      ? prices[middle]
      : Math.round((prices[middle - 1] + prices[middle]) / 2);

  return band;
}

export interface RevisitItem {
  rival: RivalListing;
  lastAt: string;
  hours: number;
}

/**
 * 回访清单。
 *
 * 这一版没有爬虫，所以「监测」就是回访：时间线的密度等于你回访的密度。
 * 这里只负责告诉你哪几件该去看一眼，打开页面的动作由你做。
 */
export function revisitQueue(
  task: ResearchTask,
  rivals: RivalListing[],
  now: number,
): RevisitItem[] {
  return rivals
    .filter((r) => r.taskId === task.id && r.alignment !== "different")
    .map((rival) => {
      const lastAt = lastObservedAt(rival);
      return { rival, lastAt, hours: hoursSince(lastAt, now) };
    })
    .filter((item) => item.hours >= task.revisitHours)
    .sort((a, b) => b.hours - a.hours);
}

export interface WatchItem {
  rival: RivalListing;
  lastAt: string;
  hours: number;
  heat: ReturnType<typeof latestHeat>;
  wants: WantsTrend;
  views: WantsTrend;
  wantsDaily: DailyCompare;
  viewsDaily: DailyCompare;
  /** 当前可安全打开商详采集。 */
  due: boolean;
  /** 这个监控间隔内已经开过商详，不管有没有读到数。 */
  triedThisInterval: boolean;
}

/** 你盯着的货。监控清单只放亲自标记的，不把搜索页一铺进来的全挤进来。 */
export function watchBoard(
  task: ResearchTask,
  rivals: RivalListing[],
  now: number,
  intervalHours?: number,
): WatchItem[] {
  const interval = clampWatchIntervalHours(intervalHours);
  return rivals
    .filter(
      (rival) =>
        rival.taskId === task.id &&
        rival.watched &&
        rival.alignment === "comparable",
    )
    .map((rival) => {
      const lastAt = lastObservedAt(rival);
      const hours = hoursSince(lastAt, now);
      const heat = latestHeat(rival);
      const eligibility = watchEligibility(rival, now, interval);
      return {
        rival,
        lastAt,
        hours,
        heat,
        wants: wantsTrend(rival),
        views: viewsTrend(rival),
        wantsDaily: dailyCompare(rival, "wants", now),
        viewsDaily: dailyCompare(rival, "views", now),
        due: eligibility.eligible,
        triedThisInterval: eligibility.reason === "retry_interval",
      };
    })
    .sort((a, b) => Number(b.due) - Number(a.due) || b.hours - a.hours);
}

/** 导航角标：有监控就只催监控的，免得搜索卡把数字撑爆。 */
export function researchDueCount(
  task: ResearchTask,
  rivals: RivalListing[],
  now: number,
  intervalHours?: number,
): number {
  const watched = watchBoard(task, rivals, now, intervalHours);
  if (watched.length > 0) return watched.filter((item) => item.due).length;
  return revisitQueue(task, rivals, now).length;
}

/** 角标点进去按这个顺序走，和任务条上的左右顺序一致。 */
export function researchDueTaskIds(
  tasks: ResearchTask[],
  rivals: RivalListing[],
  now: number,
  intervalHours?: number,
): string[] {
  return tasks
    .filter((task) => task.status === "active")
    .filter((task) => researchDueCount(task, rivals, now, intervalHours) > 0)
    .map((task) => task.id);
}

/** 已经停在某个待回访任务上就进下一个，否则从第一个开始。 */
export function nextDueTaskId(
  dueTaskIds: string[],
  currentTaskId?: string | null,
): string | undefined {
  if (dueTaskIds.length === 0) return undefined;
  const idx = currentTaskId ? dueTaskIds.indexOf(currentTaskId) : -1;
  return dueTaskIds[(idx + 1) % dueTaskIds.length];
}

export interface Evidence {
  label: string;
  url: string;
}

export interface Finding {
  id: string;
  severity: "info" | "attention";
  text: string;
  /** 每条结论都必须挂得上证据，可以点回当时那一页 */
  evidence: Evidence[];
}

/**
 * 从观察点推出结论。
 *
 * 三条硬约束：
 * 1. **没有证据就不出结论。** 可比同行不足两件时只说「样本不够」；
 * 2. **不出现观察点里没有的数字。** 和 LLM 润色不许编数字是同一条；
 * 3. **只在研究台展示，不进行动队列。** 改标题、改价格都得你亲自决定。
 */
/** 同行标题/文案里反复出现、本店没写的卖点。只认看得见的字，不编。 */
const SELLING_HOOKS = [
  "包邮",
  "当天发",
  "秒发",
  "现货",
  "顺丰",
  "验货宝",
  "支持验货",
  "可刀",
  "可小刀",
  "全新未拆",
  "未拆封",
  "保修",
  "支持退",
];

export function highlightGaps(
  listing: Listing,
  comparable: RivalListing[],
): Finding | undefined {
  if (comparable.length === 0) return undefined;
  const mine = `${listing.title} ${listing.tags.join(" ")} ${listing.copy ?? ""}`;
  const hits = SELLING_HOOKS.flatMap((hook) => {
    if (mine.includes(hook)) return [];
    const rivals = comparable.filter((rival) =>
      `${rival.title} ${rival.copy ?? ""}`.includes(hook),
    );
    return rivals.length > 0 ? [{ hook, rivals }] : [];
  }).sort((a, b) => b.rivals.length - a.rivals.length);

  if (hits.length === 0) return undefined;
  const top = hits.slice(0, 4);
  return {
    id: "highlight_gap",
    severity: "info",
    text:
      `可比同行里有这些你标题/文案没写的卖点：` +
      `${top.map((item) => `${item.hook}（${item.rivals.length} 件）`).join("、")}。`,
    evidence: top
      .flatMap((item) =>
        item.rivals.slice(0, 2).map((rival) => ({
          label: `${rival.title.slice(0, 18)} · ${item.hook}`,
          url: rival.observations.at(-1)?.pageUrl ?? rival.url,
        })),
      )
      .slice(0, 4),
  };
}

/** 「必须含」和「必须不含」不能有交集，否则标题一命中就同时是可比又是不同款。 */
export function overlappingSpecWords(task: ResearchTask): string[] {
  const exclude = new Set(task.mustExclude.map((word) => word.toLowerCase()));
  return task.mustInclude.filter((word) => exclude.has(word.toLowerCase()));
}

export function findingsFor(
  task: ResearchTask,
  rivals: RivalListing[],
  listing: Listing | undefined,
  now: number,
  searchPages = 3,
): Finding[] {
  const mine = rivals.filter((r) => r.taskId === task.id);
  const comparable = mine.filter((r) => r.alignment === "comparable");
  const findings: Finding[] = [];

  if (mine.length === 0) {
    const query = task.keyword.trim() || task.name;
    findings.push({
      id: "empty",
      severity: "info",
      text:
        `还没有采集到任何同行。在商品页点「看对手」会按标题连翻 ${searchPages} 页「${query}」；` +
        `也可以用页面底部的采集端导入搜索页（会真点 ${searchPages} 页）或商详。「运行 Agent」不会自己去搜。`,
      evidence: [],
    });
    return findings;
  }

  if (comparable.length < 2) {
    findings.push({
      id: "sample",
      severity: "info",
      text:
        `规格可比的同行只有 ${comparable.length} 件，还不够下结论。` +
        `先把「必须含 / 必须不含」调准，或者多加几件同款。`,
      evidence: [],
    });
    return findings;
  }

  const band = priceBand(mine);

  if (band.count >= 2 && listing) {
    const diff = listing.priceCents - band.medianCents;
    const ratio = diff / band.medianCents;
    const evidence = comparable
      .map((rival) => ({ rival, observation: latestPriced(rival) }))
      .filter((entry) => entry.observation)
      .slice(0, 4)
      .map(({ rival, observation }) => ({
        label: `${rival.title.slice(0, 18)} ${yuan(observation!.priceCents!)}`,
        url: observation!.pageUrl,
      }));

    if (Math.abs(ratio) >= 0.05) {
      findings.push({
        id: "price_gap",
        severity: ratio > 0 ? "attention" : "info",
        text:
          `你挂 ${yuan(listing.priceCents)}，${band.count} 件可比同行的中位价是 ` +
          `${yuan(band.medianCents)}（${yuan(band.minCents)} ~ ${yuan(band.maxCents)}），` +
          `你${ratio > 0 ? "高" : "低"}出 ${Math.abs(ratio * 100).toFixed(0)}%。`,
        evidence,
      });
    } else {
      findings.push({
        id: "price_gap",
        severity: "info",
        text:
          `你挂 ${yuan(listing.priceCents)}，和 ${band.count} 件可比同行的中位价 ` +
          `${yuan(band.medianCents)} 基本在同一水位。`,
        evidence,
      });
    }
  }

  const rising = comparable
    .map((rival) => ({ rival, trend: wantsTrend(rival) }))
    .filter((entry) => (entry.trend.delta ?? 0) > 0)
    .sort((a, b) => (b.trend.perDay ?? 0) - (a.trend.perDay ?? 0));

  if (rising.length > 0) {
    const top = rising[0];
    findings.push({
      id: "wants_momentum",
      severity:
        rising.length >= Math.ceil(comparable.length / 2)
          ? "attention"
          : "info",
      text:
        `${comparable.length} 件可比同行里有 ${rising.length} 件的「想要」在涨，` +
        `最快的是「${top.rival.title.slice(0, 18)}」：${top.trend.hours!.toFixed(0)} 小时 ` +
        `+${top.trend.delta}${top.trend.perDay ? `（约 ${top.trend.perDay.toFixed(1)}/天）` : ""}。`,
      evidence: rising.slice(0, 4).map(({ rival, trend }) => ({
        label: `${rival.title.slice(0, 18)} 想要 ${trend.previous}→${trend.latest}`,
        url: rival.observations.at(-1)?.pageUrl ?? rival.url,
      })),
    });
  } else {
    findings.push({
      id: "wants_momentum",
      severity: "info",
      text: "可比同行里还没有一件攒够两次商详观察，看不出谁在涨。去回访清单里补几次。",
      evidence: [],
    });
  }

  const freeShipping = comparable.filter(
    (rival) => latestPriced(rival)?.delivery === "free_shipping",
  );
  if (freeShipping.length > 0 && listing) {
    const mineDelivery = readDelivery(
      `${listing.title} ${listing.tags.join(" ")}`,
    );
    if (mineDelivery !== "free_shipping") {
      findings.push({
        id: "delivery_gap",
        severity: "info",
        text:
          `${comparable.length} 件可比同行里有 ${freeShipping.length} 件写了包邮，` +
          `你的商品页上没看到包邮字样 —— 同一价位下这会影响转化。`,
        evidence: freeShipping.slice(0, 4).map((rival) => ({
          label: `${rival.title.slice(0, 18)} 包邮`,
          url: latestPriced(rival)?.pageUrl ?? rival.url,
        })),
      });
    }
  }

  const highlights = listing ? highlightGaps(listing, comparable) : undefined;
  if (highlights) findings.push(highlights);

  const due = revisitQueue(task, mine, now);
  if (due.length > 0) {
    findings.push({
      id: "revisit",
      severity: "info",
      text:
        `有 ${due.length} 件同行超过 ${task.revisitHours} 小时没观察了，` +
        `时间线的密度等于你回访的密度。`,
      evidence: due.slice(0, 4).map((item) => ({
        label: `${item.rival.title.slice(0, 18)}（${item.hours.toFixed(0)} 小时前）`,
        url: item.rival.url,
      })),
    });
  }

  return findings;
}
