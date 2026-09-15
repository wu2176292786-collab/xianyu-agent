import type { Listing, Order, OrderStatus } from "@/lib/domain/types";
import { getList, pickNumber, pickString } from "./paths";

/**
 * 把真实接口的响应映射成我们的领域模型。
 *
 * 字段名全部用候选列表，是因为淘系接口的返回结构没有公开文档，只能靠抓包，
 * 而且会变。命中不了就跳过这条记录，绝不硬塞一个猜出来的值进去 ——
 * 一个编出来的价格比没有数据危险得多。
 */
const LIST_PATHS = [
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

    const stock = pickNumber(record, ITEM_STOCK) ?? 1;
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
      stock,
      status: toListingStatus(pickString(record, ITEM_STATUS)),
      createdAt: new Date(now).toISOString(),
      lastRefreshedAt: new Date(now).toISOString(),
      views7d: pickNumber(record, ITEM_VIEWS) ?? 0,
      wants: pickNumber(record, ITEM_WANTS) ?? 0,
      inquiries7d: 0,
      tags: [],
    });
  }

  return { items, skipped };
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
  for (const path of [...LIST_PATHS, "data.orders", "data.orderList"]) {
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
