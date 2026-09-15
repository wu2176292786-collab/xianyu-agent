"use server";

import { revalidatePath } from "next/cache";
import { mockAdapter } from "@/lib/adapters/mock";
import {
  applyAction,
  applyActionWithEdits,
  retryAction,
  type ActionEdits,
} from "@/lib/agent/engine";
import { performTick } from "@/lib/agent/tick";
import { polishReply } from "@/lib/agent/llm";
import { draftReply } from "@/lib/agent/reply";
import type { AppState } from "@/lib/domain/types";
import { parseYuanToCents } from "@/lib/format";
import { getState, logActivity, mutateState, resetState } from "@/lib/store";

export interface ActionResponse {
  ok: boolean;
  message: string;
}

function revalidateAll() {
  for (const path of ["/", "/listings", "/inbox", "/orders", "/automations", "/queue"]) {
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

    const outcome = retryAction(state, action, mockAdapter, now);
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

    const outcome = applyAction(state, action, mockAdapter, now);
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

    const outcome = applyActionWithEdits(state, action, edits, mockAdapter, now);
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
      const outcome = applyAction(state, action, mockAdapter, now);
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
  const polished = await polishReply(
    draft.text,
    `商品：${listing?.title ?? "未知"}；买家：${conversation.buyerName}；意图：${draft.intent}`,
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
    const outcome = mockAdapter.sendMessage(state, conversationId, text, now);
    if (outcome.ok) logActivity(state, "human", outcome.message, now);
    return { ok: outcome.ok, message: outcome.message };
  });
  revalidateAll();
  return response;
}

export async function refreshListing(listingId: string): Promise<ActionResponse> {
  const now = Date.now();
  const response = await mutateState((state) => {
    const outcome = mockAdapter.refreshListing(state, listingId, now);
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
    const outcome = mockAdapter.updatePrice(state, listingId, cents, now);
    if (outcome.ok) logActivity(state, "human", outcome.message, now);
    return outcome;
  });
  revalidateAll();
  return response;
}

export async function delistListing(listingId: string): Promise<ActionResponse> {
  const now = Date.now();
  const response = await mutateState((state) => {
    const outcome = mockAdapter.delistListing(state, listingId, now);
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
    const outcome = mockAdapter.shipOrder(state, orderId, carrier.trim(), trackingNo.trim(), now);
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

export async function resetDemoData(): Promise<ActionResponse> {
  await resetState();
  revalidateAll();
  return { ok: true, message: "示例数据已重置。" };
}
