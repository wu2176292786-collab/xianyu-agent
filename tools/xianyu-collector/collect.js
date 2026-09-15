/**
 * 隔离世界里的采集脚本。
 *
 * 弹窗点「加入研究」时，它把当前页面拼成一份快照：
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

function pageType() {
  const href = location.href;
  if (/\/item\b|[?&]id=\d/.test(href) && !/\/search/.test(href)) return "detail";
  if (/\/search|\/s\?|category/.test(href)) return "search";
  // 商详有 id、搜索页没有，认不出来就按有没有 id 兜底
  return extractItemId(href) ? "detail" : "search";
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
  return Number.isFinite(value) ? value : undefined;
}

function readPrice(text) {
  const match = text.match(/[¥￥]\s*([\d,]+(?:\.\d+)?)/);
  if (!match) return undefined;
  const value = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(value) ? value : undefined;
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
  const price = readPrice(text);
  if (price !== undefined) fields.price = price;
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

    cards.set(itemId, card);
  }

  return [...cards.values()].slice(0, 60);
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

  if (type === "search") {
    snapshot.items = readCards();
    if (snapshot.items.length === 0) {
      return { ok: false, message: "这一页没找到商品卡片，确认是搜索结果页吗？" };
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.kind !== "collect") return undefined;
  buildSnapshot()
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, message: String(error?.message ?? error) }));
  // 告诉 Chrome 这是个异步回答
  return true;
});
