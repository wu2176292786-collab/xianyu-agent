"use server";

import type { ActionResponse } from "@/lib/action-kit";
import { revalidateAll } from "@/lib/action-kit";
import { readerFor, writeChannelFor } from "@/lib/adapters";
import {
  applyAction,
  applyActionWithEdits,
  retryAction,
  type ActionEdits,
} from "@/lib/agent/engine";
import { llmApiKey, llmStatus } from "@/lib/agent/llm";
import { polishReply } from "@/lib/agent/llm";
import {
  clearLlmConfig,
  describeLlmConfig,
  maskKey,
  parseLlmConfig,
  readLlmConfigFileSync,
  saveLlmConfig,
  type LlmConfigView,
} from "@/lib/agent/llm-config";
import { INTENT_LABEL, draftReply } from "@/lib/agent/reply";
import { displayImageUrls } from "@/lib/research/snapshot";
import { performTick } from "@/lib/agent/tick";
import { clearDemoData, describeClearDemo } from "@/lib/domain/demo";
import type { AppState } from "@/lib/domain/types";
import { parseYuanToCents, yuan } from "@/lib/format";
import { getState, logActivity, mutateState, resetState } from "@/lib/store";

export async function runAgentTick(): Promise<ActionResponse> {
  const now = Date.now();
  const summary = await mutateState((state) => performTick(state, now, "manual"));

  revalidateAll();
  return { ok: summary.failed === 0, message: summary.message };
}

