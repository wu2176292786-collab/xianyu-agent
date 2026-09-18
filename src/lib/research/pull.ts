import { loginStateStamp } from "@/lib/adapters/live/login-state";
import { applyRivalAssets, recordObservations } from "@/lib/research/record";
import {
  startHeatBrowser,
  type HeatBrowser,
  type ItemHeat,
} from "@/lib/research/browse-item";
import { parsePageSnapshot } from "@/lib/research/snapshot";
import { getState, logActivity, mutateState } from "@/lib/store";
import {
  clampWatchIntervalHours,
  hasTodayDetailHeat,
  heatPauseHolds,
  heatRunDue,
  needsHeatFill,
  triedDetailToday,
} from "./heat";
import {
  WATCH_BATCH_GAP_MS,
  WATCH_BATCH_LIMIT,
  WATCH_DAILY_DETAIL_BUDGET,
  watchBlockMessage,
  watchEligibility,
  watchPullQueue,
} from "./monitoring";

export interface PullResult {
  ok: boolean;
  message: string;
  risk?: boolean;
  /** 接口被拦之后改从商品页 HTML 抽到的 */
  usedHtml?: boolean;
}

const RISK_PAUSE_MS = 6 * 60 * 60 * 1000;

/** 后台每 30 秒问一次，但开浏览器是重活，两轮之间至少隔这么久。 */
const AUTO_RUN_GAP_MS = WATCH_BATCH_GAP_MS;

/** 一轮最多开几件商详。剩下的等下一轮，不要一口气打几十页。 */
const BATCH_LIMIT = WATCH_BATCH_LIMIT;

/**
 * 一天最多开几件商详。
 *
 * 盯店之后同行件数可能上到两百，「每件每天都更新」等于浏览器整天不停开页。
 * 超出预算的排到明天 —— 队列按最久没采排，大店会摊到几天里轮着覆盖。
 */
const DAILY_DETAIL_BUDGET = WATCH_DAILY_DETAIL_BUDGET;

/** 两件之间随机停一会儿。一件接一件地打，节奏上就不像人。 */
const ITEM_GAP_MIN_MS = 4_000;
const ITEM_GAP_MAX_MS = 9_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function itemGap(): number {
  return Math.round(ITEM_GAP_MIN_MS + Math.random() * (ITEM_GAP_MAX_MS - ITEM_GAP_MIN_MS));
}

/** 用户点「补热度」时带浏览器，不再回过头打会被拦的商详接口。 */
export function shouldSkipHeatApi(options: {
  htmlOnly?: boolean;
  browser?: HeatBrowser;
}): boolean {
  return Boolean(options.browser || options.htmlOnly);
}

declare global {
  var __xianyuHeatBrowserLock: boolean | undefined;
}

async function withHeatLock(fn: () => Promise<PullResult>): Promise<PullResult> {
  if (globalThis.__xianyuHeatBrowserLock) {
    return { ok: true, message: "热度采集还在跑，这一轮跳过。" };
  }
  globalThis.__xianyuHeatBrowserLock = true;
  try {
    return await fn();
  } finally {
    globalThis.__xianyuHeatBrowserLock = false;
  }
}

/**
 * 去商详拉一件同行的想要 / 浏览 / 正文。
 *
 * 商详是前端渲染的，只能靠浏览器会话读，调用方必须把 browser 传进来。
 * 还没到监控间隔就不再打开；撞风控当场停手并进入暂停。
 */
