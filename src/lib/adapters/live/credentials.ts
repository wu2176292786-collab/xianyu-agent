import { type LoginState, loadLoginState, parseLoginState } from "./login-state";
import { describeTokenExpiry, extractToken } from "./mtop";

/**
 * 真实通道的凭证检查。
 *
 * 凭证来自环境变量或者 `.secrets/xianyu-login-state.json`，
 * 永远不写进仓库、不写进 `.data/state.json`、也不会出现在任何日志里。
 * 扫码登录要在你自己的浏览器里完成。
 */
export interface CredentialStatus {
  configured: boolean;
  /** 有没有拿到 _m_h5_tk 里的签名 token */
  hasToken: boolean;
  /** 有没有登录态相关的 cookie */
  hasSession: boolean;
  /** 有没有带上当初那个浏览器的 User-Agent */
  hasUserAgent: boolean;
  /** 给人看的一句话诊断，绝不包含凭证内容 */
  detail: string;
}

/** 登录态相关的 cookie 名，缺了这些只能算游客。 */
const SESSION_KEYS = ["unb", "cookie2", "_tb_token_", "sgcookie"];

export function inspectLoginState(state: LoginState | null): CredentialStatus {
  if (!state || !state.cookie) {
    return {
      configured: false,
      hasToken: false,
      hasSession: false,
      hasUserAgent: false,
      detail: "还没有导入登录态，真实读通道不可用。",
    };
  }

  const hasToken = extractToken(state.cookie) !== null;
  const hasUserAgent = Boolean(state.headers["user-agent"]);
  const present = SESSION_KEYS.filter((key) =>
    new RegExp(`(^|;\\s*)${key}=`).test(state.cookie),
  );
  const hasSession = present.length > 0;

  if (!hasSession) {
    return {
      configured: true,
      hasToken,
      hasSession: false,
      hasUserAgent,
      detail: `cookie 里没有登录态字段（${SESSION_KEYS.join(" / ")}），可能只导出了游客状态。`,
    };
  }

  const notes = [`登录态字段 ${present.join("、")} 齐全`, describeTokenExpiry(state.cookie)];
  if (!hasUserAgent) {
    notes.push("没有 User-Agent —— 建议用扩展一并导出，请求头和 cookie 不一致容易触发风控");
  }

  return {
    configured: true,
    hasToken,
    hasSession: true,
    hasUserAgent,
    detail: `已导入，${notes.join("；")}。`,
  };
}

export async function credentialStatus(): Promise<CredentialStatus> {
  return inspectLoginState(await loadLoginState());
}

/**
 * 把页面上粘过来的导出解析成可落盘的登录态。
 * 认不出格式就失败，绝不返回半残对象。
 */
export function prepareLoginImport(
  raw: string,
  now = Date.now(),
):
  | { ok: false; message: string }
  | { ok: true; state: LoginState; warnings: string[] } {
  const parsed = parseLoginState(raw);
  if (!parsed) {
    return {
      ok: false,
      message: "解析失败：既不是 cookie 串，也不是认得出来的 JSON。",
    };
  }

  const state: LoginState = {
    ...parsed,
    capturedAt: parsed.capturedAt ?? new Date(now).toISOString(),
  };
  const inspected = inspectLoginState(state);
  const warnings: string[] = [];
  if (!inspected.hasSession) {
    warnings.push("没找到登录态字段，多半是在未登录的页面上点了提取。");
  }
  if (!inspected.hasUserAgent) {
    warnings.push("没拿到 User-Agent。建议用扩展一并导出请求头，避免和 cookie 对不上。");
  }
  return { ok: true, state, warnings };
}
