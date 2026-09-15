"use server";

import { revalidatePath } from "next/cache";
import { readerFor, writeChannel } from "@/lib/adapters";
import {
  type CredentialStatus,
  credentialStatus,
} from "@/lib/adapters/live/credentials";
import { LiveChannelError, endpointConfig } from "@/lib/adapters/live/reader";
import {
  WRITE_MODE_LABEL,
  pauseWrites,
  resumeWrites,
} from "@/lib/adapters/guard";
import {
  applyAction,
  applyActionWithEdits,
  retryAction,
  type ActionEdits,
} from "@/lib/agent/engine";
import { describeMerge, mergeSnapshot } from "@/lib/agent/sync";
import { performTick } from "@/lib/agent/tick";
import { polishReply } from "@/lib/agent/llm";
import { INTENT_LABEL, draftReply } from "@/lib/agent/reply";
import { newCollectorToken } from "@/lib/research/collector";
import { alignmentFor, describeRecord, recordObservations } from "@/lib/research/record";
import { parsePageSnapshot } from "@/lib/research/snapshot";
import {
  ALIGNMENT_LABEL,
  type Alignment,
  type AppState,
  type ChannelConfig,
  type ReadChannel,
  type ResearchTask,
  type WriteMode,
} from "@/lib/domain/types";
import { parseYuanToCents, yuan } from "@/lib/format";
import { getState, logActivity, mutateState, resetState } from "@/lib/store";

export interface ActionResponse {
  ok: boolean;
  message: string;
}

function revalidateAll() {
  for (const path of [
    "/",
    "/listings",
    "/inbox",
    "/orders",
    "/automations",
    "/queue",
    "/research",
  ]) {
    revalidatePath(path);
  }
}

export async function runAgentTick(): Promise<ActionResponse> {
  const now = Date.now();
  const summary = await mutateState((state) => performTick(state, now, "manual"));

  revalidateAll();
  return { ok: summary.failed === 0, message: summary.message };
}

export async function retryFailedAction(actionId: string): Promise<ActionResponse> {
  const now = Date.now();
  const response = await mutateState((state) => {
    const action = state.actions.find((a) => a.id === actionId);
    if (!action) return { ok: false, message: "找不到这条动作。" };
    if (action.status !== "failed") return { ok: false, message: "这条动作不是失败状态。" };

    const outcome = retryAction(state, action, writeChannel, now);
    logActivity(
      state,
      outcome.ok ? "human" : "system",
      outcome.ok ? `重试成功：${outcome.message}` : `重试仍然失败：${outcome.message}`,
      now,
    );
    return outcome;
  });

  revalidateAll();
  return response;
}

export async function setAutoTick(
  enabled: boolean,
  minutesInput?: string,
): Promise<ActionResponse> {
  const now = Date.now();
  const minutes = minutesInput === undefined ? undefined : Number(minutesInput);
  if (
    minutes !== undefined &&
    (!Number.isFinite(minutes) || minutes < 1 || minutes > 24 * 60)
  ) {
    return { ok: false, message: "巡检间隔请填 1~1440 分钟。" };
  }

  const response = await mutateState((state) => {
    const changedSwitch = state.settings.autoTickEnabled !== enabled;
    state.settings.autoTickEnabled = enabled;
    if (minutes !== undefined) state.settings.autoTickMinutes = minutes;

    if (changedSwitch) {
      logActivity(
        state,
        "human",
        enabled
          ? `开启自动巡检，每 ${state.settings.autoTickMinutes} 分钟跑一轮。`
          : "关闭自动巡检，Agent 只在你点按钮时才动。",
        now,
      );
    }
    return {
      ok: true,
      message: enabled
        ? `已开启自动巡检，每 ${state.settings.autoTickMinutes} 分钟一轮。`
        : "已关闭自动巡检。",
    };
  });

  revalidateAll();
  return response;
}