export async function ingestRivalDetail(
  rivalId: string,
  options: {
    htmlOnly?: boolean;
    browser?: HeatBrowser;
    ignorePause?: boolean;
    /** 监控任务传入全局间隔；手动补数留空，始终允许补缺。 */
    intervalHours?: number;
    /** 批量跑到这件之前已经补上几件了，撞风控时写进日志 */
    pulledSoFar?: number;
  } = {},
): Promise<PullResult> {
  const state = await getState();
  const rival = state.research.rivals.find((item) => item.id === rivalId);
  if (!rival) return { ok: false, message: "找不到这件同行商品。" };
  if (state.channel.read !== "live") {
    return { ok: false, message: "读通道不是 live，没法去商详拉热度。" };
  }

  const pause = state.research.heatPull;
  if (!options.ignorePause && heatPauseHolds(pause, Date.now(), await loginStateStamp())) {
    return { ok: false, message: pauseMessage(pause) };
  }

  if (options.intervalHours !== undefined) {
    const eligibility = watchEligibility(rival, Date.now(), options.intervalHours);
    if (!eligibility.eligible) {
      return { ok: true, message: watchBlockMessage(eligibility) };
    }
  }

  if (shouldSkipHeatApi(options) || options.browser) {
    // 先记「试过」再去开。读崩了也算试过，否则这件会永远堵在队首
    if (options.browser) await noteDetailTry(rival.id, Date.now());
    const html = await ingestFromItemHtml(rival, options.browser);
    if (html.ok) return { ...html, usedHtml: true };
    if (html.risk) await applyRiskPause(Date.now(), options.pulledSoFar ?? 0, html.message);
    return html;
  }

  return {
    ok: false,
    message: "没有浏览器会话，读不了商详。也可以用采集端进商品页点「加入研究」。",
  };
}

function hasHeat(page: { wants?: number; views?: number } | undefined) {
  return page !== undefined && (page.wants !== undefined || page.views !== undefined);
}

async function ingestFromItemHtml(
  rival: {
    id: string;
    itemId: string;
    url: string;
  },
  browser?: HeatBrowser,
): Promise<PullResult> {
  if (!browser) {
    return {
      ok: false,
      message: "没有浏览器会话，读不了商详。也可以用采集端进商品页点「加入研究」。",
    };
  }

  const browsed = await browser.readItemHeat(rival.itemId, rival.url);
  if (browsed?.risk) {
    console.warn("[heat] browser-risk", { itemId: rival.itemId });
    return {
      ok: false,
      risk: true,
      message: "商品页弹出了风控，已经停手，不再刷新这一页。",
    };
  }
  // 「网络不见了」不是风控，别为了一件打不开的货把整条链路停六小时
  if (browsed?.blank) {
    console.warn("[heat] browser-blank", { itemId: rival.itemId });
    return {
      ok: false,
      message: "商品页没渲染出来（闲鱼返回「网络不见了」）。多半是这件已经下架，或者登录态该换了。",
    };
  }
  // 热度没读到，但认出卖家或者拿到了商详响应（正文、大图在里面），一样要入库
  if (browsed && (hasHeat(browsed) || browsed.sellerId || browsed.detailApi !== undefined)) {
    console.warn("[heat] browser", {
      itemId: rival.itemId,
      wants: browsed.wants,
      views: browsed.views,
      sellerId: browsed.sellerId,
      hasDetailApi: browsed.detailApi !== undefined,
    });
    return recordHeat(rival, browsed);
  }
  console.warn("[heat] browser-empty", { itemId: rival.itemId });
  return {
    ok: false,
    message: "已经打开了商品页，但没看到想要和浏览。请用采集端进商详再点加入研究。",
  };
}

async function recordHeat(
  rival: { id: string; itemId: string; url: string },
  page: ItemHeat,
): Promise<PullResult> {
  // 拿到了商详响应就整份交给解析，正文、大图、价格都在里面；
  // 只有响应没抓到时才退回「几个数拼一份快照」的老路。
  const snapshot =
    page.detailApi !== undefined
      ? {
          capturedAt: new Date().toISOString(),
          pageUrl: rival.url,
          pageType: "detail" as const,
          api: page.detailApi,
          visibleText: page.visibleText,
          sellerId: page.sellerId,
          // 接口没给的字段用页面上读到的兜底
          dom: {
            itemId: rival.itemId,
            wants: page.wants,
            views: page.views,
            sellerId: page.sellerId,
            sellerName: page.sellerName,
          },
        }
      : detailSnapshotFromHeat({
          itemId: rival.itemId,
          pageUrl: rival.url,
          wants: page.wants,
          views: page.views,
          visibleText: page.visibleText,
          sellerId: page.sellerId,
          sellerName: page.sellerName,
        });

  return recordDetail(rival.id, parsePageSnapshot(snapshot, Date.now()), true);
}

