import type { XianyuReader } from "@/lib/adapters/types";
import type { AppState, Listing, PlatformSnapshot } from "@/lib/domain/types";
import { credentialStatus } from "./credentials";
import { type LoginState, loadLoginState } from "./login-state";
import {
  type ItemGroup,
  describeItemGroups,
  mapConversations,
  mapItemGroups,
  mapListings,
  mapOrders,
  readListingMetrics,
} from "./mapping";
import {
  GOOFISH_APP_KEY,
  type MtopOutcome,
  backoffMs,
  buildRequest,
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
  /**
   * 会话列表。名字和版本号是从闲鱼网页版自己的打包产物里读出来的
   * （`mtop.taobao.idlemessage.pc.session.sync`，v3.0，needLogin）。
   *
   * 之前一直没探到这个接口，是因为我们照着「订单列表」的思路去猜名字，
   * 而闲鱼的私信走的是另一套 `idlemessage` 命名空间。
   */
  conversations: "mtop.taobao.idlemessage.pc.session.sync",
  /** 某个会话里的历史消息，v1.0 */
  messages: "mtop.taobao.idlemessage.pc.message.sync",
  /** 商品详情，带 `{"itemId":"..."}` */
  itemDetail: "mtop.taobao.idle.pc.detail",
} as const;

export interface Endpoint {
  api: string;
  version: string;
}

export interface EndpointConfig {
  listings?: Endpoint;
  conversations?: Endpoint;
  orders?: Endpoint;
  /** 商品详情，用来补列表接口不给的热度数据 */
  itemDetail?: Endpoint;
}

/** `mtop.xxx` 或者 `mtop.xxx@3.0`，后者用来覆盖版本号。 */
function parseEndpoint(raw: string | undefined, fallbackVersion = "1.0"): Endpoint | undefined {
  if (!raw?.trim()) return undefined;
  const [api, version] = raw.trim().split("@");
  return { api, version: version?.trim() || fallbackVersion };
}

