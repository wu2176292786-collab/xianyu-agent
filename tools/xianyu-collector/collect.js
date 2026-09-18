/**
 * 隔离世界里的采集脚本。
 *
 * 弹窗点「加入研究」时，它把当前页面拼成一份快照；
 * 搜索页还会按弹窗的指示去点「下一页」，连采最多 3 页。
 *
 *   api       页面自己已经拉回来的响应（旁听器给的）
 *   hydration 页面内嵌的初始 JSON
 *   dom       从页面上读出来的结构化字段
 *   visibleText 当前可见的文字
 *
 * 三层的可信度是递减的，所以快照里分开放 —— 应用那边会如实标出
 * 每个数字是哪一层给的。读不到就不给，绝不补一个猜的值。
 */
const CHANNEL = "xianyu-collector";

function extractItemId(url) {
  if (!url) return undefined;
  const query = String(url).match(/[?&]id=(\d+)/);
  if (query) return query[1];
  const path = String(url).match(/\/item\/(\d+)/);
  return path ? path[1] : undefined;
}

/** 从店铺页地址里抠卖家主键，如 /personal?userId=123。 */
function extractSellerId(url) {
  if (!url) return undefined;
  const match = String(url).match(/[?&](?:userId|sellerId|user_id)=(\d+)/i);
  return match ? match[1] : undefined;
}

function pageType() {
  const href = location.href;
  // 商详先判：从店铺页点进某一件之后，userId 和 id 会同时在地址上
  if (/\/item\b|[?&]id=\d/.test(href) && !/\/search/.test(href)) return "detail";
  if (/\/personal\b|\/shop\b/.test(href) || extractSellerId(href)) return "shop";
  if (/\/search|\/s\?|category/.test(href)) return "search";
  // 商详有 id、列表页没有，认不出来就按有没有 id 兜底
  return extractItemId(href) ? "detail" : "search";
}

/** 列表页：搜索结果和店铺在售用同一套取卡和翻页。 */
function isListPage(type) {
  return type === "search" || type === "shop";
}

/** 向页面世界的旁听器要一次记录，超时就算了。 */
function askInterceptor(timeout = 800) {
  return new Promise((resolve) => {
    const requestId = Math.random().toString(36).slice(2);
    let done = false;

    function onMessage(event) {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.channel !== CHANNEL || data.kind !== "response") return;
      if (data.requestId !== requestId) return;
      done = true;
      window.removeEventListener("message", onMessage);
      resolve({ captures: data.captures || [], hydration: data.hydration });
    }

    window.addEventListener("message", onMessage);
    window.postMessage({ channel: CHANNEL, kind: "request", requestId }, location.origin);

    setTimeout(() => {
      if (done) return;
      window.removeEventListener("message", onMessage);
      resolve({ captures: [], hydration: undefined });
    }, timeout);
  });
}

/**
 * 从旁听到的一堆响应里挑最像这一页的那个。
 *
 * 挑不出来就不给 —— 少一层数据没关系，给错一层会让「想要」张冠李戴。
 */
function chooseCapture(captures, wanted) {
  const scored = [];
  for (const capture of captures) {
    let text = "";
    try {
      text = JSON.stringify(capture.payload ?? "");
    } catch {
      continue;
    }

    let score = 0;
    if (wanted === "detail" && /detail|item\.get|head/i.test(capture.api)) score += 4;
    if (wanted === "search" && /search|list/i.test(capture.api)) score += 4;
    // 店铺在售走 mtop.idle.web.xyh.item.list
    if (wanted === "shop" && /xyh\.item\.list|item\.list|user.*item/i.test(capture.api)) {
      score += 4;
    }
    if (text.includes("wantCnt")) score += 2;
    if (/"itemId"|"soldPrice"/.test(text)) score += 1;
    if (score > 0) scored.push({ capture, score });
  }

  scored.sort((a, b) => b.score - a.score || b.capture.at - a.capture.at);
  return scored[0]?.capture.payload;
}

function visibleText(limit = 6000) {
  const raw = document.body?.innerText || "";
  return raw.replace(/[ \t]+/g, " ").slice(0, limit);
}

