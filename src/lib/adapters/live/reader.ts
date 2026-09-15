import type { XianyuReader } from "@/lib/adapters/types";
import type { AppState, PlatformSnapshot } from "@/lib/domain/types";
import { credentialStatus } from "./credentials";
import { type LoginState, loadLoginState } from "./login-state";
import { mapListings, mapOrders } from "./mapping";
import {
  GOOFISH_APP_KEY,
  type MtopOutcome,
  backoffMs,
  buildRequestUrl,
  decideRetry,
  extractToken,
  readEnvelope,
} from "./mtop";

/**
 * 接口名从环境变量配，不写死。
 *
 * 只有这两个是我实测确认存在的（未登录调用时网关返回「令牌为空」而不是
 * 「API 不存在」）。消息和订单的接口名没探到，必须你自己抓包填进来 ——
 * 与其硬编码一个猜的名字让它在运行时莫名其妙地失败，不如明确地说「没配」。
 *
 *   npm run xianyu:probe -- --api mtop.xxx   可以验证某个接口名是否存在
 */
export const VERIFIED_ENDPOINTS = {
  listings: "mtop.idle.web.xyh.item.list",
  userHead: "mtop.idle.web.user.page.head",
} as const;

export interface EndpointConfig {
  listings?: string;
  conversations?: string;
  orders?: string;
}

export function endpointConfig(): EndpointConfig {
  return {
    listings: process.env.XIANYU_API_LISTINGS ?? VERIFIED_ENDPOINTS.listings,
    conversations: process.env.XIANYU_API_CONVERSATIONS,
    orders: process.env.XIANYU_API_ORDERS,
  };
}

/** 调用真实通道时可能出现的、需要上层特殊处理的失败。 */
export class LiveChannelError extends Error {
  constructor(
    message: string,
    readonly kind: MtopOutcome["kind"] | "not_configured",
  ) {
    super(message);
    this.name = "LiveChannelError";
  }
}

interface CallOptions {
  api: string;
  version?: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  /** 注入用，方便测试退避而不用真的等 */
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  /** 注入用，省得测试里去读文件 */
  loginState?: LoginState;
}

const defaultSleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 发一次 MTOP 请求，带退避重试。
 *
 * 风控和登录失效**绝不重试**：撞上滑块还继续请求，只会让账号更危险。
 */
export async function callMtop(options: CallOptions): Promise<MtopOutcome> {
  const {
    api,
    version = "1.0",
    payload = {},
    maxAttempts = 3,
    sleep = defaultSleep,
    fetchImpl = fetch,
  } = options;

  const loginState = options.loginState ?? (await loadLoginState());
  if (!loginState?.cookie) {
    throw new LiveChannelError(
      "还没有导入登录态。用扩展导出后跑 npm run xianyu:login 导入。",
      "not_configured",
    );
  }

  let cookie = loginState.cookie;
  const data = JSON.stringify(payload);
  let last: MtopOutcome = { kind: "other", ret: "", message: "还没发出任何请求" };

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const token = extractToken(cookie) ?? "";
    const url = buildRequestUrl({
      api,
      version,
      appKey: GOOFISH_APP_KEY,
      token,
      timestamp: String(Date.now()),
      data,
    });

    const response = await fetchImpl(url, {
      // 带上当初登录那个浏览器的请求头。cookie 和 User-Agent 对不上，
      // 本身就是风控的典型触发条件。
      headers: {
        accept: "application/json",
        referer: "https://www.goofish.com/",
        ...loginState.headers,
        cookie,
      },
      signal: AbortSignal.timeout(15_000),
    });

    // 网关换发新 token 时会带 Set-Cookie，下一次请求要用新的
    const setCookie = response.headers.get("set-cookie");
    if (setCookie?.includes("_m_h5_tk")) {
      cookie = mergeCookie(cookie, setCookie);
    }

    last = readEnvelope((await response.json()) as Record<string, unknown>);
    if (last.kind === "ok") return last;

    const decision = decideRetry(last.kind, attempt, maxAttempts);
    if (decision === "give_up") return last;
    await sleep(backoffMs(attempt));
  }

  return last;
}

/** 用新的 Set-Cookie 覆盖同名字段，其余原样保留。 */
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

function explain(outcome: MtopOutcome, api: string): LiveChannelError {
  const hints: Record<string, string> = {
    risk_control: `撞上平台风控（${api}）。已经停手，请去 App 里手动操作一次，过一阵再试。`,
    session_expired: `登录态失效（${api}），需要重新扫码登录并更新 XIANYU_COOKIE。`,
    token_expired: `换取 _m_h5_tk 失败（${api}），cookie 可能不完整。`,
    rate_limited: `被平台限流（${api}），退避后仍未恢复。`,
    api_not_found: `接口 ${api} 不存在，请用 npm run xianyu:probe 确认接口名。`,
  };
  return new LiveChannelError(
    hints[outcome.kind] ?? `调用 ${api} 失败：${outcome.ret || outcome.message}`,
    outcome.kind,
  );
}

/**
 * 真实读通道。
 *
 * 只读 —— 它没有任何写操作。写操作走 `XianyuAdapter`，而且必须穿过
 * `GuardedAdapter` 的护栏。
 */
export class LiveXianyuReader implements XianyuReader {
  readonly id = "live";
  readonly label = "真实闲鱼账号";
  readonly isMock = false;

  async fetchSnapshot(state: AppState, now: number): Promise<PlatformSnapshot> {
    const credentials = await credentialStatus();
    if (!credentials.configured) {
      throw new LiveChannelError(credentials.detail, "not_configured");
    }

    const endpoints = endpointConfig();
    if (!endpoints.listings) {
      throw new LiveChannelError("没有配置商品列表接口。", "not_configured");
    }

    const listingsOutcome = await callMtop({
      api: endpoints.listings,
      payload: { pageNumber: 1, pageSize: 40 },
    });
    if (listingsOutcome.kind !== "ok") throw explain(listingsOutcome, endpoints.listings);

    const listings = mapListings(listingsOutcome.data, now);

    // 消息和订单接口没配就先不抓，保留本地已有的，而不是把它们清空
    let orders = state.orders;
    if (endpoints.orders) {
      const ordersOutcome = await callMtop({
        api: endpoints.orders,
        payload: { pageNumber: 1, pageSize: 30 },
      });
      if (ordersOutcome.kind !== "ok") throw explain(ordersOutcome, endpoints.orders);
      const mapped = mapOrders(ordersOutcome.data, now);
      if (mapped.items.length > 0) orders = mapped.items;
    }

    return {
      fetchedAt: new Date(now).toISOString(),
      listings: listings.items.length > 0 ? listings.items : state.listings,
      // 会话接口还没探到，先保留本地的，不假装同步过
      conversations: state.conversations,
      orders,
    };
  }
}

export const liveXianyuReader = new LiveXianyuReader();
