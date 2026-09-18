import {
  findNumberByKey,
  getList,
  getPath,
  pick,
  pickNumber,
  pickString,
} from "@/lib/adapters/live/paths";
import type {
  DeliveryTerm,
  ExtractionLayer,
  ObservationSource,
  ParsedShopOrigin,
} from "@/lib/domain/types";

/**
 * 页面快照解析。
 *
 * 数据来自采集端快照，或按商品链接去商详补的那一次。
 * 商详补数限速，撞风控立刻停。
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
  /** 店铺页快照：这一页是谁的店。列表卡上常常没有卖家字段。 */
  sellerId?: string;
  sellerName?: string;
}

export interface ParsedItem {
  /** 平台 itemId，稳定主键 */
  itemId: string;
  title?: string;
  sellerName?: string;
  /** 卖家主键。抽不到就留空，绝不拿昵称顶替。 */
  sellerId?: string;
  /** 这家店的个人页地址 */
  shopUrl?: string;
  url: string;
  source: ObservationSource;
  wants?: number;
  wantsFrom?: ExtractionLayer;
  views?: number;
  viewsFrom?: ExtractionLayer;
  priceCents?: number;
  priceFrom?: ExtractionLayer;
  delivery: DeliveryTerm;
  /** 商品图，第一张当封面。抽不到就是空数组。 */
  imageUrls: string[];
  /** 商品正文。搜索卡片常常没有。 */
  copy?: string;
  copyFrom?: ExtractionLayer;
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
  /** 这是一份店铺在售列表，来自谁的店。别的页面类型没有这一项。 */
  shop?: ParsedShopOrigin;
}

const ITEM_ID_PATHS = [
  "data.itemDO.itemId",
  "itemDO.itemId",
  "data.item.itemId",
  "data.item.main.clickParam.args.item_id",
  "data.item.main.clickParam.args.id",
  "data.itemId",
  "clickParam.args.item_id",
  "clickParam.args.id",
  "cardData.id",
  "cardData.itemId",
  "itemId",
  "auctionId",
  "id",
];

const TITLE_PATHS = [
  "data.itemDO.title",
  "itemDO.title",
  "data.item.title",
  "data.item.main.exContent.title",
  "data.title",
  "exContent.title",
  "cardData.title",
  "clickParam.args.title",
  "title",
];

const SELLER_PATHS = [
  "data.sellerDO.nick",
  "data.seller.nick",
  "data.sellerDO.userNick",
  "cardData.userNickName",
  "sellerNick",
  "sellerName",
  "seller",
  "nick",
];

/**
 * 卖家主键。昵称会改、也会重名，认人只能认它。
 * 商详的 sellerDO.userId 最稳；店铺列表卡上有时只有 userId。
 */
const SELLER_ID_PATHS = [
  "data.sellerDO.userId",
  "data.sellerDO.sellerId",
  "data.seller.userId",
  "itemDO.userId",
  "data.itemDO.userId",
  "cardData.userId",
  "clickParam.args.seller_id",
  "clickParam.args.userId",
  "userId",
  "sellerId",
];

const WANTS_PATHS = [
  "data.itemDO.wantCnt",
  "itemDO.wantCnt",
  "data.item.wantCnt",
  "data.item.main.exContent.wantCnt",
  "data.wantCnt",
  "cardData.wantCnt",
  "exContent.wantCnt",
  "wantCnt",
  "collectCount",
  "collectNum",
  "wantCount",
  "collectCnt",
  "favCnt",
  "favoriteCnt",
  // 采集端从页面上读出来的字段用这个朴素的名字
  "wants",
];

const VIEWS_PATHS = [
  "data.itemDO.browseCnt",
  "itemDO.browseCnt",
  "data.item.browseCnt",
  "data.item.main.exContent.browseCnt",
  "data.browseCnt",
  "cardData.browseCnt",
  "exContent.browseCnt",
  "browseCnt",
  "viewCount",
  "browseCount",
  "pv",
  "views",
];

const PRICE_YUAN_PATHS = [
  "data.itemDO.soldPrice",
  "data.itemDO.price",
  "data.item.price",
  "data.item.main.clickParam.args.price",
  "data.item.main.exContent.soldPrice",
  "data.price",
  "cardData.priceInfo.price",
  "cardData.price",
  "clickParam.args.price",
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
  "data.item.main.targetUrl",
  "cardData.targetUrl",
  "targetUrl",
  "itemUrl",
  "url",
  "href",
];