export async function decideAction(
  actionId: string,
  decision: "approve" | "reject",
): Promise<ActionResponse> {
  const now = Date.now();
  const response = await mutateState((state) => {
    const action = state.actions.find((a) => a.id === actionId);
    if (!action) return { ok: false, message: "找不到这条建议，可能已经处理过了。" };
    // 执行失败的动作也可以直接忽略，不必先修好再忽略。
    const canDecide =
      action.status === "pending" || (decision === "reject" && action.status === "failed");
    if (!canDecide) {
      return { ok: false, message: "这条建议已经处理过了。" };
    }

    if (decision === "reject") {
      action.status = "rejected";
      action.decidedAt = new Date(now).toISOString();
      action.decidedBy = "human";
      logActivity(state, "human", `忽略了建议：${action.title}`, now);
      return { ok: true, message: "已忽略这条建议。" };
    }

    const outcome = applyAction(state, action, writeChannel, now);
    if (!outcome.ok) {
      logActivity(state, "system", `执行失败：${outcome.message}`, now);
      return { ok: false, message: outcome.message };
    }
    action.status = "applied";
    action.decidedAt = new Date(now).toISOString();
    action.decidedBy = "human";
    logActivity(state, "human", outcome.message, now);
    return { ok: true, message: outcome.message };
  });

  revalidateAll();
  return response;
}

/** 人工修改建议内容后再执行 —— 审批队列里的「编辑后通过」。 */
export async function approveActionWithEdits(
  actionId: string,
  edits: ActionEdits,
): Promise<ActionResponse> {
  const now = Date.now();
  const response = await mutateState((state) => {
    const action = state.actions.find((a) => a.id === actionId);
    if (!action || (action.status !== "pending" && action.status !== "failed")) {
      return { ok: false, message: "这条建议已经处理过了。" };
    }

    const outcome = applyActionWithEdits(state, action, edits, writeChannel, now);
    action.attempts = (action.attempts ?? 0) + 1;
    if (!outcome.ok) {
      if (action.status === "failed") action.failureReason = outcome.message;
      return { ok: false, message: outcome.message };
    }

    action.status = "applied";
    action.failureReason = undefined;
    action.decidedAt = new Date(now).toISOString();
    action.decidedBy = "human";
    logActivity(state, "human", `${outcome.message}（人工修改后执行）`, now);
    return { ok: true, message: outcome.message };
  });

  revalidateAll();
  return response;
}

export async function decideAllPending(
  decision: "approve" | "reject",
): Promise<ActionResponse> {
  const now = Date.now();
  const response = await mutateState((state) => {
    const pending = state.actions.filter((a) => a.status === "pending");
    if (pending.length === 0) return { ok: true, message: "队列里没有待审批的建议。" };

    let done = 0;
    const failures: string[] = [];
    for (const action of pending) {
      if (decision === "reject") {
        action.status = "rejected";
        action.decidedAt = new Date(now).toISOString();
        action.decidedBy = "human";
        done += 1;
        continue;
      }
      const outcome = applyAction(state, action, writeChannel, now);
      if (outcome.ok) {
        action.status = "applied";
        action.decidedAt = new Date(now).toISOString();
        action.decidedBy = "human";
        logActivity(state, "human", outcome.message, now);
        done += 1;
      } else {
        failures.push(outcome.message);
      }
    }

    const verb = decision === "approve" ? "执行" : "忽略";
    logActivity(state, "human", `批量${verb}了 ${done} 条建议。`, now);
    return {
      ok: failures.length === 0,
      message:
        failures.length === 0
          ? `已${verb} ${done} 条建议。`
          : `已${verb} ${done} 条，${failures.length} 条失败：${failures[0]}`,
    };
  });

  revalidateAll();
  return response;
}

/** 收件箱里点「让 Agent 起草」时调用，配置了 LLM 会再润色一遍。 */
export async function draftReplyFor(conversationId: string): Promise<{
  ok: boolean;
  text: string;
  message: string;
}> {
  const state: AppState = await getState();
  const conversation = state.conversations.find((c) => c.id === conversationId);
  if (!conversation) return { ok: false, text: "", message: "找不到这个会话。" };

  const listing = state.listings.find((l) => l.id === conversation.listingId);
  const order = state.orders
    .filter((o) => o.listingId === conversation.listingId && o.buyerName === conversation.buyerName)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];

  const draft = draftReply({ conversation, listing, settings: state.settings, order });
  // 还价金额是按底价算出来的，模型可以改措辞，但这个数字必须原样留着。
  const polished = await polishReply(
    draft.text,
    `商品：${listing?.title ?? "未知"}；买家：${conversation.buyerName}；意图：${INTENT_LABEL[draft.intent]}`,
    { mustKeep: draft.counterOfferCents ? [draft.counterOfferCents / 100] : [] },
  );

  return {
    ok: true,
    text: polished ?? draft.text,
    message: draft.needsHumanEdit
      ? "草稿涉及需要你确认的细节，发送前请检查。"
      : "草稿已生成。",
  };
}