export function detailSnapshotFromHeat(input: {
  itemId: string;
  pageUrl: string;
  wants?: number;
  views?: number;
  visibleText?: string;
  sellerId?: string;
  sellerName?: string;
}) {
  return {
    capturedAt: new Date().toISOString(),
    pageUrl: input.pageUrl,
    pageType: "detail" as const,
    visibleText: input.visibleText,
    // 商详地址上没有 userId，卖家只能从响应里带过来
    sellerId: input.sellerId,
    dom: {
      itemId: input.itemId,
      wants: input.wants,
      views: input.views,
      sellerId: input.sellerId,
      sellerName: input.sellerName,
    },
  };
}

function recordDetail(
  rivalId: string,
  parsed: ReturnType<typeof parsePageSnapshot>,
  usedHtml = false,
): Promise<PullResult> {
  const item = parsed.items[0];
  if (!item) return Promise.resolve({ ok: false, message: "商详里没认出这件商品。" });

  return mutateState((next) => {
    const target = next.research.rivals.find((row) => row.id === rivalId);
    if (!target) return { ok: false, message: "找不到这件同行商品。" };
    recordObservations(next, target.taskId, parsed, Date.now());
    applyRivalAssets(target, item);
    const bits = [];
    if (item.copy) bits.push("正文");
    if (item.wants !== undefined) bits.push(`想要 ${item.wants}`);
    if (item.views !== undefined) bits.push(`浏览 ${item.views}`);
    if (bits.length === 0) {
      return { ok: false, message: "商详里没抽到正文和热度。" };
    }
    return {
      ok: true,
      usedHtml,
      message: usedHtml
        ? `从商品页补上${bits.join("、")}。`
        : `已补上${bits.join("、")}。`,
    };
  });
}

async function applyRiskPause(now: number, pulled: number, message: string) {
  const loginStamp = await loginStateStamp();
  return mutateState((next) => {
    next.research.heatPull = {
      ...next.research.heatPull,
      lastAttemptAt: new Date(now).toISOString(),
      lastMessage: message,
      pauseUntil: new Date(now + RISK_PAUSE_MS).toISOString(),
      pauseLoginStamp: loginStamp,
    };
    logActivity(
      next,
      "system",
      `热度采集撞风控，已停 6 小时。已采 ${pulled} 件。`,
      now,
    );
  });
}

function pauseMessage(pause: { pauseUntil?: string } | undefined): string {
  if (!pause?.pauseUntil) return "热度采集暂停中。";
  const until = new Date(pause.pauseUntil).toLocaleString("zh-CN", { hour12: false });
  return `上次撞了风控，暂停到 ${until}。重新导一份登录态可以提前解除。`;
}

export interface HeatSequenceOutcome {
  filled: number;
  missed: number;
  risk: boolean;
}

/**
 * 按顺序把这一批商详读完，中间留间隔，撞风控当场停手。
 *
 * 间隔做成参数，测试里传 0 就不用真等。
 */
export async function pullHeatSequence(
  browser: HeatBrowser,
  rivalIds: string[],
  nextGapMs: () => number = itemGap,
  intervalHours?: number,
): Promise<HeatSequenceOutcome> {
  let filled = 0;
  let missed = 0;
  for (const [index, rivalId] of rivalIds.entries()) {
    const result = await ingestRivalDetail(rivalId, {
      browser,
      // 外层已经判过一次暂停，别每件都去读一遍登录态
      ignorePause: true,
      intervalHours,
      pulledSoFar: filled,
    });
    if (result.risk) return { filled, missed, risk: true };
    if (result.ok) filled += 1;
    else missed += 1;
    if (index < rivalIds.length - 1) await sleep(nextGapMs());
  }
  return { filled, missed, risk: false };
}