const IMAGE_URL_PATHS = [
  "data.itemDO.picUrl",
  "data.itemDO.imageUrl",
  "data.item.main.exContent.picUrl",
  "data.item.main.exContent.imageUrl",
  "data.item.main.clickParam.args.picUrl",
  "exContent.picUrl",
  "clickParam.args.picUrl",
  "cardData.picUrl",
  "picUrl",
  "imageUrl",
  "cover",
];

const IMAGE_LIST_PATHS = [
  "data.itemDO.imageInfos",
  "itemDO.imageInfos",
  "data.itemDO.imageUrls",
  "itemDO.imageUrls",
  "data.itemDO.images",
  "data.itemDO.picUrls",
  "data.item.main.exContent.picUrls",
  "exContent.picUrls",
  "imageInfos",
  "imageUrls",
  "images",
  "picUrls",
  "pics",
];

const COPY_PATHS = [
  "data.itemDO.desc",
  "itemDO.desc",
  "data.itemDO.description",
  "itemDO.description",
  "data.itemDO.itemDesc",
  "itemDO.itemDesc",
  "data.item.desc",
  "data.desc",
  "exContent.desc",
  "exContent.description",
  "cardData.desc",
  "desc",
  "description",
  "itemDesc",
  "copy",
];

const RICH_TEXT_PATHS = [
  "data.itemDO.richTextDesc",
  "itemDO.richTextDesc",
  "richTextDesc",
];

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif)(\?|$)/i;
const IMAGE_HOST = /(alicdn|taobaocdn|tbcdn|gw\.alicdn)/i;
const JUNK_IMAGE = /\b(avatar|headicon|default_avatar|emoji|sprite|1x1|pixel|favicon|logo_s)\b/i;
const PAGE_LINK_KEY = /^(targetUrl|itemUrl|jumpUrl|href|shareUrl|detailUrl)$/i;

/** 搜索页返回里卡片列表可能在的位置。 */
const LIST_PATHS = [
  "data.cardList",
  "data.items",
  "data.itemList",
  "data.resultList",
  "data.resultInfo.resultList",
  "data.searchResult.resultList",
  "data.result",
  "data.list",
  // 有的通道已经剥掉信封，data 本身就是这一层
  "cardList",
  "items",
  "itemList",
  "resultList",
  "result",
  "list",
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

/** 「1192浏览」「1,192次浏览」，不认孤零零的数字。 */
const VIEWS_TEXT = [
  /([\d,]+)\s*次?\s*浏览/,
  /浏览\s*[:：|]?\s*([\d,]+)/,
];

const WANT_KEY = /^(wantCnt|wantCount|collectCnt|collectCount|collectNum|wants)$/i;
const VIEW_KEY = /^(browseCnt|browseCount|viewCount|viewCnt|pv|views)$/i;

/** 搜索卡上的价格经常是 `[{text:"¥"},{text:"5"}]`，不是一个数字。 */
function readIdleCardPrice(record: unknown): number | undefined {
  const raw = pick(record, [
    "data.item.main.exContent.price",
    "exContent.price",
    "data.item.main.exContent.priceList",
  ]);
  if (Array.isArray(raw)) {
    const text = raw
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text?: unknown }).text ?? "");
        }
        return "";
      })
      .join("");
    const cleaned = text.replace(/[^\d.]/g, "");
    if (!/\d/.test(cleaned)) return undefined;
    const value = Number(cleaned);
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const cleaned = raw.replace(/[^\d.]/g, "");
    if (!/\d/.test(cleaned)) return undefined;
    const value = Number(cleaned);
    return Number.isFinite(value) ? value : undefined;
  }
  return undefined;
}

