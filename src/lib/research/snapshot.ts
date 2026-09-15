import { getList, pickNumber, pickString } from "@/lib/adapters/live/paths";
import type {
  DeliveryTerm,
  ExtractionLayer,
  ObservationSource,
} from "@/lib/domain/types";

/**
 * 页面快照解析。
 *
 * 数据只来自「你正常浏览时、当前页面上已经画出来并且你点过授权」的内容 ——
 * 服务器不会拿你的登录态去轮询别人的商详，那是爬站。
 *
 * 快照长这样（和登录态导出同一路：外部采集 → 本机解析）：
 *
 * ```json
 * {
 *   "capturedAt": "2026-09-15T04:00:00.000Z",
 *   "pageUrl": "https://www.goofish.com/item?id=812345",
 *   "pageType": "detail",
 *   "api":       { … },   // 页面自己已经拉回来的响应，最稳
 *   "hydration": { … },   // 页里内嵌的初始 JSON
 *   "dom":       { … },   // 采集端从 DOM 上读到的结构化字段
 *   "visibleText": "86人想要 · 包邮",   // 当前可见的文字，兜底
 *   "items": [ … ]        // 搜索页的卡片，每张可以自带 layer
 * }
 * ```
 */
export interface PageSnapshot {
  capturedAt?: string;
  pageUrl?: string;
  pageType?: ObservationSource;
  api?: unknown;
  hydration?: unknown;
  /** 采集端从 DOM 上读出来的字段。层级记成 dom —— 它确实只是页面上的字。 */
  dom?: unknown;
  visibleText?: string;
  items?: unknown[];
}

export interface ParsedItem {
  /** 平台 itemId，稳定主键 */
  itemId: string;
  title?: string;
  sellerName?: string;
  url: string;
  source: ObservationSource;
  wants?: number;
  wantsFrom?: ExtractionLayer;
  priceCents?: number;
  priceFrom?: ExtractionLayer;
  delivery: DeliveryTerm;
  excerpt?: string;
  missing: string[];
  pageUrl: string;
  at: string;
}

export interface ParseResult {
  items: ParsedItem[];
  /** 认不出 itemId 的记录数。如实显示，不假装解析很完美。 */
  skipped: number;
  warnings: string[];
}

const ITEM_ID_PATHS = [
  "data.itemDO.itemId",
  "data.item.itemId",
  "data.itemId",
  "cardData.id",
  "cardData.itemId",
  "itemId",
  "auctionId",
  "id",
];

const TITLE_PATHS = [
  "data.itemDO.title",
  "data.item.title",
  "data.title",
  "cardData.title",
  "title",
];

const SELLER_PATHS = [
  "data.sellerDO.nick",
  "data.seller.nick",
  "data.sellerDO.userNick",
  "cardData.userNickName",
  "sellerNick",
  "seller",
  "nick",
];

const WANTS_PATHS = [
  "data.itemDO.wantCnt",
  "data.item.wantCnt",
  "data.wantCnt",
  "cardData.wantCnt",
  "wantCnt",
  "collectCount",
  "collectNum",
  "wantCount",
  // 采集端从页面上读出来的字段用这个朴素的名字
  "wants",
];

const PRICE_YUAN_PATHS = [
  "data.itemDO.soldPrice",
  "data.itemDO.price",
  "data.item.price",
  "data.price",
  "cardData.priceInfo.price",
  "cardData.price",
  "soldPrice",
  "price",
];

const PRICE_CENTS_PATHS = [
  "data.itemDO.priceCent",
  "cardData.priceCent",
  "priceCent",
  "priceCents",
];

const URL_PATHS = [
  "data.itemDO.itemUrl",
  "cardData.targetUrl",
  "targetUrl",
  "itemUrl",
  "url",
  "href",
];

/** 搜索页返回里卡片列表可能在的位置。 */
const LIST_PATHS = [
  "data.cardList",
  "data.items",
  "data.itemList",
  "data.resultList",
  "data.result",
  "data.list",
];

/**
 * 「想要」在可见文字里的几种写法。
 *
 * 只认明确带「想要」字样的，不认孤零零的数字 —— 页面上到处都是数字。
 */
const WANTS_TEXT = [
  /([\d,]+)\s*人\s*想要/,
  /想要\s*[:：]?\s*([\d,]+)/,
  /([\d,]+)\s*人想要/,
];

