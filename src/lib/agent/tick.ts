import { writeChannelFor } from "@/lib/adapters";
import type { AppState, TickTrigger } from "@/lib/domain/types";
import { logActivity } from "@/lib/store";
import { applyProposals } from "./engine";
import { collectProposals } from "./pi/runtime";

export interface TickSummary {
  queued: number;
  applied: number;
  failed: number;
  /** 因为急停或限流没做、下一轮会重提的 */
  skipped: number;
  /** 给人看的一句话结论 */
  message: string;
}

/**
 * 跑一轮巡检并把结果写进动态。手动点按钮和后台定时器走的是同一条路径，
 * 保证两种触发方式的行为完全一致。
 */
export async function performTick(
  state: AppState,
  now: number,
  trigger: TickTrigger,
): Promise<TickSummary> {
  const proposals = await collectProposals(state, now);
  const result = await applyProposals(state, proposals, writeChannelFor(state), now, trigger);
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
  if (result.skipped > 0) {
    logActivity(
      state,
      "system",
      `${prefix}有 ${result.skipped} 项这一轮没做：${result.skipReason ?? "写操作被拦下"}。下一轮会重新提出来。`,
      now,
    );
  }
  if (
    result.queued.length === 0 &&
    result.applied.length === 0 &&
    result.failed.length === 0 &&
    result.skipped === 0
  ) {
    logActivity(state, "agent", `${prefix}跑了一轮，当前没有需要处理的事情。`, now);
  }

  const dryRun = state.channel.write === "dry_run";
  const parts: string[] = [];
  if (result.applied.length > 0) {
    parts.push(`${dryRun ? "演练执行" : "自动执行"} ${result.applied.length} 项`);
  }
  if (result.queued.length > 0) parts.push(`${result.queued.length} 项待你审批`);
  if (result.failed.length > 0) parts.push(`${result.failed.length} 项执行失败`);
  if (result.skipped > 0) parts.push(`${result.skipped} 项被拦下`);

  return {
    queued: result.queued.length,
    applied: result.applied.length,
    failed: result.failed.length,
    skipped: result.skipped,
    message:
      parts.length === 0
        ? "Agent 跑完了，暂时没有新建议。"
        : `Agent ${parts.join("，")}。`,
  };
}