export async function sendReply(
  conversationId: string,
  text: string,
): Promise<ActionResponse> {
  const now = Date.now();
  const response = await mutateState((state) => {
    const outcome = writeChannel.sendMessage(state, conversationId, text, now);
    if (outcome.ok) logActivity(state, "human", outcome.message, now);
    return { ok: outcome.ok, message: outcome.message };
  });
  revalidateAll();
  return response;
}

export async function refreshListing(listingId: string): Promise<ActionResponse> {
  const now = Date.now();
  const response = await mutateState((state) => {
    const outcome = writeChannel.refreshListing(state, listingId, now);
    if (outcome.ok) logActivity(state, "human", outcome.message, now);
    return outcome;
  });
  revalidateAll();
  return response;
}

export async function updateListingPrice(
  listingId: string,
  priceInput: string,
): Promise<ActionResponse> {
  const cents = parseYuanToCents(priceInput);
  if (cents === null) return { ok: false, message: "价格格式不对，试试 199 或 199.50。" };

  const now = Date.now();
  const response = await mutateState((state) => {
    const outcome = writeChannel.updatePrice(state, listingId, cents, now);
    if (outcome.ok) logActivity(state, "human", outcome.message, now);
    return outcome;
  });
  revalidateAll();
  return response;
}

export async function delistListing(listingId: string): Promise<ActionResponse> {
  const now = Date.now();
  const response = await mutateState((state) => {
    const outcome = writeChannel.delistListing(state, listingId, now);
    if (outcome.ok) logActivity(state, "human", outcome.message, now);
    return outcome;
  });
  revalidateAll();
  return response;
}

export async function shipOrder(
  orderId: string,
  carrier: string,
  trackingNo: string,
): Promise<ActionResponse> {
  if (!carrier.trim() || !trackingNo.trim()) {
    return { ok: false, message: "请填写快递公司和运单号。" };
  }
  const now = Date.now();
  const response = await mutateState((state) => {
    const outcome = writeChannel.shipOrder(state, orderId, carrier.trim(), trackingNo.trim(), now);
    if (outcome.ok) logActivity(state, "human", outcome.message, now);
    return outcome;
  });
  revalidateAll();
  return response;
}

export async function setRuleEnabled(
  ruleId: string,
  enabled: boolean,
): Promise<ActionResponse> {
  const now = Date.now();
  const response = await mutateState((state) => {
    const rule = state.rules.find((r) => r.id === ruleId);
    if (!rule) return { ok: false, message: "找不到这条规则。" };
    rule.enabled = enabled;
    logActivity(state, "human", `${enabled ? "开启" : "关闭"}了规则「${rule.name}」。`, now);
    return { ok: true, message: `已${enabled ? "开启" : "关闭"}「${rule.name}」。` };
  });
  revalidateAll();
  return response;
}

export async function setRuleApproval(
  ruleId: string,
  requiresApproval: boolean,
): Promise<ActionResponse> {
  const now = Date.now();
  const response = await mutateState((state) => {
    const rule = state.rules.find((r) => r.id === ruleId);
    if (!rule) return { ok: false, message: "找不到这条规则。" };
    rule.requiresApproval = requiresApproval;
    logActivity(
      state,
      "human",
      `「${rule.name}」改为${requiresApproval ? "人工审批" : "自动执行"}。`,
      now,
    );
    return {
      ok: true,
      message: requiresApproval
        ? "以后这条规则会先进审批队列。"
        : "以后这条规则会直接执行。",
    };
  });
  revalidateAll();
  return response;
}

export async function updateRuleParam(
  ruleId: string,
  key: string,
  rawValue: string,
): Promise<ActionResponse> {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0) {
    return { ok: false, message: "请填一个非负数字。" };
  }
  const response = await mutateState((state) => {
    const rule = state.rules.find((r) => r.id === ruleId);
    if (!rule || !(key in rule.params)) return { ok: false, message: "找不到这个参数。" };
    rule.params[key] = value;
    return { ok: true, message: `已更新「${rule.name}」的 ${key}。` };
  });
  revalidateAll();
  return response;
}

