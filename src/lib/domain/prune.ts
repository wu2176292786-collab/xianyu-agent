import { MAX_ACTIONS, MAX_ACTIVITY, MAX_RUNS } from "@/lib/domain/limits";
import type { AppState } from "@/lib/domain/types";
import { pruneResearch } from "@/lib/research/record";

/** 把会无限增长的数组裁回上限。就地改，下次落盘文件也会瘦下来。 */
export function pruneState(state: AppState): void {
  state.runs = (state.runs ?? []).slice(0, MAX_RUNS);
  state.activity = (state.activity ?? []).slice(0, MAX_ACTIVITY);
  state.actions = (state.actions ?? []).slice(0, MAX_ACTIONS);
  pruneResearch(state);
}
