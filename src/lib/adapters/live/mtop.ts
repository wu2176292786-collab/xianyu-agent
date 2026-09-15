import { createHash } from "node:crypto";

/**
 * 闲鱼网页版走的是淘系的 MTOP 网关：
 *
 *   POST https://h5api.m.goofish.com/h5/{api}/{version}/?appKey=...&t=...&sign=...
 *   body: data=<urlencoded JSON>
 *   → {"api":"...","v":"1.0","ret":["SUCCESS::接口调用成功"],"data":{...}}
 *
 * 下面这几个错误码是实测拿到的，不是猜的：
 *   FAIL_SYS_API_NOT_FOUNDED::请求API不存在
 *   FAIL_SYS_TOKEN_EMPTY::令牌为空
 *   FAIL_SYS_SESSION_EXPIRED
 */
export const MTOP_HOST = "https://h5api.m.goofish.com";

/**
 * 闲鱼网页版的 appKey。
 *
 * 这个值参与签名（见 {@link signRequest}），填错了签名就永远算不对 ——
 * 之前这里写的是 `12574478`（淘宝 h5 的 appKey，从示例里抄来的），
 * 所以任何需要登录的调用都注定失败。`34839810` 是从闲鱼网页版自己的
 * 打包产物里读出来的，那份 bundle 里根本没有出现过 12574478。
 */
export const GOOFISH_APP_KEY = "34839810";

export interface MtopEnvelope {
  api?: string;
  v?: string;
  ret?: string[];
  data?: unknown;
}

export type MtopOutcomeKind =
  | "ok"
  /** 缺 token 或 token 过期，刷新一次 token 就能重试 */
  | "token_expired"
  /** 登录态没了，必须重新扫码 */
  | "session_expired"
  /** 撞上风控：滑块、验证码、异常拦截。必须停手 */
  | "risk_control"
  /** 被限流，退避后重试 */
  | "rate_limited"
  /** 接口名写错了 */
  | "api_not_found"
  | "other";

export interface MtopOutcome {
  kind: MtopOutcomeKind;
  /** ret 数组里的第一条，原样保留方便排查 */
  ret: string;
  message: string;
  data?: unknown;
}

const RISK_CODES = [
  "RGV587_ERROR",
  "FAIL_SYS_USER_VALIDATE",
  "SUCCESS::滑块",
  "FAIL_SYS_ILLEGAL_ACCESS",
];

/** 把网关返回的 ret 翻译成我们关心的几种情况。 */
export function classifyRet(ret: string | undefined): MtopOutcomeKind {
  if (!ret) return "other";
  const code = ret.split("::")[0];

  if (code === "SUCCESS") return "ok";
  if (RISK_CODES.some((risk) => ret.includes(risk))) return "risk_control";
  // 网关真实返回的是 FAIL_SYS_TOKEN_EXOIRED —— 阿里这个错误码本身就拼错了，
  // 只匹配正确拼写的话，最常见的 token 过期永远不会触发换 token。
  if (
    code.includes("TOKEN_EXPIRED") ||
    code.includes("TOKEN_EXOIRED") ||
    code.includes("TOKEN_EMPTY")
  ) {
    return "token_expired";
  }
  if (code.includes("SESSION_EXPIRED") || code.includes("NEED_LOGIN")) return "session_expired";
  if (code.includes("TRAFFIC_LIMIT") || code.includes("FLOW_LIMIT")) return "rate_limited";
  if (code === "FAIL_SYS_API_NOT_FOUNDED") return "api_not_found";
  return "other";
}

export function readEnvelope(envelope: MtopEnvelope): MtopOutcome {
  const ret = envelope.ret?.[0] ?? "";
  const kind = classifyRet(ret);
  return {
    kind,
    ret,
    message: ret.split("::").slice(1).join("::") || ret || "网关没有返回 ret",
    data: envelope.data,
  };
}

