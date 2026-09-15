import type { Conversation, Listing, Order, OrderStatus } from "@/lib/domain/types";
import { getList, pickNumber, pickString } from "./paths";

/**
 * 把真实接口的响应映射成我们的领域模型。
 *
 * 字段名全部用候选列表，是因为淘系接口的返回结构没有公开文档，只能靠抓包，
 * 而且会变。命中不了就跳过这条记录，绝不硬塞一个猜出来的值进去 ——
 * 一个编出来的价格比没有数据危险得多。
 */
/**
 * 列表可能在的位置。
 *
 * **裸路径和 `data.` 前缀都要给。** 网关的响应是 `{ret, data}`，而 reader 往
 * 映射层传的是已经剥掉信封的 `data` 本身 —— 只写 `data.cardList` 的话就变成
 * 了 `data.data.cardList`，永远取不到，同步会安静地说「没有变化」。
 * 这个 bug 之前没被测出来，因为测试传的是整个信封。
 */
const LIST_PATHS = [
  "cardList",
  "items",
  "itemList",
  "list",
  "data.cardList",
  "data.items",
  "data.itemList",
  "data.result",
  "data.list",
  "data.model.items",
];

const ITEM_ID = ["cardData.id", "cardData.itemId", "itemId", "id", "item.itemId"];
const ITEM_TITLE = ["cardData.title", "title", "item.title", "content.title"];
const ITEM_PRICE_YUAN = [
  "cardData.priceInfo.price",
  "cardData.price",
  "price",
  "item.price",
  "soldPrice",
];
const ITEM_PRICE_CENTS = ["cardData.priceCent", "priceCent", "priceCents"];
const ITEM_STOCK = ["cardData.quantity", "quantity", "stock", "item.quantity"];
const ITEM_VIEWS = ["cardData.browseCnt", "browseCnt", "viewCount", "pv"];
const ITEM_WANTS = ["cardData.wantCnt", "wantCnt", "collectCount", "wantCount"];
const ITEM_STATUS = ["cardData.itemStatus", "itemStatus", "status"];

function toCents(record: unknown): number | undefined {
  const cents = pickNumber(record, ITEM_PRICE_CENTS);
  if (cents !== undefined) return Math.round(cents);
  const yuan = pickNumber(record, ITEM_PRICE_YUAN);
  return yuan === undefined ? undefined : Math.round(yuan * 100);
}

/**
 * 淘系的状态码是 `WAIT_BUYER_PAY` 这种下划线写法，匹配前先把分隔符去掉，
 * 否则 `waitbuyer` 这类子串永远匹配不上。
 */