export async function updateSettings(input: {
  shopName: string;
  maxDiscountPercent: string;
  shipWithinHours: string;
  signature: string;
}): Promise<ActionResponse> {
  const discount = Number(input.maxDiscountPercent);
  const hours = Number(input.shipWithinHours);
  if (!Number.isFinite(discount) || discount < 0 || discount > 60) {
    return { ok: false, message: "最大折扣请填 0~60 之间的数字。" };
  }
  if (!Number.isFinite(hours) || hours <= 0 || hours > 168) {
    return { ok: false, message: "发货时效请填 1~168 小时。" };
  }

  const response = await mutateState((state) => {
    state.settings.shopName = input.shopName.trim() || state.settings.shopName;
    state.settings.maxDiscount = discount / 100;
    state.settings.shipWithinHours = hours;
    state.settings.signature = input.signature.trim();
    return { ok: true, message: "店铺设置已保存。" };
  });
  revalidateAll();
  return response;
}

export async function setWritesPaused(
  paused: boolean,
  reason?: string,
): Promise<ActionResponse> {
  const now = Date.now();
  const response = await mutateState((state) => {
    if (paused) {
      pauseWrites(state, reason?.trim() || "你按下了急停", "human", now);
      logActivity(state, "human", "按下急停，所有写操作已停止。", now);
      return { ok: true, message: "已急停，Agent 不会再动任何东西。" };
    }
    const was = state.safety.pausedReason;
    resumeWrites(state);
    logActivity(state, "human", `解除急停（此前原因：${was ?? "未说明"}）。`, now);
    return { ok: true, message: "已解除急停。" };
  });

  revalidateAll();
  return response;
}

export async function updateChannel(input: {
  read?: ReadChannel;
  write?: WriteMode;
  maxWritesPerMinute?: string;
  minWriteIntervalMs?: string;
  autoPauseAfterFailures?: string;
}): Promise<ActionResponse> {
  const numeric: Array<[keyof ChannelConfig, string | undefined, number, number]> = [
    ["maxWritesPerMinute", input.maxWritesPerMinute, 1, 600],
    ["minWriteIntervalMs", input.minWriteIntervalMs, 0, 60_000],
    ["autoPauseAfterFailures", input.autoPauseAfterFailures, 1, 50],
  ];
  for (const [, raw, min, max] of numeric) {
    if (raw === undefined) continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) {
      return { ok: false, message: `参数超出范围，应该在 ${min} 到 ${max} 之间。` };
    }
  }

  const now = Date.now();
  const response = await mutateState((state) => {
    const before = { ...state.channel };
    if (input.read) state.channel.read = input.read;
    if (input.write) state.channel.write = input.write;
    for (const [key, raw] of numeric) {
      if (raw !== undefined) state.channel[key] = Number(raw) as never;
    }

    if (before.write !== state.channel.write) {
      logActivity(
        state,
        "human",
        `写模式：${WRITE_MODE_LABEL[before.write]} → ${WRITE_MODE_LABEL[state.channel.write]}。`,
        now,
      );
    }
    if (before.read !== state.channel.read) {
      logActivity(
        state,
        "human",
        `读通道：${before.read === "live" ? "真实账号" : "本地模拟"} → ${
          state.channel.read === "live" ? "真实账号" : "本地模拟"
        }。`,
        now,
      );
    }
    return { ok: true, message: "通道设置已保存。" };
  });

  revalidateAll();
  return response;
}