export async function retryFailedAction(actionId: string): Promise<ActionResponse> {
  const now = Date.now();
  const response = await mutateState(async (state) => {
    const action = state.actions.find((a) => a.id === actionId);
    if (!action) return { ok: false, message: "找不到这条动作。" };
    if (action.status !== "failed") return { ok: false, message: "这条动作不是失败状态。" };

    const outcome = await retryAction(state, action, writeChannelFor(state), now);
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
  const response = await mutateState(async (state) => {
    const action = state.actions.find((a) => a.id === actionId);
    if (!action) return { ok: false, message: "找不到这条建议，可能已经处理过了。" };
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

    const outcome = await applyAction(state, action, writeChannelFor(state), now);
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
  const response = await mutateState(async (state) => {
    const action = state.actions.find((a) => a.id === actionId);
    if (!action || (action.status !== "pending" && action.status !== "failed")) {
      return { ok: false, message: "这条建议已经处理过了。" };
    }

    const outcome = await applyActionWithEdits(state, action, edits, writeChannelFor(state), now);
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
  const response = await mutateState(async (state) => {
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
      const outcome = await applyAction(state, action, writeChannelFor(state), now);
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

  const listing =
    state.listings.find((l) => l.id === conversation.listingId) ??
    (conversation.listingTitle
      ? {
          id: conversation.listingId,
          title: conversation.listingTitle,
          category: "",
          emoji: "📦",
          priceCents: conversation.listingPriceCents ?? 0,
          floorPriceCents: conversation.listingPriceCents ?? 0,
          floorConfirmed: false,
          costCents: 0,
          stock: 1,
          status: "on_sale" as const,
          createdAt: new Date().toISOString(),
          lastRefreshedAt: new Date().toISOString(),
          views7d: 0,
          wants: 0,
          inquiries7d: 0,
          tags: [],
          metricsUnknown: true,
        }
      : undefined);
  const order = state.orders
    .filter((o) => o.listingId === conversation.listingId && o.buyerName === conversation.buyerName)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];

  const draft = draftReply({ conversation, listing, settings: state.settings, order });
  const polished = await polishReply(
    draft.text,
    `商品：${listing?.title ?? conversation.listingTitle ?? "未知"}；买家：${conversation.buyerName}；意图：${INTENT_LABEL[draft.intent]}`,
    { mustKeep: draft.counterOfferCents ? [draft.counterOfferCents / 100] : [] },
  );

  return {
    ok: true,
    text: polished.text ?? draft.text,
    message: [
      draft.needsHumanEdit ? "草稿涉及需要你确认的细节，发送前请检查。" : "草稿已生成。",
      polished.fallback,
    ]
      .filter(Boolean)
      .join(" "),
  };
}

export async function sendReply(
  conversationId: string,
  text: string,
): Promise<ActionResponse> {
  const now = Date.now();
  const response = await mutateState(async (state) => {
    const outcome = await writeChannelFor(state).sendMessage(state, conversationId, text, now);
    if (outcome.ok) logActivity(state, "human", outcome.message, now);
    return { ok: outcome.ok, message: outcome.message };
  });
  revalidateAll();
  return response;
}

export async function refreshListing(listingId: string): Promise<ActionResponse> {
  const now = Date.now();
  const response = await mutateState(async (state) => {
    const outcome = await writeChannelFor(state).refreshListing(state, listingId, now);
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
  const response = await mutateState(async (state) => {
    const outcome = await writeChannelFor(state).updatePrice(state, listingId, cents, now);
    if (outcome.ok) logActivity(state, "human", outcome.message, now);
    return outcome;
  });
  revalidateAll();
  return response;
}

export async function delistListing(listingId: string): Promise<ActionResponse> {
  const now = Date.now();
  const response = await mutateState(async (state) => {
    const outcome = await writeChannelFor(state).delistListing(state, listingId, now);
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
  const response = await mutateState(async (state) => {
    const outcome = await writeChannelFor(state).shipOrder(
      state,
      orderId,
      carrier.trim(),
      trackingNo.trim(),
      now,
    );
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

export async function resetDemoData(): Promise<ActionResponse> {
  await resetState();
  revalidateAll();
  return { ok: true, message: "示例数据已重置。" };
}

/**
 * 只清示例数据，留下同步来的真实数据。
 *
 * 和「重置示例数据」正好相反：那个会把真实数据一起冲掉。
 */
export async function clearDemo(): Promise<ActionResponse> {
  const now = Date.now();

  let nick: string | undefined;
  const state = await getState();
  if (state.channel.read === "live") {
    try {
      nick = (await readerFor(state).fetchSnapshot(state, now)).shopName;
    } catch {
      // 登录态过期之类，清理照做
    }
  }

  const response = await mutateState((s) => {
    const summary = clearDemoData(s, nick);
    const text = describeClearDemo(summary);
    logActivity(s, "human", text, now);
    return { ok: true, message: text };
  });

  revalidateAll();
  return response;
}

/** 给人看的模型接入摘要。只有脱敏后的密钥和诊断文字。 */
export async function llmConfigView(): Promise<LlmConfigView> {
  const status = llmStatus();
  const file = readLlmConfigFileSync();
  const key = llmApiKey();
  return {
    configured: status.configured,
    origin: status.origin,
    hasEnv: status.hasEnv,
    baseUrl: status.baseUrl,
    model: status.model,
    visionModel: status.visionModel,
    sendThinkingHints: status.sendThinkingHints,
    maskedKey: key ? maskKey(key) : undefined,
    savedAt: file?.savedAt,
    detail: describeLlmConfig(status),
  };
}

/**
 * 写进本机 `.secrets/llm-config.json`，权限 600，绝不回传密钥原文。
 *
 * `apiKey` 留空表示"只换模型，密钥沿用现在生效的那份"。
 */
export async function importLlmConfig(input: {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  visionModel?: string;
  sendThinkingHints?: boolean;
}): Promise<ActionResponse> {
  const typed = input.apiKey?.trim();
  // 没填新密钥就把现在生效的那份接着存下来，不然一换模型就把密钥丢了
  const apiKey = typed || readLlmConfigFileSync()?.apiKey;

  const parsed = parseLlmConfig({ ...input, apiKey });
  if (!parsed) {
    return { ok: false, message: "至少要填一项：API Key、接口地址或模型名。" };
  }
  if (!apiKey && !process.env.OPENAI_API_KEY?.trim()) {
    return { ok: false, message: "还没有可用的 API Key。先填一条 sk-… 再保存。" };
  }

  await saveLlmConfig(parsed);
  revalidateAll();

  if (!parsed.apiKey) {
    return {
      ok: true,
      message: "已保存。密钥沿用环境变量那份，模型按你填的走。接着点验证。",
    };
  }
  return { ok: true, message: "已保存。接着点验证，确认接口和模型名都对。" };
}

export async function clearImportedLlmConfig(): Promise<ActionResponse> {
  await clearLlmConfig();
  revalidateAll();
  return {
    ok: true,
    message: process.env.OPENAI_API_KEY?.trim()
      ? "已清除本机配置，退回环境变量那份。"
      : "已清除本机模型配置。",
  };
}

/**
 * 问网关有哪些模型可用。
 *
 * 不是所有兼容服务都实现了 `/models`，拿不到就如实说，让人自己填 ——
 * 这个按钮是为了省打字，不是必经步骤。
 */
export async function listLlmModels(): Promise<{
  ok: boolean;
  message: string;
  models: string[];
}> {
  const status = llmStatus();
  const key = llmApiKey();
  if (!status.configured || !key) {
    return { ok: false, message: "还没配置模型，先填 API Key。", models: [] };
  }

  try {
    const response = await fetch(`${status.baseUrl}/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return {
        ok: false,
        message: `这个服务没提供模型列表（HTTP ${response.status}），模型名请自己填。`,
        models: [],
      };
    }
    const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
    const models = (body.data ?? [])
      .map((item) => (typeof item.id === "string" ? item.id : undefined))
      .filter((id): id is string => Boolean(id))
      .sort()
      .slice(0, 200);
    if (models.length === 0) {
      return { ok: false, message: "网关返回的列表是空的，模型名请自己填。", models: [] };
    }
    return { ok: true, message: `拿到 ${models.length} 个可用模型。`, models };
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "TimeoutError" ? "超时" : "网络错误";
    return { ok: false, message: `拉取模型列表${reason}。模型名请自己填。`, models: [] };
  }
}

/**
 * 拿库里一张真实的商品图来验看图能力。
 *
 * 一开始用的是内联的 1×1 base64，结果 MiniMax 直接 500 ——
 * 它只收远程 URL。用真实商品图反而更对：那就是这个功能实际会发的东西，
 * 顺带把「模型能不能抓到闲鱼 CDN」也一起验了。
 */
async function sampleItemImageUrl(): Promise<string | undefined> {
  const state = await getState();
  for (const rival of state.research.rivals) {
    const usable = displayImageUrls(rival.imageUrls)[0];
    if (usable) return usable;
  }
  return undefined;
}

/**
 * 真打一次模型网关。
 *
 * 传了 `draft` 就验草稿里那份 —— 界面上改完还没保存就点验证是常事，
 * 这时候验已保存的那份等于答非所问。
 *
 * 文本模型用 `max_tokens: 1` 的最小请求，一次把三件事都验了：
 * 密钥对不对、baseUrl 通不通、模型名存不存在。
 * 只查 `/models` 验不出模型名，那才是最常填错的地方。
 *
 * 看图模型额外带一张 1×1 的图 —— 模型名存在不代表它收图，
 * 不带图就通、真用起来才 400 是最难查的那种问题。
 */
export async function verifyLlmConfig(draft?: {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  visionModel?: string;
}): Promise<ActionResponse> {
  const status = llmStatus();
  const key = draft?.apiKey?.trim() || llmApiKey();
  const baseUrl = draft?.baseUrl?.trim() || status.baseUrl;
  const model = draft?.model?.trim() || status.model;
  // 草稿里显式清空看图模型时要当真，不能回退到已保存的那个
  const visionModel =
    draft !== undefined ? draft.visionModel?.trim() || undefined : status.visionModel;

  if (!key) {
    return { ok: false, message: "还没有可用的 API Key，先填一条再验证。" };
  }

  const probe = async (
    probeModel: string,
    label: string,
    imageUrl?: string,
  ): Promise<string | null> => {
    const content = imageUrl
      ? [
          { type: "text", text: "一句话说这张图在卖什么" },
          { type: "image_url", image_url: { url: imageUrl, detail: "low" } },
        ]
      : "hi";
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: probeModel,
          max_tokens: 1,
          messages: [{ role: "user", content }],
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) return null;
      const body = (await response.text()).slice(0, 200).replace(/\s+/g, " ");
      return `${label} 调用失败（HTTP ${response.status}${body ? `：${body}` : ""}）`;
    } catch (error) {
      const reason =
        error instanceof Error && error.name === "TimeoutError" ? "超时" : "网络错误";
      return `${label} 调用${reason}。确认 baseUrl 能通。`;
    }
  };

  const textError = await probe(model, `文本模型 ${model}`);
  if (textError) return { ok: false, message: textError };

  const unsaved = draft ? "记得点保存，否则重启后就没了。" : "";

  if (visionModel) {
    const sample = await sampleItemImageUrl();
    if (!sample) {
      return {
        ok: true,
        message: `文本模型 ${model} 通了。库里还没有商品图，看图能力等采到图之后再验。${unsaved}`.trim(),
      };
    }
    const visionError = await probe(visionModel, `看图模型 ${visionModel}`, sample);
    if (visionError) {
      return {
        ok: false,
        message: `文本模型 ${model} 通了，但${visionError}。这个模型可能不收图片输入，或者抓不到闲鱼的图。`,
      };
    }
    return {
      ok: true,
      message: `文本模型 ${model} 通了，看图模型 ${visionModel} 能读出商品图。${unsaved}`.trim(),
    };
  }

  return {
    ok: true,
    message: `文本模型 ${model} 通了。看图模型这一栏是空的，所以同行筛选只看标题和正文。${unsaved}`.trim(),
  };
}