function toCents(
  record: unknown,
): { value: number; from: "field" } | undefined {
  const cents = pickNumber(record, PRICE_CENTS_PATHS);
  if (cents !== undefined) return { value: Math.round(cents), from: "field" };
  const yuan = pickNumber(record, PRICE_YUAN_PATHS) ?? readIdleCardPrice(record);
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

/**
 * 从一份商详响应里认卖家。
 *
 * 只能喂商详那一条响应。同一页上还有 loginuser 之类的接口，
 * 里面的 userId 是你自己 —— 认错了「进店铺」会跳进自己的店。
 */
export function sellerFromRecord(record: unknown): {
  sellerId?: string;
  sellerName?: string;
} {
  return {
    sellerId: pickString(record, SELLER_ID_PATHS),
    sellerName: pickString(record, SELLER_PATHS),
  };
}

/** 从店铺页地址里抠 sellerId，如 /personal?userId=123。 */
export function extractSellerId(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const match = url.match(/[?&](?:userId|sellerId|user_id)=(\d+)/i);
  return match?.[1];
}

/** 店铺个人页地址。界面上「进店铺」就是普通链接，不经过自动化。 */
export function shopUrlFor(sellerId: string | undefined): string | undefined {
  return sellerId ? `https://www.goofish.com/personal?userId=${sellerId}` : undefined;
}

/** 这是不是一张店铺在售列表页。 */
export function isShopPageUrl(url: string | undefined): boolean {
  if (!url) return false;
  return /\/personal\b|\/shop\b/.test(url) || /[?&]userId=\d/i.test(url);
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
 * 商品图地址：补 https、丢掉头像/商品页链接。认不出就不当图片。
 *
 * 搜索卡常把 `targetUrl`（商详页）和主图混在一起。goofish.com/item
 * 不是图，拿去当封面就会裂开。
 */
/** 阿里 CDN 会把尺寸写进文件名，如 `-tps-84-60.png`。 */
const TPS_SIZE = /-tps-(\d+)-(\d+)\.(?:jpe?g|png|webp|gif|avif)$/i;

/** 商品图的短边至少这么大。再小的是徽标、占位图那类东西。 */
const MIN_IMAGE_EDGE = 120;

/**
 * 挡掉徽标和占位图。
 *
 * 列表卡上「包邮」角标是 84×60，懒加载占位图是 2×2，
 * 它们和真封面一样挂在卡片里，不挡掉会顶到封面位上去。
 */
export function isTinyImage(url: string): boolean {
  const match = url.match(TPS_SIZE);
  if (!match) return false;
  return Math.min(Number(match[1]), Number(match[2])) < MIN_IMAGE_EDGE;
}

export function normalizeImageUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let url = raw.trim();
  if (url.startsWith("//")) url = `https:${url}`;
  if (url.startsWith("http://")) url = `https://${url.slice("http://".length)}`;
  if (!/^https:\/\//i.test(url) || url.startsWith("data:")) return undefined;
  if (JUNK_IMAGE.test(url)) return undefined;
  if (isTinyImage(url)) return undefined;
  try {
    const parsed = new URL(url);
    if (/goofish\.com$/i.test(parsed.hostname) && !IMAGE_EXT.test(parsed.pathname)) {
      return undefined;
    }
    if (IMAGE_HOST.test(parsed.hostname) || IMAGE_EXT.test(parsed.pathname)) return url;
  } catch {
    return undefined;
  }
  return undefined;
}

/** 已经入库的地址再滤一遍：旧数据里可能混着商详页链接。 */
export function displayImageUrls(urls: string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of urls ?? []) {
    const url = normalizeImageUrl(raw);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function addImageUrl(urls: string[], seen: Set<string>, value: unknown, limit: number) {
  if (urls.length >= limit) return;
  if (typeof value === "string") {
    const url = normalizeImageUrl(value);
    if (url && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) addImageUrl(urls, seen, item, limit);
    return;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["url", "picUrl", "imageUrl", "src", "img"]) {
      if (key in record) addImageUrl(urls, seen, record[key], limit);
    }
  }
}

function walkImageKeys(
  record: unknown,
  urls: string[],
  seen: Set<string>,
  limit: number,
  depth: number,
) {
  if (depth > 4 || urls.length >= limit || !record || typeof record !== "object") {
    return;
  }
  if (Array.isArray(record)) {
    for (const item of record) walkImageKeys(item, urls, seen, limit, depth + 1);
    return;
  }
  for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
    if (PAGE_LINK_KEY.test(key)) continue;
    if (!/pic|image|img|photo|cover|url/i.test(key)) continue;
    addImageUrl(urls, seen, value, limit);
    if (urls.length < limit && value && typeof value === "object") {
      walkImageKeys(value, urls, seen, limit, depth + 1);
    }
  }
}

/** 从一条记录里抽出商品图。已知路径优先，认不出就不猜。 */
export function collectImageUrls(record: unknown, limit = 12): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const path of IMAGE_URL_PATHS) {
    addImageUrl(urls, seen, getPath(record, path), limit);
  }
  for (const path of IMAGE_LIST_PATHS) {
    addImageUrl(urls, seen, getPath(record, path), limit);
  }
  if (urls.length === 0) walkImageKeys(record, urls, seen, limit, 0);
  return urls;
}