/** 从平台拉一次数据合进本地。写模式是什么都不影响这一步，同步只读不写。 */
export async function syncFromPlatform(): Promise<ActionResponse> {
  const now = Date.now();
  const state = await getState();
  const reader = readerFor(state);

  let snapshot;
  try {
    snapshot = await reader.fetchSnapshot(state, now);
  } catch (error) {
    const message = error instanceof Error ? error.message : "读通道调用失败";
    // 读的时候撞上风控，说明这个账号已经被盯上了，写操作必须立刻停手
    const riskControl = error instanceof LiveChannelError && error.kind === "risk_control";

    await mutateState((s) => {
      logActivity(s, "system", `同步失败：${message}`, now);
      if (riskControl && !s.safety.paused) {
        pauseWrites(s, `同步时撞上平台风控：${message}`, "risk_control", now);
        logActivity(s, "system", "已自动急停，所有写操作停止。", now);
      }
    });

    revalidateAll();
    return {
      ok: false,
      message: riskControl ? `${message}（已自动急停）` : message,
    };
  }

  const response = await mutateState((s) => {
    const summary = mergeSnapshot(s, snapshot, now);
    const text = describeMerge(summary);
    logActivity(s, "system", `已从${reader.label}同步：${text}。`, now);
    if (summary.needsFloorPrice > 0) {
      logActivity(
        s,
        "system",
        `有 ${summary.needsFloorPrice} 件在售商品还没确认底价，自动降价会绕开它们。`,
        now,
      );
    }
    return { ok: true, message: `同步完成：${text}。` };
  });

  revalidateAll();
  return response;
}

/** 人工确认某件商品的底价，确认之后自动降价才会考虑它。 */
export async function confirmFloorPrice(
  listingId: string,
  priceInput: string,
): Promise<ActionResponse> {
  const cents = parseYuanToCents(priceInput);
  if (cents === null) return { ok: false, message: "底价格式不对，试试 199 或 199.50。" };

  const now = Date.now();
  const response = await mutateState((state) => {
    const listing = state.listings.find((l) => l.id === listingId);
    if (!listing) return { ok: false, message: "找不到这件商品。" };
    if (cents > listing.priceCents) {
      return { ok: false, message: "底价不能高于当前挂牌价。" };
    }
    listing.floorPriceCents = cents;
    listing.floorConfirmed = true;
    logActivity(state, "human", `确认「${listing.title}」的底价为 ${yuan(cents)}。`, now);
    return { ok: true, message: `底价已确认为 ${yuan(cents)}。` };
  });

  revalidateAll();
  return response;
}

export interface LiveChannelStatus {
  credentials: CredentialStatus;
  endpoints: { listings?: string; conversations?: string; orders?: string };
}

/**
 * 真实通道的配置情况。
 * 只返回「有没有配」和诊断文字，绝不把 cookie 本身传到浏览器。
 */
export async function liveChannelStatus(): Promise<LiveChannelStatus> {
  return { credentials: await credentialStatus(), endpoints: endpointConfig() };
}

/* ── 选品研究 ──────────────────────────────────────────────────────────── */

function splitKeywords(raw: string): string[] {
  return raw
    .split(/[,，、\s]+/)
    .map((word) => word.trim())
    .filter(Boolean);
}

export async function createResearchTask(input: {
  name: string;
  keyword: string;
  mustInclude: string;
  mustExclude: string;
  linkedListingId?: string;
  revisitHours: string;
}): Promise<ActionResponse> {
  const name = input.name.trim();
  if (!name) return { ok: false, message: "给这个研究任务起个名字。" };

  const hours = Number(input.revisitHours);
  if (!Number.isFinite(hours) || hours < 1 || hours > 720) {
    return { ok: false, message: "回访间隔请填 1~720 小时。" };
  }

  const now = Date.now();
  const response = await mutateState((state) => {
    const task: ResearchTask = {
      id: `RT${now.toString(36).toUpperCase()}`,
      name,
      keyword: input.keyword.trim(),
      mustInclude: splitKeywords(input.mustInclude),
      mustExclude: splitKeywords(input.mustExclude),
      linkedListingId: input.linkedListingId || undefined,
      revisitHours: hours,
      status: "active",
      createdAt: new Date(now).toISOString(),
    };
    state.research.tasks.unshift(task);
    logActivity(state, "human", `新建选品研究「${name}」。`, now);
    return { ok: true, message: `已新建研究任务「${name}」。` };
  });

  revalidateAll();
  return response;
}