/**
 * 开一次浏览器，跑完一批。
 *
 * 浏览器 profile 是持久的，开销主要在启动，所以一批共用一个会话。
 */
async function runHeatBatch(
  rivalIds: string[],
  label: string,
  now: number,
  intervalHours?: number,
): Promise<PullResult> {
  const started = await startHeatBrowser({
    headed: process.env.XIANYU_HEAT_HEADED === "1",
  });
  if (!started.session) {
    const message = started.error ?? "没能打开浏览器，这一轮不补了。";
    await noteAttempt(now, message);
    return { ok: false, message };
  }

  let outcome: HeatSequenceOutcome;
  try {
    outcome = await pullHeatSequence(started.session, rivalIds, itemGap, intervalHours);
  } finally {
    await started.session.close();
  }

  // 撞风控时 applyRiskPause 已经写过状态和日志了，别再盖一遍
  if (outcome.risk) {
    return {
      ok: false,
      risk: true,
      message: `${label}撞了风控，已经停手。这一轮补上 ${outcome.filled} 件。`,
    };
  }

  const message =
    outcome.filled > 0
      ? `${label}补上 ${outcome.filled} 件${outcome.missed > 0 ? `，${outcome.missed} 件没读到` : ""}。`
      : `${label}这一轮一件都没读到（试了 ${outcome.missed} 件）。`;
  await noteBatch(now, outcome.filled, message);
  return { ok: outcome.filled > 0, message };
}

function noteDetailTry(rivalId: string, now: number) {
  return mutateState((next) => {
    const target = next.research.rivals.find((row) => row.id === rivalId);
    if (target) target.lastDetailTryAt = new Date(now).toISOString();
  });
}

async function noteAttempt(now: number, message: string) {
  return mutateState((next) => {
    next.research.heatPull = {
      ...next.research.heatPull,
      lastAttemptAt: new Date(now).toISOString(),
      lastMessage: message,
    };
  });
}

async function noteBatch(now: number, filled: number, message: string) {
  const at = new Date(now).toISOString();
  return mutateState((next) => {
    next.research.heatPull = {
      ...next.research.heatPull,
      lastAttemptAt: at,
      lastFillAt: at,
      lastMessage: message,
      ...(filled > 0 ? { lastOkAt: at } : {}),
    };
    // message 里已经带了「每日热度」这类前缀，别再拼一遍
    if (filled > 0) logActivity(next, "agent", message, now);
  });
}

/**
 * 只开一件。界面上点「文案」这类按需动作走这里，
 * 拿到的是这一件自己的结果，不是一批的汇总。
 */
export async function runRivalDetailPull(
  rivalId: string,
  intervalHours?: number,
): Promise<PullResult> {
  return withHeatLock(() => pullOneRival(rivalId, Date.now(), intervalHours));
}

async function pullOneRival(
  rivalId: string,
  now: number,
  intervalHours?: number,
): Promise<PullResult> {
  const state = await getState();
  if (state.channel.read !== "live") {
    return { ok: false, message: "读通道不是 live，没法去商详拉热度。" };
  }
  const pause = state.research.heatPull;
  if (heatPauseHolds(pause, now, await loginStateStamp())) {
    return { ok: false, message: pauseMessage(pause) };
  }

  const started = await startHeatBrowser({
    headed: process.env.XIANYU_HEAT_HEADED === "1",
  });
  if (!started.session) {
    const message = started.error ?? "没能打开浏览器。";
    await noteAttempt(now, message);
    return { ok: false, message };
  }

  try {
    const result = await ingestRivalDetail(rivalId, {
      browser: started.session,
      ignorePause: true,
      intervalHours,
    });
    // 撞风控时 applyRiskPause 已经写过状态了，别再盖一遍
    if (!result.risk) await noteBatch(now, result.ok ? 1 : 0, result.message);
    return result;
  } finally {
    await started.session.close();
  }
}

