import type {
  Alignment,
  AppState,
  ResearchTask,
  RivalListing,
  RivalObservation,
} from "@/lib/domain/types";
import type { ParsedItem, ParseResult } from "./snapshot";

/**
 * 同一 itemId、同一来源，这个窗口内的重复观察只留一条。
 *
 * 刷新一下页面不该在时间线上变成一次「波动」。
 */
export const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

export interface RecordSummary {
  /** 新加入研究的同行商品数 */
  added: number;
  /** 追加的观察数 */
  observed: number;
  /** 被短时去重合并掉的观察数 */
  deduped: number;
  /** 解析阶段认不出 itemId 的记录数 */
  skipped: number;
  /** 抽不到「想要」的观察数。如实显示，不当成 0。 */
  missingWants: number;
}

function newId(prefix: string, now: number, salt: number): string {
  return `${prefix}${now.toString(36)}${salt.toString(36)}`;
}

/**
 * 规格对齐判定。不看图，只看标题里的关键词。
 *
 * 命中任一「必须不含」→ 不同款；命中全部「必须含」→ 可比；其余一律存疑。
 * 拿不准就是存疑，而且只有「可比」的同行会进价格带 ——
 * 拿日版当国行比，比不比更糟。
 */
export function alignmentFor(
  task: ResearchTask,
  title: string | undefined,
): Alignment {
  if (!title) return "uncertain";
  const haystack = title.toLowerCase();
  const hit = (word: string) => haystack.includes(word.trim().toLowerCase());

  if (task.mustExclude.some((word) => word.trim() && hit(word)))
    return "different";
  const required = task.mustInclude.filter((word) => word.trim());
  if (required.length > 0 && required.every(hit)) return "comparable";
  return "uncertain";
}

/** 抽到了几个字段。短时去重时留下更完整的那条。 */
function resolvedFields(item: ParsedItem | RivalObservation): number {
  let score = 0;
  if (item.wants !== undefined) score += 1;
  if (item.priceCents !== undefined) score += 1;
  if (item.delivery !== "unknown") score += 1;
  return score;
}

function toObservation(item: ParsedItem, id: string): RivalObservation {
  return {
    id,
    at: item.at,
    source: item.source,
    wants: item.wants,
    wantsFrom: item.wantsFrom,
    priceCents: item.priceCents,
    priceFrom: item.priceFrom,
    delivery: item.delivery,
    pageUrl: item.pageUrl,
    excerpt: item.excerpt,
    missing: item.missing,
  };
}

/**
 * 把一份解析好的快照记进研究任务。
 *
 * 两条规则不会变：
 * 1. **只追加，不覆盖。** 这一版的全部价值就是历史差值，覆盖等于把历史抹掉；
 * 2. **缺失不当 0。** 抽不到「想要」就留空 —— 记成 0 的话，下一次读到 86
 *    就会显示「涨了 86」。
 */
export function recordObservations(
  state: AppState,
  taskId: string,
  parsed: ParseResult,
  now: number,
): RecordSummary {
  const summary: RecordSummary = {
    added: 0,
    observed: 0,
    deduped: 0,
    skipped: parsed.skipped,
    missingWants: 0,
  };

  const task = state.research.tasks.find((t) => t.id === taskId);
  if (!task) return summary;

  parsed.items.forEach((item, index) => {
    if (item.wants === undefined) summary.missingWants += 1;

    let rival = state.research.rivals.find(
      (r) => r.taskId === taskId && r.itemId === item.itemId,
    );

    if (!rival) {
      rival = {
        id: newId("RV", now, index),
        taskId,
        itemId: item.itemId,
        title: item.title ?? `商品 ${item.itemId}`,
        sellerName: item.sellerName,
        url: item.url,
        addedAt: item.at,
        alignment: alignmentFor(task, item.title),
        alignmentBy: "auto",
        observations: [],
      };
      state.research.rivals.push(rival);
      summary.added += 1;
    } else {
      // 标题和卖家会改，跟着更新；itemId 是主键，不动
      if (item.title) rival.title = item.title;
      if (item.sellerName) rival.sellerName = item.sellerName;
      rival.url = item.url;
      // 自动判定不覆盖人工判定 —— 人看过的结论比关键词可靠
      if (rival.alignmentBy === "auto") {
        rival.alignment = alignmentFor(task, rival.title);
      }
    }

    const observation = toObservation(item, newId("OB", now, index));
    const at = Date.parse(observation.at);
    const twin = rival.observations.find(
      (existing) =>
        existing.source === observation.source &&
        Math.abs(Date.parse(existing.at) - at) < DEDUPE_WINDOW_MS,
    );

    if (twin) {
      summary.deduped += 1;
      // 留下字段更完整的那条：刷新有可能刚好补上缺的「想要」
      if (resolvedFields(observation) > resolvedFields(twin)) {
        Object.assign(twin, observation, { id: twin.id });
      }
      return;
    }

    rival.observations.push(observation);
    rival.observations.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    summary.observed += 1;
  });

  return summary;
}

export function describeRecord(summary: RecordSummary): string {
  const parts: string[] = [];
  if (summary.added > 0) parts.push(`新增 ${summary.added} 件同行商品`);
  if (summary.observed > 0) parts.push(`记录 ${summary.observed} 条观察`);
  if (summary.deduped > 0) parts.push(`${summary.deduped} 条短时重复已合并`);
  if (summary.skipped > 0)
    parts.push(`${summary.skipped} 条认不出 itemId 已跳过`);
  if (summary.missingWants > 0)
    parts.push(`${summary.missingWants} 条没抽到「想要」`);
  return parts.length > 0 ? parts.join("，") : "没有可记录的内容";
}

/** 时间线上最近一次观察的时间，没有观察就回退到加入时间。 */
export function lastObservedAt(rival: RivalListing): string {
  return rival.observations.at(-1)?.at ?? rival.addedAt;
}