export async function updateResearchTask(
  taskId: string,
  input: {
    mustInclude?: string;
    mustExclude?: string;
    linkedListingId?: string;
    revisitHours?: string;
  },
): Promise<ActionResponse> {
  if (input.revisitHours !== undefined) {
    const hours = Number(input.revisitHours);
    if (!Number.isFinite(hours) || hours < 1 || hours > 720) {
      return { ok: false, message: "回访间隔请填 1~720 小时。" };
    }
  }

  const response = await mutateState((state) => {
    const task = state.research.tasks.find((t) => t.id === taskId);
    if (!task) return { ok: false, message: "找不到这个研究任务。" };

    if (input.mustInclude !== undefined) task.mustInclude = splitKeywords(input.mustInclude);
    if (input.mustExclude !== undefined) task.mustExclude = splitKeywords(input.mustExclude);
    if (input.linkedListingId !== undefined) {
      task.linkedListingId = input.linkedListingId || undefined;
    }
    if (input.revisitHours !== undefined) task.revisitHours = Number(input.revisitHours);

    // 规格改了，自动判定的对齐结论要跟着重算；人工改过的不动
    let realigned = 0;
    for (const rival of state.research.rivals.filter((r) => r.taskId === taskId)) {
      if (rival.alignmentBy === "human") continue;
      const next = alignmentFor(task, rival.title);
      if (next !== rival.alignment) realigned += 1;
      rival.alignment = next;
    }

    return {
      ok: true,
      message: realigned > 0 ? `已保存，${realigned} 件同行的对齐结论变了。` : "已保存。",
    };
  });

  revalidateAll();
  return response;
}

/**
 * 导入一份页面快照。
 *
 * 这是同行数据**唯一**的入口：你在正常浏览时采集，本机解析入库。
 * 服务器不会拿你的登录态去轮询别人的商详 —— 那是爬站。
 */
export async function importPageSnapshot(
  taskId: string,
  raw: string,
): Promise<ActionResponse> {
  if (!raw.trim()) return { ok: false, message: "先粘贴一份页面快照。" };

  const now = Date.now();
  const parsed = parsePageSnapshot(raw, now);
  if (parsed.items.length === 0) {
    return { ok: false, message: parsed.warnings[0] ?? "这份快照里没认出任何商品。" };
  }

  const response = await mutateState((state) => {
    const task = state.research.tasks.find((t) => t.id === taskId);
    if (!task) return { ok: false, message: "找不到这个研究任务。" };

    const summary = recordObservations(state, taskId, parsed, now);
    const text = describeRecord(summary);
    logActivity(state, "human", `选品研究「${task.name}」：${text}。`, now);
    return {
      ok: true,
      message: [text, ...parsed.warnings].join("；"),
    };
  });

  revalidateAll();
  return response;
}

/** 人工改对齐结论。改过之后不会再被关键词判定覆盖 —— 人看过的比关键词可靠。 */
export async function setRivalAlignment(
  rivalId: string,
  alignment: Alignment,
): Promise<ActionResponse> {
  const response = await mutateState((state) => {
    const rival = state.research.rivals.find((r) => r.id === rivalId);
    if (!rival) return { ok: false, message: "找不到这件同行商品。" };
    rival.alignment = alignment;
    rival.alignmentBy = "human";
    return { ok: true, message: `已标记为「${ALIGNMENT_LABEL[alignment]}」。` };
  });

  revalidateAll();
  return response;
}

/**
 * 换一把采集密钥。
 *
 * 密钥泄露了、或者你不想让某个装过扩展的浏览器再投数据，就换一把 ——
 * 换完所有采集端都得重新填。
 */
export async function regenerateCollectorToken(): Promise<ActionResponse> {
  const now = Date.now();
  const response = await mutateState((state) => {
    state.research.collectorToken = newCollectorToken();
    logActivity(state, "human", "重新生成了采集密钥，采集端需要重新填。", now);
    return { ok: true, message: "已换一把新密钥，记得更新扩展里的设置。" };
  });

  revalidateAll();
  return response;
}

export async function removeRival(rivalId: string): Promise<ActionResponse> {
  const response = await mutateState((state) => {
    const index = state.research.rivals.findIndex((r) => r.id === rivalId);
    if (index < 0) return { ok: false, message: "找不到这件同行商品。" };
    const [removed] = state.research.rivals.splice(index, 1);
    return { ok: true, message: `已移出研究：${removed.title.slice(0, 20)}。` };
  });

  revalidateAll();
  return response;
}

export async function resetDemoData(): Promise<ActionResponse> {
  await resetState();
  revalidateAll();
  return { ok: true, message: "示例数据已重置。" };
}
