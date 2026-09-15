import { randomBytes } from "node:crypto";
import type { AppState } from "@/lib/domain/types";

/**
 * 采集端配对密钥。
 *
 * 浏览器扩展要把快照 POST 到本机的应用上，而 `localhost` 对任何网页都是可达的。
 * 没有密钥的话，你随便打开的某个网站也能往你的研究里塞脏数据。
 *
 * 这不是平台凭证 —— 它既不能登录闲鱼，也不能动你的商品，所以不进 `.secrets/`，
 * 就放在本地状态里，界面上给你复制。
 */
export function newCollectorToken(): string {
  return randomBytes(16).toString("hex");
}

/** 老状态里没有这个字段，读到就补一个。 */
export function ensureCollectorToken(state: AppState): string {
  if (!state.research.collectorToken) {
    state.research.collectorToken = newCollectorToken();
  }
  return state.research.collectorToken;
}

/**
 * 定长比较，避免用 `===` 早退带出时序信息。
 *
 * 说实话本机应用里这点时序差没什么可利用的，但这种比较又不费什么事。
 */
export function verifyCollectorToken(expected: string, given: unknown): boolean {
  if (typeof given !== "string" || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  }
  return diff === 0;
}

export interface ImportRequest {
  token: string;
  taskId: string;
  snapshot: unknown;
}

/**
 * 校验扩展发过来的请求体。
 *
 * 单独抽出来是为了能直接测 —— 路由处理函数不好测，纯函数好测。
 */
export function parseImportBody(
  body: unknown,
): { ok: true; value: ImportRequest } | { ok: false; message: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, message: "请求体必须是 JSON 对象。" };
  }

  const record = body as Record<string, unknown>;
  if (typeof record.token !== "string" || !record.token) {
    return { ok: false, message: "缺少采集密钥。" };
  }
  if (typeof record.taskId !== "string" || !record.taskId) {
    return { ok: false, message: "缺少研究任务 id。" };
  }
  if (record.snapshot === undefined || record.snapshot === null) {
    return { ok: false, message: "缺少页面快照。" };
  }

  return {
    ok: true,
    value: {
      token: record.token,
      taskId: record.taskId,
      snapshot: record.snapshot,
    },
  };
}