/**
 * h5 的签名算法：md5(token + "&" + 时间戳 + "&" + appKey + "&" + data)。
 * token 取 `_m_h5_tk` 这个 cookie 下划线前面的部分。
 */
export function signRequest(
  token: string,
  timestamp: string,
  appKey: string,
  data: string,
): string {
  return createHash("md5").update(`${token}&${timestamp}&${appKey}&${data}`).digest("hex");
}

export interface MtopRequest {
  url: string;
  /** 表单体，形如 `data=%7B%7D` */
  body: string;
}

/**
 * 按网页版的样子拼一次请求。
 *
 * 两个细节是照着真实客户端来的，不是随手写的：
 *
 * 1. **`data` 放在表单体里，用 POST**。以前我们把 data 塞在查询串里走 GET —— 网关
 *    对部分接口也认，但发布、改价这类请求体一长，URL 就顶不住了，而且和浏览器
 *    的行为不一致本身就是风控信号。
 * 2. **`accountSite` / `sessionOption` / `spm_cnt` 这几个参数照带**。浏览器每次
 *    都发，少了不一定报错，但没必要让自己看起来与众不同。
 */
export function buildRequest(options: {
  api: string;
  version: string;
  appKey: string;
  token: string;
  timestamp: string;
  data: string;
  host?: string;
}): MtopRequest {
  const { api, version, appKey, token, timestamp, data } = options;
  const query = new URLSearchParams({
    jsv: "2.7.2",
    appKey,
    t: timestamp,
    sign: signRequest(token, timestamp, appKey, data),
    v: version,
    type: "originaljson",
    accountSite: "xianyu",
    dataType: "json",
    timeout: "20000",
    api,
    sessionOption: "AutoLoginOnly",
    spm_cnt: "a21ybx.home.0.0",
  });

  return {
    url: `${options.host ?? MTOP_HOST}/h5/${api}/${version}/?${query.toString()}`,
    body: `data=${encodeURIComponent(data)}`,
  };
}

/** 从 Set-Cookie 或者完整 cookie 串里抠出 `_m_h5_tk` 的 token 部分。 */
export function extractToken(cookie: string): string | null {
  const match = cookie.match(/_m_h5_tk=([^;_]+)_/);
  return match ? match[1] : null;
}

/**
 * `_m_h5_tk` 的格式是 `token_过期毫秒时间戳`，实测有效期大约 90 分钟。
 * 过期了也不致命 —— 网关会返回令牌错误，我们换发一次就能继续。
 */
export function tokenExpiry(cookie: string): number | null {
  const match = cookie.match(/_m_h5_tk=[^;_]+_(\d+)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

export function describeTokenExpiry(cookie: string, now = Date.now()): string {
  const expiry = tokenExpiry(cookie);
  if (expiry === null) return "没有 _m_h5_tk，首次请求会自动换取";
  const minutes = Math.round((expiry - now) / 60_000);
  if (minutes <= 0) return "_m_h5_tk 已过期，首次请求会自动换取";
  return `_m_h5_tk 约 ${minutes} 分钟后过期`;
}

/** 退避重试的等待时间，带一点抖动，别让请求节奏看起来像机器。 */
export function backoffMs(attempt: number, base = 800, jitter = () => Math.random()): number {
  const exponential = base * 2 ** attempt;
  return Math.round(exponential * (0.75 + jitter() * 0.5));
}

export type RetryDecision = "retry" | "refresh_token" | "give_up";

/**
 * 出错之后该怎么办。
 *
 * 风控和登录失效**绝不重试** —— 撞上滑块还继续请求，只会让账号更危险。
 */
export function decideRetry(kind: MtopOutcomeKind, attempt: number, maxAttempts: number): RetryDecision {
  if (kind === "ok") return "give_up";
  if (kind === "risk_control" || kind === "session_expired" || kind === "api_not_found") {
    return "give_up";
  }
  if (attempt >= maxAttempts - 1) return "give_up";
  if (kind === "token_expired") return "refresh_token";
  return "retry";
}