function readWants(text) {
  const match =
    text.match(/([\d,]+)\s*人\s*想要/) || text.match(/想要\s*[:：]?\s*([\d,]+)/);
  if (!match) return undefined;
  const value = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function readViews(text) {
  const match =
    text.match(/([\d,]+)\s*次?\s*浏览/) || text.match(/浏览\s*[:：|]?\s*([\d,]+)/);
  if (!match) return undefined;
  const value = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function readPrice(text) {
  const match = text.match(/[¥￥]\s*([\d,]+(?:\.\d+)?)/);
  if (!match) return undefined;
  const value = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(value) ? value : undefined;
}

function normalizeImageUrl(raw) {
  if (!raw) return undefined;
  let url = String(raw).trim();
  if (url.startsWith("//")) url = `https:${url}`;
  if (url.startsWith("http://")) url = `https://${url.slice("http://".length)}`;
  if (!/^https:\/\//i.test(url) || url.startsWith("data:")) return undefined;
  if (/\b(avatar|headicon|default_avatar|emoji|sprite|1x1|pixel|favicon|logo_s)\b/i.test(url)) {
    return undefined;
  }
  // 阿里 CDN 把尺寸写进文件名：「包邮」角标是 84×60，懒加载占位图是 2×2
  const tps = url.match(/-tps-(\d+)-(\d+)\.(?:jpe?g|png|webp|gif|avif)$/i);
  if (tps && Math.min(Number(tps[1]), Number(tps[2])) < 120) return undefined;
  try {
    const parsed = new URL(url);
    if (/goofish\.com$/i.test(parsed.hostname) && !/\.(jpe?g|png|webp|gif|avif)$/i.test(parsed.pathname)) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return url;
}

/** 从一块 DOM 里捡商品图。头像和空 src 丢掉。 */
function readImages(root, limit = 12) {
  const urls = [];
  const seen = new Set();

  const metas = root.querySelectorAll
    ? root.querySelectorAll('meta[property="og:image"], meta[name="og:image"]')
    : [];
  for (const meta of metas) {
    const url = normalizeImageUrl(meta.getAttribute("content"));
    if (url && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }

  const images = root.querySelectorAll ? root.querySelectorAll("img") : [];
  for (const img of images) {
    if (urls.length >= limit) break;
    const url = normalizeImageUrl(
      img.currentSrc || img.src || img.getAttribute("data-src") || img.getAttribute("data-img"),
    );
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }

  return urls;
}

function readDescription(title) {
  const meta = document.querySelector(
    'meta[name="description"], meta[property="og:description"]',
  );
  const fromMeta = meta?.getAttribute("content")?.replace(/\s+/g, " ").trim();
  if (fromMeta && fromMeta.length >= 8 && fromMeta !== title) return fromMeta.slice(0, 4000);

  const blocks = [...document.querySelectorAll("p, article, [class*='desc'], [class*='Desc']")]
    .map((el) => (el.innerText || "").replace(/\s+/g, " ").trim())
    .filter(
      (text) =>
        text.length >= 20 &&
        text !== title &&
        !/人想要/.test(text) &&
        !/^[¥￥]/.test(text),
    );
  blocks.sort((a, b) => b.length - a.length);
  return blocks[0] ? blocks[0].slice(0, 4000) : undefined;
}

/** 商详页：从页面上读出来的字段。读不到的键直接不放。 */
function domFields() {
  const text = visibleText(4000);
  const heading = document.querySelector("h1")?.innerText?.trim();
  const title = heading || document.title.replace(/[-|]\s*闲鱼.*$/, "").trim();

  const fields = { itemId: extractItemId(location.href) };
  if (title) fields.title = title;
  const wants = readWants(text);
  if (wants !== undefined) fields.wants = wants;
  const views = readViews(text);
  if (views !== undefined) fields.views = views;
  const price = readPrice(text);
  if (price !== undefined) fields.price = price;
  const imageUrls = readImages(document, 12);
  if (imageUrls.length > 0) fields.imageUrls = imageUrls;
  const description = readDescription(title);
  if (description) fields.description = description;
  return fields;
}

/** 卡片容器：从链接往上找，找到有实际文字的那一层。 */
function cardOf(anchor) {
  let node = anchor;
  for (let hops = 0; node && hops < 6; hops += 1) {
    if ((node.innerText || "").trim().length >= 20) return node;
    node = node.parentElement;
  }
  return anchor;
}

/** 搜索结果页：每张卡片一条。层级记成 dom —— 它确实只是页面上的字。 */
function readCards() {
  const cards = new Map();

  for (const anchor of document.querySelectorAll('a[href*="id="], a[href*="/item/"]')) {
    const itemId = extractItemId(anchor.href);
    if (!itemId || cards.has(itemId)) continue;

    const container = cardOf(anchor);
    const lines = (container.innerText || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;

    const flat = lines.join(" ").replace(/\s+/g, " ");
    // 标题取最长的那行非价格文字，比猜类名耐造
    const title =
      lines
        .filter((line) => line.length >= 6 && !/^[¥￥\d]/.test(line))
        .sort((a, b) => b.length - a.length)[0] || lines[0];

    const card = {
      layer: "dom",
      itemId,
      url: anchor.href,
      title,
      visibleText: flat.slice(0, 400),
    };
    const price = readPrice(flat);
    if (price !== undefined) card.price = price;
    const wants = readWants(flat);
    if (wants !== undefined) card.wants = wants;
    const views = readViews(flat);
    if (views !== undefined) card.views = views;
    const imageUrls = readImages(container, 4);
    if (imageUrls.length > 0) card.imageUrls = imageUrls;

    cards.set(itemId, card);
  }

  return dropSharedImages([...cards.values()].slice(0, 60));
}

/**
 * 把每张卡上都出现的图丢掉。
 *
 * 卖家头像、活动横幅这类东西挂在每一张卡里，文件名上看不出是头像，
 * 但「所有商品的封面都一样」本身就说明它不是封面。
 */
function dropSharedImages(cards) {
  if (cards.length < 3) return cards;

  const counts = new Map();
  for (const card of cards) {
    for (const url of new Set(card.imageUrls || [])) {
      counts.set(url, (counts.get(url) || 0) + 1);
    }
  }
  const threshold = Math.max(3, Math.ceil(cards.length * 0.6));

  for (const card of cards) {
    if (!card.imageUrls) continue;
    const kept = card.imageUrls.filter((url) => (counts.get(url) || 0) < threshold);
    if (kept.length > 0) card.imageUrls = kept;
    else delete card.imageUrls;
  }
  return cards;
}

/** 店铺昵称，只用来给任务起个人看得懂的名字。读不到就算了。 */
function readShopName() {
  const heading = document.querySelector("h1, h2")?.innerText?.trim();
  if (heading && heading.length <= 40) return heading;
  const title = document.title.replace(/[-|]\s*闲鱼.*$/, "").trim();
  return title && title.length <= 40 ? title : undefined;
}

function itemIdsOnPage() {
  return [...document.querySelectorAll('a[href*="id="], a[href*="/item/"]')]
    .map((anchor) => extractItemId(anchor.href))
    .filter(Boolean);
}

function isNextPageLabel(text) {
  const t = String(text || "").replace(/\s+/g, "");
  return t === "下一页" || t === "下一页>" || t === "下一页›" || t === ">" || t === "›";
}

/** 找分页上的「下一页」。优先 aria-label，多个匹配取最后一个（通常在页底）。 */
function findNextPageControl() {
  const labeled = document.querySelector('[aria-label="下一页"]');
  if (
    labeled &&
    labeled.getAttribute("disabled") == null &&
    labeled.getAttribute("aria-disabled") !== "true"
  ) {
    return labeled;
  }

  const nodes = [...document.querySelectorAll("button, a, [role='button'], li")];
  const matches = nodes.filter((el) => {
    if (el.getAttribute("disabled") != null || el.getAttribute("aria-disabled") === "true") {
      return false;
    }
    return isNextPageLabel(el.innerText) || isNextPageLabel(el.getAttribute("aria-label"));
  });
  if (matches.length > 0) return matches[matches.length - 1];

  const current = document.querySelector('[aria-current="page"]');
  const pageNumber = Number((current?.innerText || "").trim());
  if (Number.isFinite(pageNumber) && pageNumber > 0) {
    const nextLabel = String(pageNumber + 1);
    return nodes.find((el) => (el.innerText || "").trim() === nextLabel);
  }
  return undefined;
}

function clickLikeUser(el) {
  el.scrollIntoView({ block: "center", inline: "nearest" });
  const opts = { bubbles: true, cancelable: true, view: window, buttons: 1 };
  el.dispatchEvent(new PointerEvent("pointerdown", opts));
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.dispatchEvent(new PointerEvent("pointerup", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.dispatchEvent(new MouseEvent("click", opts));
  if (typeof el.click === "function") el.click();
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 在当前标签里点「下一页」，等卡片换完再回话。 */
async function turnSearchPage() {
  const beforeIds = itemIdsOnPage();
  const beforeUrl = location.href;
  const control = findNextPageControl();
  if (!control) {
    return { ok: false, message: "这一页没有「下一页」。", ids: beforeIds };
  }

  clickLikeUser(control);

  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    await waitMs(250);
    const afterIds = itemIdsOnPage();
    const urlChanged = location.href !== beforeUrl;
    const idsChanged =
      afterIds.length > 0 && afterIds.slice(0, 5).join() !== beforeIds.slice(0, 5).join();
    if (urlChanged || idsChanged) {
      await waitMs(500);
      return { ok: true, ids: itemIdsOnPage() };
    }
  }
  return { ok: false, message: "点了下一页，但结果没换过来。", ids: itemIdsOnPage() };
}

async function buildSnapshot() {
  const type = pageType();
  const { captures, hydration } = await askInterceptor();

  const snapshot = {
    capturedAt: new Date().toISOString(),
    pageUrl: location.href,
    pageType: type,
  };

  const api = chooseCapture(captures, type);
  if (api !== undefined) snapshot.api = api;
  if (hydration !== undefined) snapshot.hydration = hydration;

  if (isListPage(type)) {
    snapshot.items = readCards();
    if (snapshot.items.length === 0) {
      return {
        ok: false,
        message:
          type === "shop"
            ? "这一页没找到在售商品，确认停在店铺的「在售」标签上了吗？"
            : "这一页没找到商品卡片，确认是搜索结果页吗？",
      };
    }
    if (type === "shop") {
      const sellerId = extractSellerId(location.href);
      if (!sellerId) {
        return {
          ok: false,
          message: "地址里没有 userId，认不出是哪家店。从同行商品的「进店铺」进来试试。",
        };
      }
      snapshot.sellerId = sellerId;
      snapshot.sellerName = readShopName();
    }
  } else {
    if (!extractItemId(location.href)) {
      return { ok: false, message: "地址里没有商品 id，先打开一个商品详情页。" };
    }
    snapshot.dom = domFields();
    snapshot.visibleText = visibleText();
  }

  return { ok: true, snapshot };
}

/**
 * 这一页调了哪些闲鱼接口。
 *
 * 找接口名本来只能靠 DevTools 抓包，或者靠猜（我们猜过一轮：14 个名字全错）。
 * 旁听器反正已经把页面自己发的请求记下来了，顺手报出来就省掉这件事。
 *
 * 同一个接口只留最近一次，按时间倒序。
 */
async function listApis() {
  const { captures } = await askInterceptor();
  const latest = new Map();

  for (const capture of captures) {
    if (!capture.api) continue;
    const seen = latest.get(capture.api);
    if (!seen || seen.at < capture.at) {
      latest.set(capture.api, {
        api: capture.api,
        version: capture.version,
        requestData: capture.requestData,
        at: capture.at,
      });
    }
  }

  return { ok: true, apis: [...latest.values()].sort((a, b) => b.at - a.at) };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.kind === "collect") {
    buildSnapshot()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, message: String(error?.message ?? error) }));
    // 告诉 Chrome 这是个异步回答
    return true;
  }

  if (message?.kind === "apis") {
    listApis()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, message: String(error?.message ?? error) }));
    return true;
  }

  if (message?.kind === "next-page") {
    turnSearchPage()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, message: String(error?.message ?? error) }));
    return true;
  }

  return undefined;
});
