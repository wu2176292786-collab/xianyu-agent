import type { XianyuReader } from "@/lib/adapters/types";
import {
  FRESH_REPLY_WINDOW_MS,
  RECENT_CHAT_WINDOW_MS,
  lastActivityAt,
} from "@/lib/agent/reply";
import type { AppState, Conversation, Listing, PlatformSnapshot } from "@/lib/domain/types";
import { credentialStatus } from "./credentials";
import { listImHistories } from "./im";
import { loadLoginState } from "./login-state";
import {
  type ItemGroup,
  describeItemGroups,
  inferMessagePeer,
  mapConversations,
  mapItemGroups,
  mapListings,
  mapMessages,
  mapOrders,
  mapProfileNick,
  mergeInboxConversations,
  readListingCard,
  readListingMetrics,
} from "./mapping";
import { type MtopOutcome } from "./mtop";
import {
  LiveChannelError,
  callMtop,
  cookieField,
  selfUserId,
} from "./mtop-client";

// 旧调用方暂时仍可从 reader 引入；新代码应直接使用 mtop-client。
export {
  LiveChannelError,
  callMtop,
  cookieField,
  mergeCookie,
  selfUserId,
} from "./mtop-client";

/**
 * 接口名从环境变量配，不写死。
 *
 * 只有列在 VERIFIED_ENDPOINTS 里的是实测确认存在的（未登录调用时网关返回
 * 「令牌为空」而不是「API 不存在」）。卖出订单的接口名还没探到，必须你
 * 自己抓包填进来 —— 与其硬编码一个猜的名字让它在运行时莫名其妙地失败，
 * 不如明确地说「没配」。
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
  /** 网页搜索。只在你点「看对手」时打，页数可改，不后台轮询。 */
  search: "mtop.taobao.idlemtopsearch.pc.search",
  /** 网页 IM 令牌，发私信前换 accessToken */
  imToken: "mtop.taobao.idlemessage.pc.login.token",
} as const;

export interface Endpoint {
  api: string;
  version: string;
}

export interface EndpointConfig {
  listings?: Endpoint;
  conversations?: Endpoint;
  /** 某个会话的历史消息 */
  messages?: Endpoint;
  orders?: Endpoint;
  /** 商品详情，用来补列表接口不给的热度数据 / 会话关联商品标题 */
  itemDetail?: Endpoint;
  /** 搜索同类。只给用户点出来的「看对手」用。 */
  search?: Endpoint;
}

/** 读通道逐件补数的节流；请求重试的退避由 mtop-client 管理。 */
const readerSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
    messages:
      parseEndpoint(process.env.XIANYU_API_MESSAGES) ??
      ({ api: VERIFIED_ENDPOINTS.messages, version: "1.0" } as const),
    // 卖出订单的接口名还没确认。买到的是 mtop.idle.web.trade.bought.list，
    // 但那不是卖家要的东西，硬用会把买家订单当成自己的销售单。
    orders: parseEndpoint(process.env.XIANYU_API_ORDERS),
    itemDetail:
      parseEndpoint(process.env.XIANYU_API_ITEM_DETAIL) ??
      ({ api: VERIFIED_ENDPOINTS.itemDetail, version: "1.0" } as const),
    search:
      parseEndpoint(process.env.XIANYU_API_SEARCH) ??
      ({ api: VERIFIED_ENDPOINTS.search, version: "1.0" } as const),
  };
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
 * 一次同步最多拉几个会话的历史。每个会话一次请求，打太多是风控信号。
 * 只补最近还在聊的，按最后一条时间倒序 —— 最新的先拿。
 */
const MAX_HISTORY = 15;

/** 一次同步最多给几条会话补商品标题。同样是一件一次请求。 */
const MAX_TITLE_LOOKUPS = 15;

/**
 * 给会话补上完整聊天记录。
 *
 * 会话列表只给最后一条摘要。HTTP 的 `message.sync` 现在会回 FAIL_BIZ_120，
 * 历史改走网页 IM 的 `/r/MessageManager/listUserMessages`。
 * 风控立刻停手。
 */
async function loadInbox(
  httpItems: Conversation[],
  existing: Conversation[],
  selfUserId: string | undefined,
  selfNicks: string[],
  now: number,
): Promise<{ conversations: Conversation[]; historyFilled: number }> {
  const recentIds = [...httpItems, ...existing]
    .filter((conversation) => now - lastActivityAt(conversation) <= RECENT_CHAT_WINDOW_MS)
    .sort((a, b) => lastActivityAt(b) - lastActivityAt(a))
    .map((conversation) => conversation.id);

  const history = await listImHistories(recentIds.slice(0, MAX_HISTORY), {
    now,
    collectMs: 5_000,
    maxConversations: MAX_HISTORY,
  });
  if (history.riskControl) {
    throw new LiveChannelError(history.message, "risk_control");
  }

  const conversations = mergeInboxConversations(httpItems, history.sessions, existing);
  let filled = 0;
  for (const conversation of conversations) {
    const payload = history.payloads.get(conversation.id);
    if (!payload) continue;

    const inferred = inferMessagePeer(payload, selfUserId, selfNicks);
    const peer = {
      peerId: conversation.buyerId ?? inferred.peerId,
      peerNicks: [
        ...(conversation.buyerName && conversation.buyerName !== "买家"
          ? [conversation.buyerName]
          : []),
        ...(inferred.peerNicks ?? []),
      ],
    };
    const mapped = mapMessages(payload, now, selfUserId, selfNicks, peer);
    if (mapped.items.length === 0) continue;

    conversation.messages = mapped.items;
    conversation.buyerId = peer.peerId ?? conversation.buyerId;
    const peerNick = peer.peerNicks.find((name) => name && name !== "买家");
    if (peerNick) conversation.buyerName = peerNick;
    if (conversation.status !== "closed") {
      const last = mapped.items.at(-1);
      const lastAt = last ? Date.parse(last.createdAt) : 0;
      conversation.status =
        last?.author === "buyer" && now - lastAt <= FRESH_REPLY_WINDOW_MS
          ? "needs_reply"
          : "awaiting_buyer";
    }
    filled += 1;
  }

  conversations.sort((left, right) => lastActivityAt(right) - lastActivityAt(left));
  return {
    conversations: conversations.filter((conversation) => conversation.messages.length > 0),
    historyFilled: filled,
  };
}

