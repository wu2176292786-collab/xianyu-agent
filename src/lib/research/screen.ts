import type { AppState, ResearchTask, RivalListing } from "@/lib/domain/types";
import { alignmentFor } from "./record";

/** 同行商品页只展示规格可比的货。 */
export function visibleRivals(rivals: RivalListing[]): RivalListing[] {
  return rivals.filter((rival) => rival.alignment === "comparable");
}

export function parseScreenKeepIds(
  raw: string,
  allowed: Iterable<string>,
): { keepIds: string[]; parsed: boolean } {
  const allowedSet = new Set(allowed);
  const text = raw
    .replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, "")
    .trim();
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return { keepIds: [], parsed: false };

  try {
    const parsed: unknown = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return { keepIds: [], parsed: false };

    const keepIds: string[] = [];
    for (const row of parsed) {
      if (!row || typeof row !== "object") continue;
      const record = row as { itemId?: unknown; keep?: unknown };
      const id = typeof record.itemId === "string" ? record.itemId.trim() : "";
      if (record.keep === true && allowedSet.has(id) && !keepIds.includes(id)) {
        keepIds.push(id);
      }
    }
    return { keepIds, parsed: true };
  } catch {
    return { keepIds: [], parsed: false };
  }
}

/** 没模型时的兜底：只留规则判成可比的。 */
export function ruleKeepItemIds(task: ResearchTask, rivals: RivalListing[]): string[] {
  return rivals
    .filter(
      (rival) =>
        rival.taskId === task.id && alignmentFor(task, rival.title) === "comparable",
    )
    .map((rival) => rival.itemId);
}

/** 空的保留集不能触发删除；它不足以证明所有候选都该被丢弃。 */
export function canApplyScreenResult(keepIds: Iterable<string>): boolean {
  return !keepIds[Symbol.iterator]().next().done;
}

export function applyKeepItemIds(
  state: AppState,
  taskId: string,
  keepIds: Iterable<string>,
): { kept: number; dropped: number } {
  const keep = new Set(keepIds);
  const before = state.research.rivals.filter((rival) => rival.taskId === taskId);
  state.research.rivals = state.research.rivals.filter((rival) => {
    if (rival.taskId !== taskId) return true;
    if (rival.alignmentBy === "human" && rival.alignment === "comparable") {
      return true;
    }
    if (keep.has(rival.itemId)) {
      rival.alignment = "comparable";
      if (rival.alignmentBy !== "human") rival.alignmentBy = "auto";
      return true;
    }
    return false;
  });
  const kept = state.research.rivals.filter((rival) => rival.taskId === taskId).length;
  return { kept, dropped: before.length - kept };
}

/** 不同款、存疑不进同行页，直接拿掉。人手标成可比的留下。 */
export function pruneHiddenRivals(
  state: AppState,
  taskId: string,
): { kept: number; dropped: number } {
  const before = state.research.rivals.filter((rival) => rival.taskId === taskId);
  state.research.rivals = state.research.rivals.filter((rival) => {
    if (rival.taskId !== taskId) return true;
    return rival.alignment === "comparable";
  });
  const kept = state.research.rivals.filter((rival) => rival.taskId === taskId).length;
  return { kept, dropped: before.length - kept };
}

export function describeScreen(result: { kept: number; dropped: number }): string {
  if (result.dropped === 0) {
    return result.kept > 0
      ? `留下 ${result.kept} 件同类。`
      : "没留下同类，同行列表是空的。";
  }
  return `留下 ${result.kept} 件同类，去掉 ${result.dropped} 件不同款或存疑。`;
}
