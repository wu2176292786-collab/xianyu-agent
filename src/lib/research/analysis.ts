import type {
  Listing,
  ResearchTask,
  RivalListing,
  RivalObservation,
} from "@/lib/domain/types";
import { hoursSince, yuan } from "@/lib/format";
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

function detailWants(rival: RivalListing): RivalObservation[] {
  return rival.observations
    .filter((o) => o.source === "detail" && o.wants !== undefined)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export function wantsTrend(rival: RivalListing): WantsTrend {
  const points = detailWants(rival);
  if (points.length === 0) {
    return { note: "还没有一次商详观察抽到「想要」。" };
  }

  const latest = points.at(-1)!;
  if (points.length === 1) {
    return {
      latest: latest.wants,
      latestAt: latest.at,
      note: "只有一次观察，再回访一次才能看出变化。",
    };
  }

  const previous = points.at(-2)!;
  const hours = (Date.parse(latest.at) - Date.parse(previous.at)) / 3_600_000;
  const delta = latest.wants! - previous.wants!;

  return {
    latest: latest.wants,
    latestAt: latest.at,
    previous: previous.wants,
    previousAt: previous.at,
    delta,
    hours,
    // 间隔太短的话日均增速会被放得很夸张，索引不算
    perDay: hours >= 1 ? (delta / hours) * 24 : undefined,
  };
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
export function findingsFor(
  task: ResearchTask,
  rivals: RivalListing[],
  listing: Listing | undefined,
  now: number,
): Finding[] {
  const mine = rivals.filter((r) => r.taskId === task.id);
  const comparable = mine.filter((r) => r.alignment === "comparable");
  const findings: Finding[] = [];

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
