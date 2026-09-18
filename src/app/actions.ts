/**
 * 页面只从这里引进 Server Action。实现按模块散开，各文件自己标 `"use server"`：
 * - 巡检 / 队列 / 店铺：`src/lib/agent/actions.ts`
 * - 通道 / 登录 / 同步：`src/lib/adapters/actions.ts`
 * - 选品研究：`src/lib/research/actions.ts`
 *
 * 本文件不能再写 `"use server"` —— Next 不允许在这类文件里 `export { fn } from`。
 */
export type {
  ActionResponse,
  LiveChannelStatus,
  LoginOrigin,
  LoginStateView,
} from "@/lib/action-kit";

export {
  approveActionWithEdits,
  clearDemo,
  clearImportedLlmConfig,
  confirmFloorPrice,
  decideAction,
  decideAllPending,
  delistListing,
  draftReplyFor,
  importLlmConfig,
  listLlmModels,
  llmConfigView,
  refreshListing,
  resetDemoData,
  retryFailedAction,
  runAgentTick,
  sendReply,
  setAutoTick,
  setRuleApproval,
  setRuleEnabled,
  shipOrder,
  updateListingPrice,
  updateRuleParam,
  updateSettings,
  verifyLlmConfig,
} from "@/lib/agent/actions";

export {
  clearImportedLoginState,
  importLoginState,
  liveChannelStatus,
  loginStateView,
  setWritesPaused,
  syncFromPlatform,
  updateChannel,
  verifyImportedLoginState,
} from "@/lib/adapters/actions";

export {
  analyzeListingCompetition,
  askResearchQuestion,
  createResearchTask,
  deleteResearchTask,
  draftResearchTaskRules,
  fillMissingRivalHeat,
  importPageSnapshot,
  polishRivalCopy,
  regenerateCollectorToken,
  removeRival,
  scoutListingCompetition,
  setRivalAlignment,
  updateResearchTask,
  updateSearchPages,
} from "@/lib/research/actions";

export {
  fetchRivalCopy,
  setRivalWatched,
  updateWatchInterval,
} from "@/lib/research/watch-actions";