function normalizeCode(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** 平台的商品状态码没有公开定义，只认我们确定的几种，其余一律当在售。 */
function toListingStatus(raw: string | undefined): Listing["status"] {
  if (!raw) return "on_sale";
  const value = normalizeCode(raw);
  if (value.includes("sold") || value === "1") return "sold_out";
  if (value.includes("delist") || value.includes("offshelf") || value === "2") {
    return "delisted";
  }
  return "on_sale";
}

export interface MapResult<T> {
  items: T[];
  /** 没认出来的记录数，界面上要如实显示，不能假装同步很完美 */
  skipped: number;
  /** 认出来了但故意不收的记录数（比如系统通知会话） */
  ignored?: number;
}

export function mapListings(payload: unknown, now: number): MapResult<Listing> {
  let records: unknown[] = [];
  for (const path of LIST_PATHS) {
    records = getList(payload, path);
    if (records.length > 0) break;
  }

  const items: Listing[] = [];
  let skipped = 0;

  for (const record of records) {
    const id = pickString(record, ITEM_ID);
    const title = pickString(record, ITEM_TITLE);
    const priceCents = toCents(record);

    // id、标题、价格缺一不可 —— 认不出来就跳过，不编造
    if (!id || !title || priceCents === undefined) {
      skipped += 1;
      continue;
    }

    const stock = pickNumber(record, ITEM_STOCK);
    const views = pickNumber(record, ITEM_VIEWS);
    const wants = pickNumber(record, ITEM_WANTS);

    items.push({
      id,
      title,
      category: "",
      emoji: "📦",
      priceCents,
      // 底价平台上没有，只能先按九折估，并且标成未确认
      floorPriceCents: Math.round((priceCents * 0.9) / 100) * 100,
      floorConfirmed: false,
      costCents: 0,
      stock: stock ?? 1,
      status: toListingStatus(pickString(record, ITEM_STATUS)),
      createdAt: new Date(now).toISOString(),
      lastRefreshedAt: new Date(now).toISOString(),
      views7d: views ?? 0,
      wants: wants ?? 0,
      inquiries7d: 0,
      tags: [],
      // 真实的商品列表接口只回标题、价格、状态，没有热度数据。
      // 标出来，好让降价规则知道这几个 0 是占位的，不是「真的没人看」。
      metricsUnknown: views === undefined && wants === undefined,
    });
  }

  return { items, skipped };
}

/* ── 会话（mtop.taobao.idlemessage.pc.session.sync）────────────────────── */

/** 同样要给裸路径 —— reader 传进来的是剥掉信封之后的 data 本身。 */
const SESSION_LIST_PATHS = [
  "sessions",
  "sessionList",
  "data.sessions",
  "data.sessionList",
  "data.list",
  "data.result",
  "data.modules.sessions",
];

const SESSION_ID = ["session.sessionId", "sessionId", "cid", "id"];
const SESSION_TYPE = ["session.sessionType", "sessionType"];
const SESSION_ITEM_ID = ["session.itemInfo.itemId", "itemId", "bizId", "item.itemId"];
const SESSION_LAST_TEXT = [
  "message.summary.summary",
  "lastMessageContent",
  "lastMsgContent",
  "content",
  "summary",
];
const SESSION_LAST_AT = [
  "message.summary.ts",
  "lastMessageTime",
  "lastMsgTime",
  "modifyTime",
];
const SESSION_UNREAD = ["message.summary.unread", "unreadCount", "unread"];

/** 两侧的身份信息。谁是对方，取决于哪一边的 userId 不是我。 */
const SESSION_SIDES = [
  { id: "session.userInfo.userId", nick: ["session.userInfo.nick", "session.userInfo.fishNick"] },
  {
    id: "session.ownerInfo.userId",
    nick: ["session.ownerInfo.nick", "session.ownerInfo.fishNick"],
  },
] as const;

/**
 * 结构变了之后的兜底昵称。
 *
 * 只收名字里明确写着「对方」的字段。`nick`、`userNick` 这种不收 ——
 * 它们既可能是买家也可能是我，认错了就会拿我自己的昵称去标会话。
 */
const SESSION_PEER_FALLBACK = ["peerUserNick", "targetNick", "peerNick"];

/**
 * 只收买家私聊。
 *
 * 实测返回里混着一堆系统会话（`sessionType` 23 / 25 / 62 之类，没有 itemId）：
 * 官方通知、物流提醒、活动推送。把它们收进来，Agent 就会一本正经地给
 * 「闲鱼小助手」起草回复。单聊是 1，这是网页版自己也在用的过滤条件。
 */
const SINGLE_CHAT = 1;

/**
 * 会话列表 → 领域模型。
 *
 * 只能还原出「最后一条消息」这一条记录 —— 会话列表接口本来就只给摘要
 * （`message.summary.summary`）。完整对话要另外调
 * `mtop.taobao.idlemessage.pc.message.sync`，所以这里**不假装拿到了完整聊天记录**。
 *
 * 谁是买家：实测 `ownerInfo` **不一定是我** —— 有的会话里我在 `userInfo` 那边。
 * 所以对方只能靠「userId 不等于我的 unb」来认。认不出我自己的 id 时退回
 * `userInfo`，因为绝大多数会话里它就是对方。
 *
 * 最后一条是谁说的：摘要里没有发送者 id，只能按未读数判断 —— 未读 > 0 就是
 * 买家刚说过话。不完美，但比瞎猜作者老实：至少不会把自己发的话当成买家提问，
 * 让 Agent 去回复自己。
 */
export function mapConversations(
  payload: unknown,
  now: number,
  selfUserId?: string,
): MapResult<Conversation> {
  let records: unknown[] = [];
  for (const path of SESSION_LIST_PATHS) {
    records = getList(payload, path);
    if (records.length > 0) break;
  }

  const items: Conversation[] = [];
  let skipped = 0;
  let ignored = 0;

  for (const record of records) {
    const type = pickNumber(record, SESSION_TYPE);
    if (type !== undefined && type !== SINGLE_CHAT) {
      ignored += 1;
      continue;
    }

    const id = pickString(record, SESSION_ID);
    const text = pickString(record, SESSION_LAST_TEXT);
    // 会话 id 和最后一条消息缺任何一个都没法用：没有 id 无从对齐，
    // 没有文本就没有可判断意图的内容
    if (!id || !text) {
      skipped += 1;
      continue;
    }

    const peer =
      SESSION_SIDES.find((side) => {
        const sideId = pickString(record, [side.id]);
        return sideId !== undefined && sideId !== selfUserId;
      }) ?? SESSION_SIDES[0];
    const buyerName =
      pickString(record, [...peer.nick]) ?? pickString(record, SESSION_PEER_FALLBACK) ?? "买家";

    const unread = pickNumber(record, SESSION_UNREAD) ?? 0;
    const at = pickNumber(record, SESSION_LAST_AT);

    items.push({
      id,
      buyerName,
      buyerEmoji: "🐟",
      listingId: pickString(record, SESSION_ITEM_ID) ?? "",
      status: unread > 0 ? "needs_reply" : "awaiting_buyer",
      // 意图由 runTick 按文本重新判定，这里不猜
      intent: "other",
      messages: [
        {
          id: `${id}-last`,
          author: unread > 0 ? "buyer" : "seller",
          text,
          createdAt: new Date(at && at > 1_000_000_000_000 ? at : now).toISOString(),
        },
      ],
    });
  }

  return { items, skipped, ignored };
}

/* ── 商品分组（xyh.item.list 带 needGroupInfo 时返回）────────────────────── */

const GROUP_LIST_PATHS = ["itemGroupList", "data.itemGroupList"];

export interface ItemGroup {
  name: string;
  itemNumber: number;
}

/**
 * 读平台自己报的分组件数。
 *
 * 个人主页把商品分成「综合 / 在售 / 已售出 / 包邮」，每组带 `itemNumber`。
 * 这个数字很值钱：同步回来全是已售出的时候，它能直接告诉你是「接口不对」
 * 还是「确实一件在售的都没有」—— 不用再去猜接口名和参数。
 */
export function mapItemGroups(payload: unknown): ItemGroup[] {
  let records: unknown[] = [];
  for (const path of GROUP_LIST_PATHS) {
    records = getList(payload, path);
    if (records.length > 0) break;
  }

  const groups: ItemGroup[] = [];
  for (const record of records) {
    const name = pickString(record, ["groupName", "name"]);
    const itemNumber = pickNumber(record, ["itemNumber", "count", "num"]);
    if (!name || itemNumber === undefined) continue;
    groups.push({ name, itemNumber });
  }
  return groups;
}

export function describeItemGroups(groups: ItemGroup[]): string | undefined {
  if (groups.length === 0) return undefined;
  return `平台分组：${groups.map((g) => `${g.name} ${g.itemNumber} 件`).join("，")}`;
}

/* ── 商品详情（mtop.taobao.idle.pc.detail）──────────────────────────────── */

// 裸路径优先：reader 传进来的是剥掉信封之后的 data 本身
const DETAIL_VIEWS = ["itemDO.browseCnt", "data.itemDO.browseCnt", "browseCnt"];
const DETAIL_WANTS = ["itemDO.wantCnt", "data.itemDO.wantCnt", "wantCnt"];
const DETAIL_STOCK = ["itemDO.quantity", "data.itemDO.quantity", "quantity"];

export interface ListingMetrics {
  views7d?: number;
  wants?: number;
  stock?: number;
}

/**
 * 从商品详情里取热度数据。
 *
 * 商品列表接口不给浏览 / 想要 / 库存，详情接口给（实测 `itemDO.browseCnt`、
 * `itemDO.wantCnt`、`itemDO.quantity`）。一件商品一次请求，所以只值得对
 * **在售** 商品做 —— 已售出的商品，这些数字对决策没有意义。
 *
 * 注意 `browseCnt` 是**累计**浏览，不是近 7 天。我们把它填进 `views7d` 是因为
 * 平台没有 7 天口径的数字，这一点在阈值上要自己心里有数。
 */
export function readListingMetrics(payload: unknown): ListingMetrics {
  return {
    views7d: pickNumber(payload, DETAIL_VIEWS),
    wants: pickNumber(payload, DETAIL_WANTS),
    stock: pickNumber(payload, DETAIL_STOCK),
  };
}

const ORDER_ID = ["orderId", "bizOrderId", "id", "mainOrderId"];
const ORDER_ITEM_ID = ["itemId", "auctionId", "item.itemId"];
const ORDER_BUYER = ["buyerNick", "buyer.nick", "nick", "userNick"];
const ORDER_AMOUNT_YUAN = ["actualFee", "payAmount", "price", "totalFee"];
const ORDER_STATUS = ["orderStatus", "status", "bizStatus"];

/**
 * 顺序有讲究：`waitbuyerpay`（待付款）和 `waitbuyerconfirmgoods`（已发货待收货）
 * 都以 `waitbuyer` 开头，所以必须先匹配更具体的那个。把待付款错判成待发货，
 * Agent 会去催一笔还没付钱的订单发货。
 */
const ORDER_STATUS_RULES: Array<[string[], OrderStatus]> = [
  [["refund", "return"], "refund_requested"],
  [["waitbuyerpay", "waitpay", "pendingpayment", "topay"], "pending_payment"],
  [["waitsellersend", "waitsend", "waitship", "pendingshipment"], "pending_shipment"],
  [["waitbuyerconfirm", "waitreceive", "shipped", "sent", "delivered"], "shipped"],
  [["success", "finish", "completed", "done"], "completed"],
];

function toOrderStatus(raw: string | undefined): OrderStatus {
  if (!raw) return "pending_shipment";
  const value = normalizeCode(raw);
  for (const [needles, status] of ORDER_STATUS_RULES) {
    if (needles.some((needle) => value.includes(needle))) return status;
  }
  return "pending_shipment";
}

export function mapOrders(payload: unknown, now: number): MapResult<Order> {
  let records: unknown[] = [];
  for (const path of [...LIST_PATHS, "orders", "orderList", "data.orders", "data.orderList"]) {
    records = getList(payload, path);
    if (records.length > 0) break;
  }

  const items: Order[] = [];
  let skipped = 0;

  for (const record of records) {
    const id = pickString(record, ORDER_ID);
    const amountYuan = pickNumber(record, ORDER_AMOUNT_YUAN);
    if (!id || amountYuan === undefined) {
      skipped += 1;
      continue;
    }

    items.push({
      id,
      listingId: pickString(record, ORDER_ITEM_ID) ?? "",
      buyerName: pickString(record, ORDER_BUYER) ?? "买家",
      amountCents: Math.round(amountYuan * 100),
      status: toOrderStatus(pickString(record, ORDER_STATUS)),
      createdAt: new Date(now).toISOString(),
    });
  }

  return { items, skipped };
}
