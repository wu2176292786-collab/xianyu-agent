import { extractToken } from "./mtop";

/**
 * 真实通道的凭证管理。
 *
 * 凭证只从环境变量读，永远不写进仓库、不写进 `.data/state.json`、
 * 也不会出现在任何日志里。扫码登录要在你自己的浏览器里完成，
 * 然后把 cookie 串放进 `.env.local` 的 `XIANYU_COOKIE`。
 */
export interface CredentialStatus {
  configured: boolean;
  /** 有没有拿到 _m_h5_tk 里的签名 token */
  hasToken: boolean;
  /** 有没有登录态相关的 cookie */
  hasSession: boolean;
  /** 给人看的一句话诊断，绝不包含凭证内容 */
  detail: string;
}

/** 登录态相关的 cookie 名，缺了这些只能算游客。 */
const SESSION_KEYS = ["unb", "cookie2", "_tb_token_", "sgcookie"];

export function readCookie(): string {
  return process.env.XIANYU_COOKIE?.trim() ?? "";
}

export function inspectCookie(cookie: string): CredentialStatus {
  if (!cookie) {
    return {
      configured: false,
      hasToken: false,
      hasSession: false,
      detail: "没有配置 XIANYU_COOKIE，真实读通道不可用。",
    };
  }

  const hasToken = extractToken(cookie) !== null;
  const present = SESSION_KEYS.filter((key) =>
    new RegExp(`(^|;\\s*)${key}=`).test(cookie),
  );
  const hasSession = present.length > 0;

  if (!hasSession) {
    return {
      configured: true,
      hasToken,
      hasSession: false,
      detail: `cookie 里没有找到登录态字段（${SESSION_KEYS.join(" / ")}），可能只复制了游客 cookie。`,
    };
  }

  return {
    configured: true,
    hasToken,
    hasSession: true,
    detail: hasToken
      ? `已配置，登录态字段 ${present.join("、")} 齐全。`
      : `已配置，但缺少 _m_h5_tk，首次请求会自动换取。`,
  };
}

export function credentialStatus(): CredentialStatus {
  return inspectCookie(readCookie());
}

/**
 * 把 cookie 串脱敏，只留字段名和长度。
 * 任何需要打日志或者展示给界面的地方都必须先过这一层。
 */
export function redactCookie(cookie: string): string {
  if (!cookie) return "(空)";
  const names = cookie
    .split(";")
    .map((pair) => pair.split("=")[0]?.trim())
    .filter((name): name is string => Boolean(name));
  return `${names.length} 个字段（${names.slice(0, 6).join(", ")}${names.length > 6 ? " …" : ""}），共 ${cookie.length} 字符`;
}