export function endpointConfig(): EndpointConfig {
  return {
    listings:
      parseEndpoint(process.env.XIANYU_API_LISTINGS) ??
      ({ api: VERIFIED_ENDPOINTS.listings, version: "1.0" } as const),
    conversations:
      parseEndpoint(process.env.XIANYU_API_CONVERSATIONS, "3.0") ??
      ({ api: VERIFIED_ENDPOINTS.conversations, version: "3.0" } as const),
    // 卖出订单的接口名还没确认。买到的是 mtop.idle.web.trade.bought.list，
    // 但那不是卖家要的东西，硬用会把买家订单当成自己的销售单。
    orders: parseEndpoint(process.env.XIANYU_API_ORDERS),
    itemDetail:
      parseEndpoint(process.env.XIANYU_API_ITEM_DETAIL) ??
      ({ api: VERIFIED_ENDPOINTS.itemDetail, version: "1.0" } as const),
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
  /**
   * 注入用，省得测试里去读文件。
   *
   * 显式传 `null` 表示「就是没有登录态」—— 测试必须能表达这个意思，
   * 否则它会退回去读 `.secrets/`，在开发者自己机器上拿真凭证打真网关。
   */
  loginState?: LoginState | null;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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

  const loginState =
    options.loginState !== undefined ? options.loginState : await loadLoginState();
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
      // 带上当初登录那个浏览器的请求头。cookie 和 User-Agent 对不上，
      // 本身就是风控的典型触发条件。
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

/**
 * 我自己的用户 id，藏在 cookie 的 `unb` 里。
 *
 * 两个地方少不了它：商品列表接口要 `userId` 才肯返回（不给就是
 * `FAIL_BIZ_BAD_REQUEST`），会话列表要靠它认出哪一边是对方。
 */
export function selfUserId(cookie: string): string | undefined {
  return cookie.match(/(?:^|;\s*)unb=([^;]+)/)?.[1];
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
 * 每页最多能拿多少件。
 *
 * 填 40 会被拒：`FAIL_BIZ_FORBIDDEN::||最大可查看页数或者每页最大可查看商品数超限`。
 * 20 是网页版自己用的值，实测可以。
 */
const LISTINGS_PAGE_SIZE = 20;

/** 翻页上限。真要有人挂着几百件，也不该一次同步把请求打成一片。 */
const MAX_LISTING_PAGES = 5;

/**
 * 把商品列表翻完。
 *
 * 只拿第一页的话，商品超过 20 件就会静默漏掉后面的 —— 合并逻辑不会删本地
 * 已有的，但新商品永远进不来，而你从界面上看不出少了东西。
 */
async function fetchAllListings(
  endpoint: Endpoint,
  userId: string,
  now: number,
): Promise<{ items: Listing[]; skipped: number; groups: ItemGroup[] }> {
  const items: Listing[] = [];
  let skipped = 0;
  let groups: ItemGroup[] = [];

  for (let page = 1; page <= MAX_LISTING_PAGES; page += 1) {
    // userId + pageNumber + pageSize 三个都必填，少一个就是 FAIL_BIZ_BAD_REQUEST。
    // needGroupInfo 只在第一页要 —— 它让平台顺便报出各分组的件数。
    const outcome = await callMtop({
      api: endpoint.api,
      version: endpoint.version,
      payload: {
        userId,
        pageNumber: page,
        pageSize: LISTINGS_PAGE_SIZE,
        ...(page === 1 ? { needGroupInfo: true } : {}),
      },
    });
    if (outcome.kind !== "ok") throw explain(outcome, endpoint.api);

    if (page === 1) groups = mapItemGroups(outcome.data);

    const mapped = mapListings(outcome.data, now);
    items.push(...mapped.items);
    skipped += mapped.skipped;

    const more = (outcome.data as { nextPage?: unknown } | undefined)?.nextPage;
    // 没有下一页、或者这一页压根没返回东西，就收工
    if (more !== true && more !== 1) break;
    if (mapped.items.length === 0) break;
  }

  return { items, skipped, groups };
}

/**
 * 一次同步最多补几件商品的热度数据。
 *
 * 一件一次请求，所以有上限 —— 同步一次打几十个请求，本身就是风控信号。
 */
const MAX_ENRICHED = 20;

/**
 * 给在售商品补上浏览 / 想要 / 库存。
 *
 * 商品列表接口不给这些数，详情接口给。只对**在售**商品做：已售出的商品这些
 * 数字对决策没有意义，而每件都要一次请求。
 *
 * 补不到的就保持 `metricsUnknown`，让降价规则继续绕开它 ——
 * 宁可不降价，也不拿一个没拿到的数字去降。
 */
async function enrichOnSaleMetrics(
  listings: Listing[],
  endpoint: Endpoint,
  sleep: (ms: number) => Promise<void>,
): Promise<number> {
  const targets = listings.filter((l) => l.status === "on_sale").slice(0, MAX_ENRICHED);
  let enriched = 0;

  for (const listing of targets) {
    const outcome = await callMtop({
      api: endpoint.api,
      version: endpoint.version,
      payload: { itemId: listing.id },
    });
    // 单件失败不该让整次同步失败 —— 少一件的热度数据，不如把其余的先拿回来。
    // 但风控必须立刻停手，继续打请求只会让账号更危险。
    if (outcome.kind === "risk_control") throw explain(outcome, endpoint.api);
    if (outcome.kind !== "ok") continue;

    const metrics = readListingMetrics(outcome.data);
    if (metrics.views7d === undefined && metrics.wants === undefined) continue;

    if (metrics.views7d !== undefined) listing.views7d = metrics.views7d;
    if (metrics.wants !== undefined) listing.wants = metrics.wants;
    if (metrics.stock !== undefined) listing.stock = metrics.stock;
    listing.metricsUnknown = false;
    enriched += 1;

    await sleep(400);
  }

  return enriched;
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

    const loginState = await loadLoginState();
    const userId = loginState?.cookie ? selfUserId(loginState.cookie) : undefined;
    if (!userId) {
      throw new LiveChannelError(
        "cookie 里没有 unb（用户 id），商品列表接口不会返回数据。重新导出一次登录态。",
        "not_configured",
      );
    }

    const listings = await fetchAllListings(endpoints.listings, userId, now);

    // 列表接口不给热度数据，只能对在售商品逐件补
    if (endpoints.itemDetail) {
      await enrichOnSaleMetrics(listings.items, endpoints.itemDetail, defaultSleep);
    }

    // 会话列表只认 fetchNum 这一个必填参数；系统会话在映射层按 sessionType 过滤
    let conversations = state.conversations;
    if (endpoints.conversations) {
      const outcome = await callMtop({
        api: endpoints.conversations.api,
        version: endpoints.conversations.version,
        payload: { fetchNum: 30 },
      });
      if (outcome.kind !== "ok") throw explain(outcome, endpoints.conversations.api);
      const mapped = mapConversations(outcome.data, now, userId);
      if (mapped.items.length > 0) conversations = mapped.items;
    }

    // 卖出订单的接口名还没确认，没配就保留本地的，而不是把它们清空
    let orders = state.orders;
    if (endpoints.orders) {
      const ordersOutcome = await callMtop({
        api: endpoints.orders.api,
        version: endpoints.orders.version,
        payload: { pageNumber: 1, pageSize: 30 },
      });
      if (ordersOutcome.kind !== "ok") throw explain(ordersOutcome, endpoints.orders.api);
      const mapped = mapOrders(ordersOutcome.data, now);
      if (mapped.items.length > 0) orders = mapped.items;
    }

    // 平台自己报的分组件数。同步回来全是已售出时，这一句就能说清是
    // 「接口不对」还是「确实一件在售的都没有」。
    const notes = [describeItemGroups(listings.groups)].filter(
      (note): note is string => note !== undefined,
    );

    return {
      fetchedAt: new Date(now).toISOString(),
      listings: listings.items.length > 0 ? listings.items : state.listings,
      conversations,
      orders,
      notes,
    };
  }
}

export const liveXianyuReader = new LiveXianyuReader();
