"use server";

import type { ActionResponse, LiveChannelStatus, LoginStateView } from "@/lib/action-kit";
import { revalidateAll } from "@/lib/action-kit";
import { readerFor } from "@/lib/adapters";
import {
  WRITE_MODE_LABEL,
  pauseWrites,
  resumeWrites,
} from "@/lib/adapters/guard";
import { credentialStatus, prepareLoginImport } from "@/lib/adapters/live/credentials";
import {
  clearLoginState,
  describeLoginState,
  loadLoginState,
  loginStateOrigin,
  saveLoginState,
} from "@/lib/adapters/live/login-state";
import { VERIFIED_ENDPOINTS, endpointConfig } from "@/lib/adapters/live/reader";
import {
  LiveChannelError,
  callMtop,
  cookieField,
  selfUserId,
} from "@/lib/adapters/live/mtop-client";
import { adoptAccount, describeMerge, mergeSnapshot } from "@/lib/agent/sync";
import type { ChannelConfig, ReadChannel, WriteMode } from "@/lib/domain/types";
import { getState, logActivity, mutateState } from "@/lib/store";

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
    for (const note of snapshot.notes ?? []) logActivity(s, "system", note, now);
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

/** 给人看的登录态摘要。只有诊断文字，没有 cookie。 */
export async function loginStateView(): Promise<LoginStateView> {
  const [credentials, origin, login] = await Promise.all([
    credentialStatus(),
    loginStateOrigin(),
    loadLoginState(),
  ]);
  return {
    credentials,
    origin,
    capturedAt: login?.capturedAt,
    description: describeLoginState(login),
  };
}

/** 把扩展或手抄的导出写进本机 `.secrets/`，绝不回传原文。 */
export async function importLoginState(raw: string): Promise<ActionResponse> {
  const prepared = prepareLoginImport(raw);
  if (!prepared.ok) return prepared;

  await saveLoginState(prepared.state);
  const origin = await loginStateOrigin();
  const now = Date.now();
  const userId = selfUserId(prepared.state.cookie);
  const nick = cookieField(prepared.state.cookie, "tracknick");
  const switched = await mutateState((state) => {
    const changed = userId ? adoptAccount(state, userId, nick) : false;
    logActivity(
      state,
      "human",
      changed
        ? "已切换闲鱼账号，上一账号的商品、会话和订单已清空。"
        : "已导入闲鱼登录态。",
      now,
    );
    return changed;
  });
  revalidateAll();

  const warnings = prepared.warnings.join(" ");
  const next =
    switched
      ? "上一账号的商品已清空，请再同步一次拉新账号的数据。"
      : "接下来可以点验证，确认还没过期。";
  if (origin === "env") {
    return {
      ok: true,
      message: `已写入本地文件，但当前仍被环境变量 XIANYU_COOKIE 覆盖。${warnings}`.trim(),
    };
  }
  return {
    ok: true,
    message: warnings ? `已导入。${warnings} ${next}`.trim() : `已导入登录态。${next}`,
  };
}

export async function clearImportedLoginState(): Promise<ActionResponse> {
  const origin = await loginStateOrigin();
  if (origin === "env") {
    return {
      ok: false,
      message: "当前登录态来自环境变量 XIANYU_COOKIE，页面里清不掉，需要先从 .env.local 里删掉再重启。",
    };
  }
  await clearLoginState();
  const now = Date.now();
  await mutateState((state) => {
    logActivity(state, "human", "已清除本机闲鱼登录态。", now);
  });
  revalidateAll();
  return { ok: true, message: "已清除本机登录态。" };
}

/** 真的打一次闲鱼网关，只看登录还在不在，不拉商品。 */
export async function verifyImportedLoginState(): Promise<ActionResponse> {
  const login = await loadLoginState();
  const inspected = await credentialStatus();
  if (!login || !inspected.configured) {
    return { ok: false, message: inspected.detail };
  }

  try {
    const userId = selfUserId(login.cookie);
    const outcome = await callMtop({
      api: VERIFIED_ENDPOINTS.userHead,
      payload: userId ? { userId, self: true } : { self: true },
      loginState: login,
      maxAttempts: 1,
    });
    if (outcome.kind === "ok") {
      return { ok: true, message: "登录态有效。可以回消息页点「从平台同步」。" };
    }
    if (outcome.kind === "session_expired") {
      return { ok: false, message: "登录态已过期，请回闲鱼网页重新登录后再导出一次。" };
    }
    if (outcome.kind === "risk_control") {
      return { ok: false, message: `${outcome.message} 先别再点验证。` };
    }
    return { ok: false, message: outcome.message || "验证失败。" };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "验证失败。",
    };
  }
}

/**
 * 真实通道的配置情况。
 * 只返回「有没有配」和诊断文字，绝不把 cookie 本身传到浏览器。
 */
export async function liveChannelStatus(): Promise<LiveChannelStatus> {
  const endpoints = endpointConfig();
  const label = (endpoint?: { api: string; version: string }) =>
    endpoint ? `${endpoint.api}（v${endpoint.version}）` : undefined;

  return {
    credentials: await credentialStatus(),
    endpoints: {
      listings: label(endpoints.listings),
      conversations: label(endpoints.conversations),
      orders: label(endpoints.orders),
    },
  };
}
