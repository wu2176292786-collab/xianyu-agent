import type { RivalListing, RivalObservation } from "@/lib/domain/types";
import { hoursSince, previousShopDay, shopDay } from "@/lib/format";

export const DEFAULT_WATCH_INTERVAL_HOURS = 24;
export const MIN_WATCH_INTERVAL_HOURS = 1;
export const MAX_WATCH_INTERVAL_HOURS = 168;

export function clampWatchIntervalHours(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_WATCH_INTERVAL_HOURS;
  return Math.min(
    MAX_WATCH_INTERVAL_HOURS,
    Math.max(MIN_WATCH_INTERVAL_HOURS, Math.round(n)),
  );
}

function presentCount(value: number | undefined): number | undefined {
  return value !== undefined && value > 0 ? value : undefined;
}

function detailOnDay(
  rival: RivalListing,
  field: "wants" | "views",
  day: string,
): RivalObservation | undefined {
  return rival.observations
    .filter(
      (observation) =>
        observation.source === "detail" &&
        shopDay(observation.at) === day &&
        presentCount(observation[field]) !== undefined,
    )
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .at(-1);
}

/** 最近一次打开商详的观察，不要求恰好抽到了热度数字。 */
export function lastDetailObservedAt(rival: RivalListing): string | undefined {
  return rival.observations
    .filter((observation) => observation.source === "detail")
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .at(-1)?.at;
}

/** 最近一次商详热度，不管是哪一天。 */
export function latestDetailHeat(rival: RivalListing): {
  wants?: number;
  views?: number;
  at?: string;
} {
  const last = rival.observations
    .filter(
      (observation) =>
        observation.source === "detail" &&
        (presentCount(observation.wants) !== undefined ||
          presentCount(observation.views) !== undefined),
    )
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .at(-1);
  if (!last) return {};
  return {
    wants: presentCount(last.wants),
    views: presentCount(last.views),
    at: last.at,
  };
}

/** 今天（北京时间）已经有商详热度。仅用于按天展示，不决定监控是否到期。 */
export function hasTodayDetailHeat(rival: RivalListing, now: number): boolean {
  const day = shopDay(now);
  return (
    presentCount(detailOnDay(rival, "wants", day)?.wants) !== undefined ||
    presentCount(detailOnDay(rival, "views", day)?.views) !== undefined
  );
}

/** 可比的货离上次商详已经超过监控间隔，就该再采一次。没采过的也算。 */
export function needsWatchPull(
  rival: RivalListing,
  now: number,
  intervalHours: number = DEFAULT_WATCH_INTERVAL_HOURS,
): boolean {
  if (rival.alignment !== "comparable") return false;
  const last = lastDetailObservedAt(rival);
  if (!last) return true;
  return hoursSince(last, now) >= clampWatchIntervalHours(intervalHours);
}

/** 今天（北京时间）已经试过开商详。日预算仍按这个口径统计。 */
export function triedDetailToday(rival: RivalListing, now: number): boolean {
  return rival.lastDetailTryAt !== undefined &&
    shopDay(rival.lastDetailTryAt) === shopDay(now);
}

/** 这个监控间隔里已经试过，先别再打开。失败的货否则会把每一轮名额吃光。 */
export function triedWatchThisInterval(
  rival: RivalListing,
  now: number,
  intervalHours: number = DEFAULT_WATCH_INTERVAL_HOURS,
): boolean {
  if (!rival.lastDetailTryAt) return false;
  return hoursSince(rival.lastDetailTryAt, now) < clampWatchIntervalHours(intervalHours);
}

/**
 * 今天还能开几件商详。
 *
 * 盯一家两百件的店时，「全都要每天更新」意味着浏览器一整天不停在开页，
 * 这个量级本身就是风险。给一天设个预算，队列按最久没采排，
 * 大店就摊到几天里轮着覆盖，而不是一天打完。
 */