function toCents(
  record: unknown,
): { value: number; from: "field" } | undefined {
  const cents = pickNumber(record, PRICE_CENTS_PATHS);
  if (cents !== undefined) return { value: Math.round(cents), from: "field" };
  const yuan = pickNumber(record, PRICE_YUAN_PATHS);
  if (yuan === undefined) return undefined;
  return { value: Math.round(yuan * 100), from: "field" };
}

/**
 * 从商详地址里抠出 itemId。
 *
 * 标题和价格都会改，itemId 不会 —— 所以主键用它，不用标题。
 */
export function extractItemId(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const query = url.match(/[?&]id=(\d+)/);
  if (query) return query[1];
  const path = url.match(/\/item\/(\d+)/);
  if (path) return path[1];
  return undefined;
}

function normalizeUrl(raw: string | undefined, itemId: string): string {
  if (!raw) return `https://www.goofish.com/item?id=${itemId}`;
  const trimmed = raw.trim();
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  if (trimmed.startsWith("/")) return `https://www.goofish.com${trimmed}`;
  if (/^https?:\/\//.test(trimmed)) return trimmed;
  return `https://www.goofish.com/item?id=${itemId}`;
}

/**
 * 交付方式只从看得见的文字里判断，判断不出来就是「未标明」。
 *
 * 价格带只在交付方式一致时才有意义 —— 包邮和到付差着运费。
 */
export function readDelivery(text: string): DeliveryTerm {
  if (/包邮|免运费/.test(text)) return "free_shipping";
  if (/运费|邮费|到付/.test(text)) return "buyer_pays";
  if (/自提|自取|上门取/.test(text)) return "pickup";
  if (/同城/.test(text)) return "local";
  return "unknown";
}

/** 从可见文字里读「想要」，同时留下命中的原文片段当证据。 */
export function readWantsFromText(
  text: string,
): { value: number; excerpt: string } | undefined {
  for (const pattern of WANTS_TEXT) {
    const match = text.match(pattern);
    if (!match) continue;
    const value = Number(match[1].replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    const at = match.index ?? 0;
    const excerpt = text
      .slice(Math.max(0, at - 12), at + match[0].length + 12)
      .replace(/\s+/g, " ")
      .trim();
    return { value, excerpt };
  }
  return undefined;
}

interface Layered {
  record: unknown;
  layer: ExtractionLayer;
}

/** 按 api → hydration 的顺序找第一个能给出这个字段的层。 */
function firstNumber(
  layers: Layered[],
  paths: string[],
): { value: number; layer: ExtractionLayer } | undefined {
  for (const { record, layer } of layers) {
    const value = pickNumber(record, paths);
    if (value !== undefined) return { value, layer };
  }
  return undefined;
}

function firstString(layers: Layered[], paths: string[]): string | undefined {
  for (const { record } of layers) {
    const value = pickString(record, paths);
    if (value !== undefined) return value;
  }
  return undefined;
}

function firstCents(
  layers: Layered[],
): { value: number; layer: ExtractionLayer } | undefined {
  for (const { record, layer } of layers) {
    const cents = toCents(record);
    if (cents !== undefined) return { value: cents.value, layer };
  }
  return undefined;
}

function buildItem(options: {
  layers: Layered[];
  visibleText: string;
  pageUrl: string;
  at: string;
  source: ObservationSource;
  /** items 数组里的卡片自己声明的层级 */
  declaredLayer?: ExtractionLayer;
}): ParsedItem | undefined {
  const { layers, visibleText, pageUrl, at, source } = options;

  const itemId =
    firstString(layers, ITEM_ID_PATHS) ??
    extractItemId(firstString(layers, URL_PATHS)) ??
    (source === "detail" ? extractItemId(pageUrl) : undefined);
  if (!itemId) return undefined;

  const title = firstString(layers, TITLE_PATHS);
  const url = normalizeUrl(firstString(layers, URL_PATHS) ?? pageUrl, itemId);

  const structuredWants = firstNumber(layers, WANTS_PATHS);
  const textWants = structuredWants
    ? undefined
    : readWantsFromText(visibleText);

  const wants = structuredWants?.value ?? textWants?.value;
  const wantsFrom: ExtractionLayer | undefined = structuredWants
    ? (options.declaredLayer ?? structuredWants.layer)
    : textWants
      ? "dom"
      : undefined;

  const price = firstCents(layers);
  const deliveryText = [
    visibleText,
    title ?? "",
    JSON.stringify(layers[0]?.record ?? ""),
  ].join(" ");
  const delivery = readDelivery(deliveryText);

  const missing: string[] = [];
  if (wants === undefined) missing.push("wants");
  if (price === undefined) missing.push("price");
  if (delivery === "unknown") missing.push("delivery");

  return {
    itemId,
    title,
    sellerName: firstString(layers, SELLER_PATHS),
    url,
    source,
    wants,
    wantsFrom,
    priceCents: price?.value,
    priceFrom: price ? (options.declaredLayer ?? price.layer) : undefined,
    delivery,
    excerpt: textWants?.excerpt,
    missing,
    pageUrl,
    at,
  };
}

function declaredLayer(record: unknown): ExtractionLayer | undefined {
  if (!record || typeof record !== "object") return undefined;
  const value = (record as Record<string, unknown>).layer;
  return value === "api" || value === "hydration" || value === "dom"
    ? value
    : undefined;
}

function detectPageType(
  snapshot: PageSnapshot,
  cardCount: number,
): ObservationSource {
  if (snapshot.pageType) return snapshot.pageType;
  const url = snapshot.pageUrl ?? "";
  if (/\/item\b|[?&]id=\d/.test(url)) return "detail";
  if (/search|\/s\?|category/.test(url)) return "search";
  return cardCount > 1 ? "search" : "detail";
}

/**
 * 解析一份页面快照。
 *
 * 认不出 itemId 的记录直接跳过并计数 —— 一个编出来的商品比没有数据危险得多。
 */
export function parsePageSnapshot(raw: unknown, now: number): ParseResult {
  const warnings: string[] = [];

  let snapshot: PageSnapshot;
  if (typeof raw === "string") {
    try {
      snapshot = JSON.parse(raw) as PageSnapshot;
    } catch {
      return {
        items: [],
        skipped: 0,
        warnings: ["不是合法的 JSON，检查一下有没有复制完整。"],
      };
    }
  } else if (raw && typeof raw === "object") {
    snapshot = raw as PageSnapshot;
  } else {
    return { items: [], skipped: 0, warnings: ["快照内容为空。"] };
  }

  const at = snapshot.capturedAt ?? new Date(now).toISOString();
  if (!snapshot.capturedAt) {
    warnings.push("快照里没有 capturedAt，按导入时间记录观察时间。");
  }
  const pageUrl = snapshot.pageUrl ?? "";
  const visibleText =
    typeof snapshot.visibleText === "string" ? snapshot.visibleText : "";

  // 搜索页的卡片：既支持页面响应里的列表，也支持采集端整理好的 items 数组
  const cards: Layered[] = [];
  for (const path of LIST_PATHS) {
    const list = getList(snapshot.api, path);
    if (list.length > 0) {
      cards.push(
        ...list.map((record) => ({ record, layer: "api" as ExtractionLayer })),
      );
      break;
    }
  }
  for (const record of snapshot.items ?? []) {
    // 采集端没声明层级时按 dom 记 —— 宁可低估可信度，不要高估
    cards.push({ record, layer: declaredLayer(record) ?? "dom" });
  }

  const source = detectPageType(snapshot, cards.length);
  const items: ParsedItem[] = [];
  let skipped = 0;

  if (cards.length > 0) {
    for (const card of cards) {
      const item = buildItem({
        layers: [card],
        // 卡片自己带的文字才算它的，整页文字不能归给某一张卡片
        visibleText:
          typeof (card.record as Record<string, unknown>)?.visibleText ===
          "string"
            ? ((card.record as Record<string, unknown>).visibleText as string)
            : "",
        pageUrl: pageUrl || normalizeUrl(undefined, "0"),
        at,
        source,
        declaredLayer: card.layer,
      });
      if (item) items.push(item);
      else skipped += 1;
    }
  } else {
    // 顺序就是可信度：页面接口 → 内嵌 JSON → 采集端从 DOM 读到的字段
    const layers: Layered[] = [];
    if (snapshot.api !== undefined)
      layers.push({ record: snapshot.api, layer: "api" });
    if (snapshot.hydration !== undefined) {
      layers.push({ record: snapshot.hydration, layer: "hydration" });
    }
    if (snapshot.dom !== undefined) {
      layers.push({ record: snapshot.dom, layer: "dom" });
    }

    const item = buildItem({ layers, visibleText, pageUrl, at, source });
    if (item) items.push(item);
    else skipped += 1;
  }

  if (items.length === 0) {
    // 这是挡住入库的那个问题，得排在「没有 capturedAt」这类提醒前面
    warnings.unshift(
      "这份快照里没认出任何商品，确认一下是不是在商详或搜索结果页采集的。",
    );
  }

  return { items, skipped, warnings };
}
