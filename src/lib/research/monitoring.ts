import type { RivalListing } from "@/lib/domain/types";
import {
  DEFAULT_WATCH_INTERVAL_HOURS,
  clampWatchIntervalHours,
  lastDetailObservedAt,
  needsWatchPull,
  triedWatchThisInterval,
} from "./heat";

/** 风控预算：监控任务每天最多实际打开 60 个商详。 */
export const WATCH_DAILY_DETAIL_BUDGET = 60;
export const WATCH_BATCH_LIMIT = 6;
export const WATCH_BATCH_GAP_MS = 30 * 60 * 1000;

export type WatchBlockReason =
  | "not_watched"
  | "not_comparable"
  | "success_interval"
  | "retry_interval";

export interface WatchEligibility {
  eligible: boolean;
  intervalHours: number;
  reason?: WatchBlockReason;
  nextEligibleAt?: string;
}

function afterHours(at: string | undefined, hours: number): string | undefined {
  if (!at) return undefined;
  const parsed = Date.parse(at);
  return Number.isFinite(parsed)
    ? new Date(parsed + hours * 3_600_000).toISOString()
    : undefined;
}

/**
 * 监控资格的唯一判定。
 *
 * 自动队列、手动点击和界面状态必须共用它：失败后在同一监控间隔内不再开页，
 * 成功后也按同一节奏等待，避免三条路径各自解释“到期”。
 */
export function watchEligibility(
  rival: RivalListing,
  now: number,
  requestedIntervalHours: number | undefined = DEFAULT_WATCH_INTERVAL_HOURS,
): WatchEligibility {
  const intervalHours = clampWatchIntervalHours(requestedIntervalHours);
  if (!rival.watched) {
    return { eligible: false, intervalHours, reason: "not_watched" };
  }
  if (rival.alignment !== "comparable") {
    return { eligible: false, intervalHours, reason: "not_comparable" };
  }
  if (triedWatchThisInterval(rival, now, intervalHours)) {
    return {
      eligible: false,
      intervalHours,
      reason: "retry_interval",
      nextEligibleAt: afterHours(rival.lastDetailTryAt, intervalHours),
    };
  }
  if (!needsWatchPull(rival, now, intervalHours)) {
    return {
      eligible: false,
      intervalHours,
      reason: "success_interval",
      nextEligibleAt: afterHours(lastDetailObservedAt(rival), intervalHours),
    };
  }
  return { eligible: true, intervalHours };
}

/** 已到期的监控货按最久未采排前面。 */
export function watchPullQueue(
  rivals: RivalListing[],
  now: number,
  intervalHours?: number,
): RivalListing[] {
  return rivals
    .filter((rival) => watchEligibility(rival, now, intervalHours).eligible)
    .sort((left, right) => {
      const leftAt = lastDetailObservedAt(left);
      const rightAt = lastDetailObservedAt(right);
      return (leftAt ? Date.parse(leftAt) : 0) - (rightAt ? Date.parse(rightAt) : 0);
    });
}

export interface WatchCapacity {
  watchedCount: number;
  intervalHours: number;
  minimumIntervalHours: number;
  withinBudget: boolean;
}

/**
 * 在“不暂停、应用持续运行”的正常条件下，安全预算可承载的最短目标间隔。
 * 它不是准点保证：风控暂停、浏览器不可用都会让本轮延后。
 */
export function watchCapacity(
  watchedCount: number,
  requestedIntervalHours: number | undefined,
): WatchCapacity {
  const intervalHours = clampWatchIntervalHours(requestedIntervalHours);
  const minimumIntervalHours = Math.max(
    1,
    Math.ceil((Math.max(0, watchedCount) * 24) / WATCH_DAILY_DETAIL_BUDGET),
  );
  return {
    watchedCount,
    intervalHours,
    minimumIntervalHours,
    withinBudget: intervalHours >= minimumIntervalHours,
  };
}

export function watchBlockMessage(eligibility: WatchEligibility): string {
  if (eligibility.reason === "retry_interval") {
    return `本间隔内已经尝试过，${eligibility.nextEligibleAt ? "到下次监控时间后" : "稍后"}再试。`;
  }
  if (eligibility.reason === "success_interval") {
    return `距上次采集还没到 ${eligibility.intervalHours} 小时，不再打开这一页。`;
  }
  return "这件商品当前不在可采集的监控范围内。";
}