function sanitizeCopy(text: string): string | undefined {
  const cleaned = text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (cleaned.length < 8) return undefined;
  return cleaned.slice(0, 8000);
}

/** 商详里的 richTextDesc 是一段 JSON，把里面的字抽出来。 */
export function readRichTextDesc(raw: unknown): string | undefined {
  let value: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        value = JSON.parse(trimmed) as unknown;
      } catch {
        return sanitizeCopy(trimmed.replace(/<[^>]+>/g, " "));
      }
    } else {
      return sanitizeCopy(trimmed.replace(/<[^>]+>/g, " "));
    }
  }
  const parts: string[] = [];
  const walk = (node: unknown) => {
    if (parts.join("\n").length > 8000) return;
    if (typeof node === "string") {
      const text = node.trim();
      if (text) parts.push(text);
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (typeof record.text === "string") walk(record.text);
    if (typeof record.value === "string" && record.type === "text") walk(record.value);
    if (record.children) walk(record.children);
  };
  walk(value);
  return sanitizeCopy(parts.join("\n"));
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

function readCountFromText(
  text: string,
  patterns: RegExp[],
): { value: number; excerpt: string } | undefined {
  for (const pattern of patterns) {
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

/** 从可见文字里读「想要」，同时留下命中的原文片段当证据。 */
export function readWantsFromText(
  text: string,
): { value: number; excerpt: string } | undefined {
  return readCountFromText(text, WANTS_TEXT);
}

/** 从可见文字里读累计浏览。 */
export function readViewsFromText(
  text: string,
): { value: number; excerpt: string } | undefined {
  return readCountFromText(text, VIEWS_TEXT);
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

function firstHeatByKey(
  layers: Layered[],
  keyTest: RegExp,
): { value: number; layer: ExtractionLayer } | undefined {
  for (const { record, layer } of layers) {
    const value = findNumberByKey(record, keyTest);
    if (value !== undefined) return { value, layer };
  }
  return undefined;
}

/** 商详 HTML 里抠「122人想要|1217浏览」。接口没给字段时用。 */
export function heatFromItemHtml(html: string): {
  wants?: number;
  views?: number;
  visibleText?: string;
} {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
  const wants = readWantsFromText(stripped) ?? readWantsFromText(html);
  const views = readViewsFromText(stripped) ?? readViewsFromText(html);
  const visibleText = [wants?.excerpt, views?.excerpt].filter(Boolean).join(" | ");
  return {
    wants: wants?.value,
    views: views?.value,
    visibleText: visibleText || undefined,
  };
}

function firstCountable(
  layers: Layered[],
  paths: string[],
): { value: number; layer: ExtractionLayer } | undefined {
  for (const { record, layer } of layers) {
    const value = pickNumber(record, paths);
    if (value !== undefined && value > 0) return { value, layer };
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

/**
 * 「价格面议」的哨兵值。
 *
 * 服务类商品的商详接口会返回 999999 这种全 9 的数，意思是价格待议，
 * 列表卡上给的才是真实展示价。当成真价记下来，看板上就会出现 ¥999,999。
 */
export function isSentinelYuan(yuan: number): boolean {
  return yuan >= 999999 && /^9+$/.test(String(Math.round(yuan)));
}

function firstCents(
  layers: Layered[],
): { value: number; layer: ExtractionLayer } | undefined {
  for (const { record, layer } of layers) {
    const cents = toCents(record);
    if (cents === undefined) continue;
    if (isSentinelYuan(cents.value / 100)) continue;
    return { value: cents.value, layer };
  }
  return undefined;
}

function firstImages(
  layers: Layered[],
): { urls: string[]; layer: ExtractionLayer } | undefined {
  for (const { record, layer } of layers) {
    const urls = collectImageUrls(record);
    if (urls.length > 0) return { urls, layer };
  }
  return undefined;
}

function firstCopy(
  layers: Layered[],
  title?: string,
): { value: string; layer: ExtractionLayer } | undefined {
  for (const { record, layer } of layers) {
    const raw = pickString(record, COPY_PATHS);
    let value = raw ? sanitizeCopy(raw) : undefined;
    if (!value || (title && value === title.trim())) {
      const rich = readRichTextDesc(pick(record, RICH_TEXT_PATHS));
      if (rich && (!title || rich !== title.trim())) value = rich;
    }
    if (!value) continue;
    if (title && value === title.trim()) continue;
    return { value, layer };
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
  /** 店铺页快照声明的卖家，列表卡自己常常不带 */
  fallbackSellerId?: string;
}): ParsedItem | undefined {
  const { layers, visibleText, pageUrl, at, source } = options;

  const itemId =
    firstString(layers, ITEM_ID_PATHS) ??
    extractItemId(firstString(layers, URL_PATHS)) ??
    (source === "detail" ? extractItemId(pageUrl) : undefined);
  if (!itemId) return undefined;

  const title = firstString(layers, TITLE_PATHS);
  const url = normalizeUrl(firstString(layers, URL_PATHS) ?? pageUrl, itemId);

  const structuredWants =
    firstCountable(layers, WANTS_PATHS) ?? firstHeatByKey(layers, WANT_KEY);
  const textWants = structuredWants
    ? undefined
    : readWantsFromText(visibleText);

  const wants = structuredWants?.value ?? textWants?.value;
  const wantsFrom: ExtractionLayer | undefined = structuredWants
    ? (options.declaredLayer ?? structuredWants.layer)
    : textWants
      ? "dom"
      : undefined;

  const structuredViews =
    firstCountable(layers, VIEWS_PATHS) ?? firstHeatByKey(layers, VIEW_KEY);
  const textViews = structuredViews
    ? undefined
    : readViewsFromText(visibleText);
  const views = structuredViews?.value ?? textViews?.value;
  const viewsFrom: ExtractionLayer | undefined = structuredViews
    ? (options.declaredLayer ?? structuredViews.layer)
    : textViews
      ? "dom"
      : undefined;

  const price = firstCents(layers);
  const images = firstImages(layers);
  const copy = firstCopy(layers, title);
  const deliveryText = [
    visibleText,
    title ?? "",
    JSON.stringify(layers[0]?.record ?? ""),
  ].join(" ");
  const delivery = readDelivery(deliveryText);

  const missing: string[] = [];
  if (wants === undefined) missing.push("wants");
  if (views === undefined) missing.push("views");
  if (price === undefined) missing.push("price");
  if (delivery === "unknown") missing.push("delivery");
  if (!images) missing.push("images");
  if (!copy) missing.push("copy");

  // 店铺页上每一张卡都属于这家店，卡里没写就退回快照声明的、再退回页面地址
  const sellerId =
    firstString(layers, SELLER_ID_PATHS) ??
    options.fallbackSellerId ??
    extractSellerId(pageUrl);

  return {
    itemId,
    title,
    sellerName: firstString(layers, SELLER_PATHS),
    sellerId,
    shopUrl: shopUrlFor(sellerId),
    url,
    source,
    wants,
    wantsFrom,
    views,
    viewsFrom,
    priceCents: price?.value,
    priceFrom: price ? (options.declaredLayer ?? price.layer) : undefined,
    delivery,
    imageUrls: images?.urls ?? [],
    copy: copy?.value,
    copyFrom: copy ? (options.declaredLayer ?? copy.layer) : undefined,
    excerpt: textWants?.excerpt ?? textViews?.excerpt,
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
  // 商详先判：店铺页跳进某一件之后地址上 userId 和 id 会同时在
  if (/\/item\b|[?&]id=\d/.test(url)) return "detail";
  if (isShopPageUrl(url)) return "shop";
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
        fallbackSellerId:
          typeof snapshot.sellerId === "string" ? snapshot.sellerId : undefined,
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

    const item = buildItem({
      layers,
      visibleText,
      pageUrl,
      at,
      source,
      fallbackSellerId:
        typeof snapshot.sellerId === "string" ? snapshot.sellerId : undefined,
    });
    if (item) items.push(item);
    else skipped += 1;
  }

  if (items.length === 0) {
    // 这是挡住入库的那个问题，得排在「没有 capturedAt」这类提醒前面
    warnings.unshift(
      "这份快照里没认出任何商品，确认一下是不是在商详或搜索结果页采集的。",
    );
  }

  // 店铺页的身份：快照声明的优先，其次从地址上抠。认不出就不算店铺快照。
  const sellerId =
    source === "shop"
      ? (typeof snapshot.sellerId === "string" ? snapshot.sellerId : undefined) ??
        extractSellerId(pageUrl)
      : undefined;
  const shop: ParsedShopOrigin | undefined = sellerId
    ? {
        sellerId,
        sellerName:
          typeof snapshot.sellerName === "string" ? snapshot.sellerName : undefined,
      }
    : undefined;

  return { items, skipped, warnings, ...(shop ? { shop } : {}) };
}
