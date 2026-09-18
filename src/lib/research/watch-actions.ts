"use server";

import type { ActionResponse } from "@/lib/action-kit";
import { revalidateAll } from "@/lib/action-kit";
import {
  MAX_WATCH_INTERVAL_HOURS,
  MIN_WATCH_INTERVAL_HOURS,
  clampWatchIntervalHours,
  latestDetailHeat,
} from "@/lib/research/heat";
import {
  watchBlockMessage,
  watchCapacity,
  watchEligibility,
} from "@/lib/research/monitoring";
import { runRivalDetailPull } from "@/lib/research/pull";
import { getState, mutateState } from "@/lib/store";

function watchedCount(state: Awaited<ReturnType<typeof getState>>, exceptId?: string): number {
  return state.research.rivals.filter(
    (rival) => rival.watched && rival.id !== exceptId,
  ).length;
}

function capacityMessage(minimumIntervalHours: number): string {
  return `当前监控数量受每日安全预算限制，间隔至少要设为 ${minimumIntervalHours} 小时。`;
}

/** 更新全局监控的目标间隔；过短会在保存前被安全容量校验拦住。 */
export async function updateWatchInterval(hours: number): Promise<ActionResponse> {
  const raw = Number(hours);
  if (
    !Number.isInteger(raw) ||
    raw < MIN_WATCH_INTERVAL_HOURS ||
    raw > MAX_WATCH_INTERVAL_HOURS
  ) {
    return {
      ok: false,
      message: `监控间隔请填 ${MIN_WATCH_INTERVAL_HOURS}～${MAX_WATCH_INTERVAL_HOURS} 之间的整小时。`,
    };
  }

  const intervalHours = clampWatchIntervalHours(raw);
  const response = await mutateState((state) => {
    const capacity = watchCapacity(watchedCount(state), intervalHours);
    if (!capacity.withinBudget) {
      return { ok: false, message: capacityMessage(capacity.minimumIntervalHours) };
    }
    state.research.watchIntervalHours = intervalHours;
    return {
      ok: true,
      message: `已设为每 ${intervalHours} 小时采一次监控中的商品（目标间隔）。`,
    };
  });
  revalidateAll();
  return response;
}

/** 盯住或放开一件同行；新增监控同样先过容量校验。 */
export async function setRivalWatched(
  rivalId: string,
  watched: boolean,
): Promise<ActionResponse> {
  const now = Date.now();
  const marked = await mutateState((state) => {
    const rival = state.research.rivals.find((item) => item.id === rivalId);
    if (!rival) return { ok: false, message: "找不到这件同行商品。" };

    const intervalHours = clampWatchIntervalHours(state.research.watchIntervalHours);
    if (watched && !rival.watched) {
      const capacity = watchCapacity(watchedCount(state, rivalId) + 1, intervalHours);
      if (!capacity.withinBudget) {
        return { ok: false, message: capacityMessage(capacity.minimumIntervalHours) };
      }
    }

    rival.watched = watched;
    rival.watchedAt = watched ? new Date(now).toISOString() : undefined;
    return {
      ok: true,
      message: watched
        ? `已盯住「${rival.title.slice(0, 18)}」，接下来只看它的想要和浏览。`
        : `已取消监控「${rival.title.slice(0, 18)}」。`,
    };
  });
  revalidateAll();
  if (!marked.ok || !watched) return marked;

  const state = await getState();
  const rival = state.research.rivals.find((item) => item.id === rivalId);
  if (!rival) return marked;
  const eligibility = watchEligibility(rival, now, state.research.watchIntervalHours);
  if (!eligibility.eligible) {
    const heat = latestDetailHeat(rival);
    return {
      ok: true,
      message: `${marked.message}${watchBlockMessage(eligibility)}（想要 ${heat.wants ?? "—"} / 浏览 ${heat.views ?? "—"}）`,
    };
  }
  return {
    ok: true,
    message: `${marked.message}想要和浏览会在下一轮后台监控中补上（目标每 ${eligibility.intervalHours} 小时）。`,
  };
}

/** 手动采集和后台队列共用监控资格，失败后不会绕过本间隔退避。 */
export async function fetchRivalCopy(rivalId: string): Promise<ActionResponse> {
  const state = await getState();
  const rival = state.research.rivals.find((item) => item.id === rivalId);
  if (!rival) return { ok: false, message: "找不到这件同行商品。" };

  if (rival.watched) {
    const eligibility = watchEligibility(rival, Date.now(), state.research.watchIntervalHours);
    if (!eligibility.eligible) return { ok: true, message: watchBlockMessage(eligibility) };
  }

  const result = await runRivalDetailPull(
    rivalId,
    rival.watched ? state.research.watchIntervalHours : undefined,
  );
  revalidateAll();
  return { ok: result.ok, message: result.message };
}
