import { screenRivalCandidates } from "@/lib/agent/llm";
import { getState, logActivity, mutateState } from "@/lib/store";
import {
  applyKeepItemIds,
  canApplyScreenResult,
  describeScreen,
  ruleKeepItemIds,
} from "./screen";
import { displayImageUrls } from "./snapshot";

/**
 * 入库之后用模型筛一遍：不同款和存疑不进同行商品页。
 * 没模型或解析失败时按规则兜底。
 */
export async function screenAndPruneRivals(
  taskId: string,
): Promise<{ message: string }> {
  const state = await getState();
  const task = state.research.tasks.find((item) => item.id === taskId);
  if (!task) return { message: "" };

  const listing = state.listings.find((item) => item.id === task.linkedListingId);
  const candidates = state.research.rivals
    .filter((rival) => rival.taskId === taskId)
    .map((rival) => ({
      itemId: rival.itemId,
      title: rival.title,
      copy: rival.copy,
      imageUrl: displayImageUrls(rival.imageUrls)[0],
    }));
  if (candidates.length === 0) return { message: "" };

  const screened = listing
    ? await screenRivalCandidates(
        { title: listing.title, copy: listing.copy },
        candidates,
      )
    : { keepIds: [] as string[], parsed: false, fallback: undefined as string | undefined };

  const keepIds = screened.parsed
    ? screened.keepIds
    : ruleKeepItemIds(task, state.research.rivals);

  // 空名单没有足够信息证明“全都是不同款”。模型偶发误判或规则过严时，
  // 直接删除全部候选无法恢复；保留给人看比猜错后静默丢数据安全。
  if (!canApplyScreenResult(keepIds)) {
    const via = screened.parsed ? "模型没有确认可比候选" : "规则没有确认可比候选";
    return {
      message: `${via}，已保留 ${candidates.length} 件供人工检查。`,
    };
  }

  const applied = await mutateState((next) => {
    const result = applyKeepItemIds(next, taskId, keepIds);
    if (result.dropped > 0) {
      logActivity(next, "agent", `「${task.name}」${describeScreen(result)}`, Date.now());
    }
    return result;
  });

  const via = screened.parsed ? "模型筛过：" : "模型没筛成，已按规则筛：";
  const note = screened.parsed ? "" : screened.fallback ?? "";
  return {
    message: [via + describeScreen(applied), note].filter(Boolean).join(" "),
  };
}