export async function runMissingHeatPull(
  options: {
    taskId?: string;
    now?: number;
    limit?: number;
    ignorePause?: boolean;
    /** 后台调度来的。要守冷却，不能来一次开一次浏览器。 */
    auto?: boolean;
  } = {},
): Promise<PullResult> {
  return withHeatLock(() => fillMissingHeat(options));
}

async function fillMissingHeat(options: {
  taskId?: string;
  now?: number;
  limit?: number;
  ignorePause?: boolean;
  auto?: boolean;
}): Promise<PullResult> {
  const now = options.now ?? Date.now();
  const state = await getState();
  if (state.channel.read !== "live") {
    return { ok: false, message: "读通道不是 live，没法去商品页补浏览。" };
  }

  const pause = state.research.heatPull;
  if (!options.ignorePause && heatPauseHolds(pause, now, await loginStateStamp())) {
    return { ok: false, message: pauseMessage(pause) };
  }
  if (options.auto && !heatRunDue(pause, now, AUTO_RUN_GAP_MS)) {
    return { ok: true, message: "离上一轮自动补数还不够久，这一轮跳过。" };
  }

  const missing = state.research.rivals.filter(
    (rival) =>
      (!options.taskId || rival.taskId === options.taskId) &&
      rival.alignment === "comparable" &&
      needsHeatFill(rival) &&
      // 今天已经有数的进了批次也只会被跳过，却会被当成「补上一件」
      !hasTodayDetailHeat(rival, now) &&
      // 今天试过没成的别每半小时再试一遍
      !triedDetailToday(rival, now),
  );
  if (missing.length === 0) {
    return { ok: true, message: "这些商品都已经打开过商品页了。" };
  }

  const batch = missing.slice(0, Math.max(1, options.limit ?? BATCH_LIMIT));
  const result = await runHeatBatch(batch.map((rival) => rival.id), "补热度", now);
  const rest = missing.length - batch.length;
  return rest > 0
    ? { ...result, message: `${result.message}还有 ${rest} 件排在后面。` }
    : result;
}

/**
 * 盯住的商品按全局间隔采一次。只拉已到期的，
 * 一件一件来，撞风控就整轮停掉。
 */
export async function runWatchPull(now = Date.now()): Promise<PullResult> {
  return withHeatLock(() => watchPull(now));
}

async function watchPull(now: number): Promise<PullResult> {
  const state = await getState();
  if (state.channel.read !== "live") {
    return { ok: true, message: "读通道不是 live，监控自动采集跳过。" };
  }

  const pause = state.research.heatPull;
  if (heatPauseHolds(pause, now, await loginStateStamp())) {
    return { ok: true, message: pauseMessage(pause) };
  }

  const intervalHours = clampWatchIntervalHours(state.research.watchIntervalHours);
  const watched = state.research.rivals.filter((rival) => rival.watched);
  const due = watchPullQueue(watched, now, intervalHours);
  if (due.length === 0) {
    return { ok: true, message: `监控中的商品都还没到 ${intervalHours} 小时间隔。` };
  }
  if (!heatRunDue(pause, now, AUTO_RUN_GAP_MS)) {
    return { ok: true, message: "离上一轮还不够久，剩下的稍后再采。" };
  }

  const used = watched.filter((rival) => triedDetailToday(rival, now)).length;
  const budget = Math.max(0, DAILY_DETAIL_BUDGET - used);
  if (budget === 0) {
    return {
      ok: true,
      message: `今天的商详预算（${DAILY_DETAIL_BUDGET} 件）用完了，剩下 ${due.length} 件稍后再采。`,
    };
  }

  const batch = due.slice(0, Math.min(BATCH_LIMIT, budget));
  const result = await runHeatBatch(
    batch.map((rival) => rival.id),
    `每 ${intervalHours} 小时热度`,
    now,
    intervalHours,
  );
  const rest = due.length - batch.length;
  return rest > 0
    ? { ...result, message: `${result.message}还有 ${rest} 件排在后面。` }
    : result;
}
