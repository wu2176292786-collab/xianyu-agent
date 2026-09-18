import { type LoginState, loadLoginState } from "./login-state";
import {
  GOOFISH_APP_KEY,
  type MtopOutcome,
  backoffMs,
  buildRequest,
  decideRetry,
  extractToken,
  readEnvelope,
} from "./mtop";

/** 调用真实通道时需要上层区别处理的失败。 */
export class LiveChannelError extends Error {
  constructor(
    message: string,
    readonly kind: MtopOutcome["kind"] | "not_configured",
  ) {
    super(message);
    this.name = "LiveChannelError";
  }
}

export interface MtopCallOptions {
  api: string;
  version?: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  /** 注入用，方便测试退避而不用真的等。 */
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  /**
   * 显式传 null 表示没有登录态；测试不得因此回读本机真实凭证。
   */
  loginState?: LoginState | null;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 真实 MTop 请求的唯一入口：签名、登录态、token 刷新及退避都在这里。
 * 风控和登录失效绝不重试，调用方只决定业务请求和结果如何映射。
 */
export async function callMtop(options: MtopCallOptions): Promise<MtopOutcome> {
  const {
    api,
    version = "1.0",
    payload = {},
    maxAttempts = 3,
    sleep = defaultSleep,
    fetchImpl = fetch,
  } = options;

  const loginState =
    options.loginState !== undefined ? options.loginState : await loadLoginState();
  if (!loginState?.cookie) {
    throw new LiveChannelError(
      "还没有导入登录态。到「自动化 → 账号登录」粘贴扩展导出的内容。",
      "not_configured",
    );
  }

  let cookie = loginState.cookie;
  const data = JSON.stringify(payload);
  let last: MtopOutcome = { kind: "other", ret: "", message: "还没发出任何请求" };

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const token = extractToken(cookie) ?? "";
    const request = buildRequest({
      api,
      version,
      appKey: GOOFISH_APP_KEY,
      token,
      timestamp: String(Date.now()),
      data,
    });
    const response = await fetchImpl(request.url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://www.goofish.com",
        referer: "https://www.goofish.com/",
        ...loginState.headers,
        cookie,
      },
      body: request.body,
      signal: AbortSignal.timeout(15_000),
    });

    const setCookie = response.headers.get("set-cookie");
    if (setCookie?.includes("_m_h5_tk")) cookie = mergeCookie(cookie, setCookie);

    last = readEnvelope((await response.json()) as Record<string, unknown>);
    if (last.kind === "ok") return last;
    if (decideRetry(last.kind, attempt, maxAttempts) === "give_up") return last;
    await sleep(backoffMs(attempt));
  }
  return last;
}

/** 读取 cookie 单字段；值可能经过 URL 编码。 */
export function cookieField(cookie: string, name: string): string | undefined {
  const raw = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))?.[1];
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function selfUserId(cookie: string): string | undefined {
  return cookieField(cookie, "unb");
}

/** 用新的 Set-Cookie 覆盖同名字段，其余字段原样保留。 */
export function mergeCookie(cookie: string, setCookie: string): string {
  const updates = new Map<string, string>();
  for (const chunk of setCookie.split(/,(?=\s*[^;=]+=)/)) {
    const [pair] = chunk.split(";");
    const index = pair.indexOf("=");
    if (index > 0) updates.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }

  const kept = cookie
    .split(";")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const index = pair.indexOf("=");
      const name = index > 0 ? pair.slice(0, index) : pair;
      if (updates.has(name)) {
        const value = `${name}=${updates.get(name)}`;
        updates.delete(name);
        return value;
      }
      return pair;
    });

  for (const [name, value] of updates) kept.push(`${name}=${value}`);
  return kept.join("; ");
}