export function detailBudgetLeft(
  rivals: RivalListing[],
  now: number,
  dailyBudget: number,
): number {
  const used = rivals.filter((rival) => triedDetailToday(rival, now)).length;
  return Math.max(0, dailyBudget - used);
}


/**
 * 搜索导入只记下了列表卡。浏览量在商品详情页，
 * 还没打开过商详的，需要按链接补一次。
 */
export function needsHeatFill(rival: RivalListing): boolean {
  return !rival.observations.some(
    (observation) =>
      observation.source === "detail" &&
      (presentCount(observation.wants) !== undefined ||
        presentCount(observation.views) !== undefined),
  );
}

/**
 * 撞风控之后的暂停还算不算数。
 *
 * 时间到了自然解除；没到但用户重新导了一份登录态，也解除 ——
 * 换登录态本身就是一次人工干预，多半已经把滑块过了，没必要再干等。
 */
export function heatPauseHolds(
  pause: { pauseUntil?: string; pauseLoginStamp?: string } | undefined,
  now: number,
  loginStamp?: string,
): boolean {
  const until = pause?.pauseUntil ? Date.parse(pause.pauseUntil) : Number.NaN;
  if (!Number.isFinite(until) || now >= until) return false;
  if (pause?.pauseLoginStamp && loginStamp && pause.pauseLoginStamp !== loginStamp) {
    return false;
  }
  return true;
}

/**
 * 距离上一轮够久了没有。
 *
 * 后台调度每 30 秒来问一次，但开浏览器是重活，不能来一次开一次。
 */
export function heatRunDue(
  pull: { lastAttemptAt?: string } | undefined,
  now: number,
  minGapMs: number,
): boolean {
  const last = pull?.lastAttemptAt ? Date.parse(pull.lastAttemptAt) : Number.NaN;
  if (!Number.isFinite(last)) return true;
  return now - last >= minGapMs;
}

export interface DailyCompare {
  today?: number;
  yesterday?: number;
  /** 今天之前最近一次商详，昨天缺数时才填。不冒充昨天。 */
  previous?: number;
  previousDay?: string;
  delta?: number;
  note?: string;
}

function lastDetailBeforeDay(
  rival: RivalListing,
  field: "wants" | "views",
  day: string,
): { day: string; value: number } | undefined {
  const last = rival.observations
    .filter(
      (observation) =>
        observation.source === "detail" &&
        shopDay(observation.at) < day &&
        presentCount(observation[field]) !== undefined,
    )
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .at(-1);
  if (!last) return undefined;
  const value = presentCount(last[field]);
  if (value === undefined) return undefined;
  return { day: shopDay(last.at), value };
}

/**
 * 按北京时间对比「今天最后一次」和「昨天最后一次」。
 * 昨天缺数时，用更早的一次商详做「较上次」，并写明那天的日期，不把它写成昨天。
 */
export function dailyCompare(
  rival: RivalListing,
  field: "wants" | "views",
  now: number,
): DailyCompare {
  const today = shopDay(now);
  const yesterday = previousShopDay(today);
  const todayHit = detailOnDay(rival, field, today);
  const yesterdayHit = detailOnDay(rival, field, yesterday);
  const todayValue = presentCount(todayHit?.[field]);
  const yesterdayValue = presentCount(yesterdayHit?.[field]);

  if (todayValue === undefined && yesterdayValue === undefined) {
    return { note: "还没有按天采到这个数。" };
  }
  if (todayValue === undefined) {
    return { yesterday: yesterdayValue, note: "今天还没采到。" };
  }
  if (yesterdayValue === undefined) {
    const prior = lastDetailBeforeDay(rival, field, today);
    if (!prior) return { today: todayValue, note: "昨天没采到，还比不了。" };
    return {
      today: todayValue,
      previous: prior.value,
      previousDay: prior.day,
      delta: todayValue - prior.value,
      note: "昨天没采到",
    };
  }
  return {
    today: todayValue,
    yesterday: yesterdayValue,
    delta: todayValue - yesterdayValue,
  };
}
