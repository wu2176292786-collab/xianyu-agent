import { mockAdapter } from "@/lib/adapters/mock";
import type { AppState, TickTrigger } from "@/lib/domain/types";
import { logActivity } from "@/lib/store";
import { runTick } from "./engine";

export interface TickSummary {
  queued: number;
  applied: number;
  failed: number;
  /** 给人看的一句话结论 */
  message: string;
}

/**
 * 跑一轮巡检并把结果写进动态。手动点按钮和后台定时器走的是同一条路径，
 * 保证两种触发方式的行为完全一致。
 */
export function performTick(
  state: AppState,
  now: number,
  trigger: TickTrigger,
): TickSummary {
  const result = runTick(state, mockAdapter, now, trigger);
  const prefix = trigger === "scheduled" ? "自动巡检：" : "";

  for (const message of result.messages) {
    logActivity(state, "agent", message, now);
  }
  for (const action of result.failed) {
    logActivity(
      state,
      "system",
      `${prefix}执行失败 —— ${action.title}：${action.failureReason ?? "未知原因"}`,
      now,
    );
  }
  if (result.queued.length > 0) {
    logActivity(
      state,
      "agent",
      `${prefix}生成 ${result.queued.length} 条待审批建议，等待你确认。`,
      now,
    );
  }
  if (result.queued.length === 0 && result.applied.length === 0 && result.failed.length === 0) {
    logActivity(state, "agent", `${prefix}跑了一轮，当前没有需要处理的事情。`, now);
  }

  const parts: string[] = [];
  if (result.applied.length > 0) parts.push(`自动执行 ${result.applied.length} 项`);
  if (result.queued.length > 0) parts.push(`${result.queued.length} 项待你审批`);
  if (result.failed.length > 0) parts.push(`${result.failed.length} 项执行失败`);

  return {
    queued: result.queued.length,
    applied: result.applied.length,
    failed: result.failed.length,
    message:
      parts.length === 0
        ? "Agent 跑完了，暂时没有新建议。"
        : `Agent ${parts.join("，")}。`,
  };
}