/**
 * 给对不上本店库存的会话补商品标题。
 *
 * 会话只带 itemId。很多会话谈的不是当前在架的货，对不上 listings 是常态，
 * 不能因此在消息页写成「未知商品」。标题挂在会话上，不写进本店商品列表。
 */
async function enrichConversationListings(
  conversations: Conversation[],
  listings: Listing[],
  endpoint: Endpoint,
  sleep: (ms: number) => Promise<void>,
): Promise<number> {
  const known = new Set(listings.map((listing) => listing.id));
  const targets = [...conversations]
    .filter(
      (conversation) =>
        conversation.listingId &&
        !known.has(conversation.listingId) &&
        !conversation.listingTitle,
    )
    .sort((a, b) => lastActivityAt(b) - lastActivityAt(a))
    .slice(0, MAX_TITLE_LOOKUPS);

  let filled = 0;
  for (const conversation of targets) {
    const outcome = await callMtop({
      api: endpoint.api,
      version: endpoint.version,
      payload: { itemId: conversation.listingId },
    });
    if (outcome.kind === "risk_control") throw explain(outcome, endpoint.api);
    if (outcome.kind !== "ok") continue;

    const card = readListingCard(outcome.data);
    if (!card.title) continue;
    conversation.listingTitle = card.title;
    if (card.priceCents !== undefined) conversation.listingPriceCents = card.priceCents;
    filled += 1;
    await sleep(400);
  }
  return filled;
}

/**
 * 真实读通道。
 *
 * 只负责拉商品和会话。写操作走 `LiveXianyuAdapter`，而且必须穿过
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

    const sameAccount = !state.settings.accountUserId || state.settings.accountUserId === userId;
    const listings = await fetchAllListings(endpoints.listings, userId, now);

    // 列表接口不给热度数据，只能对在售商品逐件补
    if (endpoints.itemDetail) {
      await enrichOnSaleMetrics(listings.items, endpoints.itemDetail, readerSleep);
    }

    // 账号显示名先拿：后面认「哪条消息是自己发的」要用到昵称。
    // 拿不到不算失败 —— 少一个店铺名而已，不该让整次同步白跑。
    let shopName: string | undefined;
    const headOutcome = await callMtop({
      api: VERIFIED_ENDPOINTS.userHead,
      payload: { userId, self: true },
    });
    if (headOutcome.kind === "ok") shopName = mapProfileNick(headOutcome.data);

    const selfNicks = [shopName, cookieField(loginState?.cookie ?? "", "tracknick")].filter(
      (nick): nick is string => Boolean(nick?.trim()),
    );

    // 会话列表只认 fetchNum。真人私聊经常不在这次返回里，要靠 IM 长连补。
    let conversations = state.conversations;
    let historyFilled = 0;
    let titlesFilled = 0;
    if (endpoints.conversations) {
      const outcome = await callMtop({
        api: endpoints.conversations.api,
        version: endpoints.conversations.version,
        payload: { fetchNum: 50 },
      });
      if (outcome.kind !== "ok") throw explain(outcome, endpoints.conversations.api);
      const mapped = mapConversations(outcome.data, now, userId);
      const inbox = await loadInbox(
        mapped.items,
        sameAccount ? state.conversations : [],
        userId,
        selfNicks,
        now,
      );
      conversations = inbox.conversations;
      historyFilled = inbox.historyFilled;

      if (endpoints.itemDetail && conversations.length > 0) {
        titlesFilled = await enrichConversationListings(
          conversations,
          listings.items,
          endpoints.itemDetail,
          readerSleep,
        );
      }
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
    const notes = [
      describeItemGroups(listings.groups),
      historyFilled > 0 ? `补了 ${historyFilled} 个最近会话的聊天记录` : undefined,
      titlesFilled > 0 ? `认出 ${titlesFilled} 件会话关联商品` : undefined,
    ].filter((note): note is string => note !== undefined);

    return {
      fetchedAt: new Date(now).toISOString(),
      listings: listings.items.length > 0 || !sameAccount ? listings.items : state.listings,
      conversations,
      orders,
      notes,
      shopName,
      accountUserId: userId,
    };
  }
}

export const liveXianyuReader = new LiveXianyuReader();
