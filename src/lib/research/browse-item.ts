import { lstat, mkdir, readFile, readlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page, Response } from "playwright-core";
import {
  loadLoginState,
  loginStateStamp,
  type LoginState,
} from "@/lib/adapters/live/login-state";
import { findChromePath } from "./browse-search";
import { cookiesFromHeader } from "./search-pager";
import { heatFromItemHtml, parsePageSnapshot, sellerFromRecord } from "./snapshot";

export interface ItemHeat {
  wants?: number;
  views?: number;
  visibleText?: string;
  /** 卖家主键，从商详响应里认。有了它界面上才能「进店铺」。 */
  sellerId?: string;
  sellerName?: string;
  /**
   * 商详那一条 mtop 响应，原样带回去。
   *
   * 正文在 `itemDO.desc`、大图在 `itemDO.imageInfos[].url`、浏览在 `itemDO.browseCnt`。
   * 只挑几个数出来就等于把正文和图扔了 —— 交给统一的解析路径去抽。
   */
  detailApi?: unknown;
  risk?: boolean;
  /** 页面根本没渲染出来。和风控是两回事，不该按风控停手。 */
  blank?: boolean;
}

/** 商详那一条 mtop 响应。同页还有 loginuser 之类，认错了卖家会变成自己。 */
const DETAIL_API = /idle\.pc\.detail|item\.detail|detail\.get/i;

function isDetailApi(json: unknown): boolean {
  if (!json || typeof json !== "object") return false;
  const api = (json as Record<string, unknown>).api;
  return typeof api === "string" && DETAIL_API.test(api);
}

/** 真的被要求过验证。认这些才值得停手。 */
const VERIFY_TEXT =
  /请完成验证|安全验证|滑动验证|滑块|异常访问|访问异常|系统检测|RGV587|captcha|punish|验证码/i;

/**
 * 闲鱼的通用报错页。
 *
 * 商品下架、接口失败、cookie 不对，看到的都是这一个「网络不见了」，
 * 跟风控没有必然关系 —— 当成风控的话，一件下架的货就能把整条链路停六小时。
 */
const BLANK_TEXT = /网络不见了|页面走丢|页面不存在/;

/**
 * 风控弹层的容器。文字要等前端渲染完才出得来，这几个节点插进 DOM 更早，
 * 认它们能在两秒内确诊，不用把十五秒超时耗满。
 */
const RISK_SELECTORS = [
  "div.baxia-dialog-mask",
  "#baxia-dialog-content",
  "div.J_MIDDLEWARE_FRAME_WIDGET",
  "iframe[src*='punish']",
  "iframe[id*='baxia']",
  "#nc_1_wrapper",
  ".nc-container",
];

/** mtop 被风控拦下时返回码里的标记。 */
const RISK_RET = /FAIL_SYS_USER_VALIDATE|RGV587|FAIL_SYS_ILLEGAL_ACCESS|ILLEGAL_REQUEST/i;

const HEAT_WANTS = /人想要/;
const HEAT_VIEWS = /\d[\d,.]*\s*浏览/;

export function isRiskText(text: string): boolean {
  return VERIFY_TEXT.test(text);
}

export function isBlankPageText(text: string): boolean {
  return BLANK_TEXT.test(text);
}

/**
 * 认 mtop 响应里的风控返回码。
 *
 * 接口被拦时 `ret` 是 `["FAIL_SYS_USER_VALIDATE::..."]`，HTTP 状态仍然是 200，
 * 页面上也不一定立刻有字，只能从这里看出来。
 */
export function isRiskRet(json: unknown): boolean {
  if (!json || typeof json !== "object") return false;
  const ret = (json as Record<string, unknown>).ret;
  const list = Array.isArray(ret) ? ret : typeof ret === "string" ? [ret] : [];
  return list.some((entry) => typeof entry === "string" && RISK_RET.test(entry));
}

export interface HeatBrowser {
  readItemHeat: (itemId: string, pageUrl: string) => Promise<ItemHeat | undefined>;
  close: () => Promise<void>;
}

export interface HeatBrowserStart {
  session?: HeatBrowser;
  error?: string;
}

/**
 * 只往 `.goofish.com` 上种，不要按子域铺一遍。
 *
 * `.goofish.com` 本来就覆盖 www / m / h5api 这些子域，真实浏览器里也是这么存的。
 * 按子域各种一份的话，一个请求会同时匹配父域和子域两条记录，
 * `_m_h5_tk` 被发两遍；服务端刷新时只更新其中一条，另一条永远是旧的，
 * mtop 用旧 token 算签名就会失败 —— 页面上看到的就是「网络不见了」。
 */
const COOKIE_DOMAIN = ".goofish.com";

/** 页面自己会刷新的令牌。profile 里已经有就别拿快照里的旧值盖掉。 */
const SELF_REFRESHING = new Set([
  "_m_h5_tk",
  "_m_h5_tk_enc",
  "x5sec",
  "tfstk",
  "cna",
  "isg",
]);

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function heatLog(step: string, detail: Record<string, unknown>) {
  console.warn(`[heat] ${step}`, detail);
}

function goofishCookies(cookieHeader: string) {
  return cookiesFromHeader(cookieHeader, COOKIE_DOMAIN).map((cookie) => ({
    ...cookie,
    secure: true,
    sameSite: "Lax" as const,
  }));
}

/**
 * 往 profile 里补登录 cookie。
 *
 * profile 是持久的，里面的 `_m_h5_tk`、`x5sec` 是浏览器自己跟服务端续出来的，
 * 比快照新。每次都照着快照全量覆盖，等于把新令牌换成旧的。
 * 所以默认只补 profile 里没有的；只有用户重新导了一份登录态，才整个换掉。
 */
export function cookiesToSeed<T extends { name: string }>(
  wanted: T[],
  existing: Set<string>,
  freshLogin: boolean,
): T[] {
  if (freshLogin) return wanted;
  return wanted.filter(
    (cookie) => !existing.has(cookie.name) || !SELF_REFRESHING.has(cookie.name),
  );
}

/**
 * 浏览器 profile 放哪。
 *
 * 固定一个目录，风控放行后种下的 x5sec、localStorage 里的设备指纹缓存才留得住；
 * 每次开全新 context 等于人工过的那次滑块白过了。
 * 里面有凭证，所以跟登录态一起放 `.secrets/`（已在 .gitignore 里）。
 */
export function heatProfileDir(): string {
  return (
    process.env.XIANYU_HEAT_PROFILE?.trim() ||
    path.join(process.cwd(), ".secrets", "heat-chrome-profile")
  );
}

const PROFILE_LOCK_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie"];

/** Chrome 把 SingletonLock 指到 `主机名-pid`。 */
export function pidFromSingletonTarget(target: string): number | undefined {
  const match = target.trim().match(/-(\d+)\s*$/);
  if (!match) return undefined;
  const pid = Number(match[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function readSingletonLockPid(profile: string): Promise<number | undefined> {
  const lock = path.join(profile, "SingletonLock");
  try {
    const info = await lstat(lock);
    if (info.isSymbolicLink()) {
      return pidFromSingletonTarget(path.basename(await readlink(lock)));
    }
    return pidFromSingletonTarget(await readFile(lock, "utf8"));
  } catch {
    return undefined;
  }
}

async function profileLockPresent(profile: string): Promise<boolean> {
  try {
    await lstat(path.join(profile, "SingletonLock"));
    return true;
  } catch {
    return false;
  }
}

async function removeProfileLockFiles(profile: string): Promise<void> {
  await Promise.all(
    PROFILE_LOCK_FILES.map((name) => unlink(path.join(profile, name)).catch(() => undefined)),
  );
}

/**
 * 上一轮 Chrome 崩了会留下 SingletonLock。占着的进程已经没了，就清掉再开。
 * 进程还在就不动，避免把正在采的那一轮掐死。
 */
export async function releaseStaleHeatProfile(profile: string): Promise<boolean> {
  if (!(await profileLockPresent(profile))) return true;
  const pid = await readSingletonLockPid(profile);
  if (pid !== undefined && processExists(pid)) return false;
  if (pid === undefined) return false;
  await removeProfileLockFiles(profile);
  return true;
}

async function waitForProfileUnlocked(profile: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await profileLockPresent(profile))) return true;
    const pid = await readSingletonLockPid(profile);
    if (pid !== undefined && !processExists(pid)) {
      await removeProfileLockFiles(profile);
      return true;
    }
    await sleep(200);
  }
  return !(await profileLockPresent(profile));
}

function isProfileBusyError(message: string): boolean {
  return /ProcessSingleton|already (in use|running)|SingletonLock/i.test(message);
}

export interface HeatContextOptions {
  userAgent: string;
  locale: string;
  timezoneId: string;
  viewport: { width: number; height: number };
  screen?: { width: number; height: number };
  deviceScaleFactor?: number;
  hasTouch?: boolean;
  isMobile?: boolean;
  colorScheme: "light";
  extraHTTPHeaders: Record<string, string>;
}

function looksMobile(userAgent: string): boolean {
  return /mobile|android|iphone/i.test(userAgent);
}

/**
 * 照着导出登录态那台机器重建 context。
 *
 * 扩展导出的 `env` 里有屏幕、时区、触摸点数这些，能还原多少还原多少；
 * 缺的字段退回保守默认值，不瞎编。
 */
export function contextOptionsFromLogin(login: LoginState): HeatContextOptions {
  const print = login.fingerprint;
  const userAgent = login.headers["user-agent"] ?? DEFAULT_USER_AGENT;
  const screen = print?.screen;
  const mobile = looksMobile(userAgent);

  return {
    userAgent,
    locale: print?.locale ?? login.headers["accept-language"]?.split(",")[0]?.trim() ?? "zh-CN",
    timezoneId: print?.timeZone ?? "Asia/Shanghai",
    // 屏幕高度要扣掉浏览器自己那一条，不然 viewport 会比屏幕还高
    viewport: screen
      ? { width: screen.width, height: Math.max(600, screen.height - 180) }
      : { width: 1280, height: 900 },
    screen,
    deviceScaleFactor: print?.devicePixelRatio,
    hasTouch: print?.maxTouchPoints !== undefined ? print.maxTouchPoints > 0 : undefined,
    isMobile: mobile || undefined,
    colorScheme: "light",
    extraHTTPHeaders: {
      "accept-language": login.headers["accept-language"] ?? "zh-CN,zh;q=0.9",
    },
  };
}

/** 注入脚本认得的那部分指纹。context 选项覆盖不到的属性只能在页面里改。 */
interface StealthInput {
  platform?: string;
  languages?: string[];
  hardwareConcurrency?: number;
  deviceMemory?: number;
  maxTouchPoints?: number;
}

function stealthInput(login: LoginState): StealthInput {
  const print = login.fingerprint;
  return {
    platform: print?.platform,
    languages: print?.languages,
    hardwareConcurrency: print?.hardwareConcurrency,
    deviceMemory: print?.deviceMemory,
    maxTouchPoints: print?.maxTouchPoints,
  };
}

/**
 * 抹掉自动化痕迹。
 *
 * 只改 `navigator.webdriver` 不够：无痕启动的 Chrome 没有插件、没有 `window.chrome`、
 * `permissions.query` 的返回也和真人不一样，这几项凑在一起就是一台机器人。
 */
function applyStealth(input: StealthInput) {
  const define = (name: string, value: unknown) => {
    try {
      Object.defineProperty(navigator, name, { get: () => value, configurable: true });
    } catch {
      // 某些属性在当前 Chrome 上不可重定义，跳过就是了
    }
  };

  define("webdriver", undefined);
  define("plugins", [1, 2, 3, 4, 5]);
  define("languages", input.languages ?? ["zh-CN", "zh", "en-US", "en"]);
  if (input.platform) define("platform", input.platform);
  if (input.hardwareConcurrency) define("hardwareConcurrency", input.hardwareConcurrency);
  if (input.deviceMemory) define("deviceMemory", input.deviceMemory);
  if (input.maxTouchPoints !== undefined) define("maxTouchPoints", input.maxTouchPoints);

  const scope = window as unknown as Record<string, unknown>;
  if (!scope.chrome) {
    scope.chrome = { runtime: {}, loadTimes: () => undefined, csi: () => undefined };
  }

  try {
    const original = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = ((parameters: PermissionDescriptor) =>
      parameters.name === "notifications"
        ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
        : original(parameters)) as typeof navigator.permissions.query;
  } catch {
    // 没有 permissions API 就算了
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function randomGap(min: number, max: number): number {
  return Math.round(min + Math.random() * (max - min));
}

/**
 * 闲鱼商详是前端渲染的，服务器直接抓 HTML 没有「N人想要」。
 * 用户点「补热度」时用本机 Chrome 打开那一页再读。
 */
export async function startHeatBrowser(
  options: { headed?: boolean } = {},
): Promise<HeatBrowserStart> {
  const login = await loadLoginState();
  if (!login?.cookie) {
    heatLog("start", { ok: false, reason: "no-login" });
    return { error: "没有登录态，没法用浏览器打开商详。" };
  }
  const chrome = findChromePath();
  if (!chrome) {
    heatLog("start", { ok: false, reason: "no-chrome" });
    return { error: "本机没找到 Chrome，补热度没法打开商详。" };
  }

  let playwright: typeof import("playwright-core");
  try {
    playwright = await import("playwright-core");
  } catch {
    heatLog("start", { ok: false, reason: "no-playwright" });
    return { error: "本机没有 playwright-core，补热度没法打开商详。" };
  }

  const headed = options.headed === true;
  const profile = heatProfileDir();
  const contextOptions = contextOptionsFromLogin(login);

  let context: BrowserContext | undefined;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const free = await releaseStaleHeatProfile(profile);
    if (!free) {
      if (attempt === 4) break;
      await sleep(400 * (attempt + 1));
      continue;
    }
    try {
      context = await playwright.chromium.launchPersistentContext(profile, {
        executablePath: chrome,
        headless: !headed,
        args: ["--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage"],
        ...contextOptions,
      });
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      heatLog("start", {
        ok: false,
        reason: "chrome-launch",
        chrome,
        headed,
        attempt,
        error: message,
      });
      if (!isProfileBusyError(message) || attempt === 4) {
        return {
          error: isProfileBusyError(message)
            ? "这个浏览器 profile 已经被另一个进程占着了。先关掉上一次补热度再试。"
            : "Chrome 没打开成。确认本机装了 Chrome。",
        };
      }
      await releaseStaleHeatProfile(profile);
      await sleep(400 * (attempt + 1));
    }
  }
  if (!context) {
    return {
      error: "这个浏览器 profile 已经被另一个进程占着了。先关掉上一次补热度再试。",
    };
  }
  const browser = context;
  heatLog("start", {
    ok: true,
    chrome,
    headed,
    profile,
    restoredFingerprint: Boolean(login.fingerprint),
  });

  await browser.addInitScript(applyStealth, stealthInput(login));
  await seedCookies(browser, login.cookie, profile);
  const page = browser.pages()[0] ?? (await browser.newPage());

  let warmed = false;
  return {
    session: {
      readItemHeat: async (itemId, pageUrl) => {
        if (!warmed) {
          const ok = await warmUp(page);
          warmed = true;
          if (!ok) return { risk: true, visibleText: "首页就弹了风控。" };
        }
        return readItemHeatFromPage(page, itemId, pageUrl);
      },
      close: async () => {
        await browser.close().catch(() => undefined);
        await waitForProfileUnlocked(profile, 8_000);
      },
    },
  };
}

/** profile 里上一次种的是哪一版登录态。只记版本戳，不含任何凭证。 */
function seedMarkerPath(profile: string): string {
  return path.join(profile, ".seeded-login");
}

async function seedCookies(
  context: BrowserContext,
  cookieHeader: string,
  profile: string,
): Promise<void> {
  const stamp = await loginStateStamp();
  const seeded = await readFile(seedMarkerPath(profile), "utf8").catch(() => undefined);
  const freshLogin = stamp !== undefined && stamp !== seeded?.trim();

  const wanted = goofishCookies(cookieHeader);
  const existing = new Set(
    (await context.cookies("https://www.goofish.com")).map((cookie) => cookie.name),
  );
  const toSeed = cookiesToSeed(wanted, existing, freshLogin);
  if (toSeed.length > 0) await context.addCookies(toSeed);

  if (freshLogin && stamp) {
    await mkdir(profile, { recursive: true });
    await writeFile(seedMarkerPath(profile), stamp, { encoding: "utf8", mode: 0o600 });
  }

  heatLog("cookies", {
    freshLogin,
    seeded: toSeed.length,
    keptFromProfile: wanted.length - toSeed.length,
    inProfile: existing.size,
  });
}

/**
 * 先在首页停一会儿再进商详。
 *
 * 一个刚起来的浏览器第一个请求就是 `item?id=`，行为上很扎眼；
 * 真人都是从首页点进去的。
 */
async function warmUp(page: Page): Promise<boolean> {
  try {
    await page.goto("https://www.goofish.com/", {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
  } catch (error) {
    // 首页没打开不算风控，让后面的商详自己去试
    heatLog("warmup", {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }

  await sleep(randomGap(900, 1900));
  await page
    .evaluate(() => {
      window.scrollBy(0, 200 + Math.random() * 500);
    })
    .catch(() => undefined);
  await sleep(randomGap(700, 1500));

  const verdict = await readVerdict(page);
  heatLog("warmup", { ok: verdict !== "risk", verdict });
  return verdict !== "risk";
}

export async function readItemHeatFromPage(
  page: Page,
  itemId: string,
  pageUrl: string,
): Promise<ItemHeat | undefined> {
  const url = pageUrl || `https://www.goofish.com/item?id=${itemId}`;
  const apis: unknown[] = [];
  const apiHints: Array<Record<string, unknown>> = [];
  const watch = { risk: undefined as string | undefined };
  const onResponse = (response: Response) => {
    const href = response.url();
    if (!/h5api|mtop/i.test(href)) return;
    void response
      .json()
      .then((json) => {
        apis.push(json);
        const path = href.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
        apiHints.push({ path, status: response.status(), ...apiHint(json) });
        if (isRiskRet(json)) watch.risk = path;
      })
      .catch(() => undefined);
  };
  page.on("response", onResponse);
  try {
    const gotoResult = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    const first = await waitForHeatOrRisk(page, watch, 15000);
    const text = await page.locator("body").innerText().catch(() => "");
    const title = await page.title().catch(() => "");
    const href = page.url();
    const snippet = heatSnippet(text);
    if (first === "risk" || isRiskText(text)) {
      // 响应回调是异步的，给它一拍时间落完，否则这里正好什么都看不到
      await sleep(600);
      heatLog("risk", {
        itemId,
        status: gotoResult?.status(),
        riskRetFrom: watch.risk,
        snippet,
        mtopCalls: apiHints.length,
        apis: apiHints.slice(0, 10),
      });
      return { risk: true, visibleText: snippet };
    }

    if (first === "blank" || isBlankPageText(text)) {
      await sleep(600);
      heatLog("blank", {
        itemId,
        status: gotoResult?.status(),
        snippet,
        mtopCalls: apiHints.length,
        apis: apiHints.slice(0, 10),
      });
      return { blank: true, visibleText: snippet };
    }

    // 卖家只认商详那一条响应。热度从哪一层来都行，卖家不行。
    const seller = sellerFromRecord(apis.find(isDetailApi));
    if (seller.sellerId) heatLog("seller", { itemId, sellerId: seller.sellerId });

    const fromText = heatFromVisibleText(text);
    heatLog("page", {
      itemId,
      status: gotoResult?.status(),
      title: title.slice(0, 80),
      href: href.slice(0, 120),
      sawHeatText: first === "heat",
      textLen: text.length,
      snippet,
      fromText,
      apis: apiHints.slice(0, 8),
    });
    // 商详响应说的是这一件自己的数，优先它。
    //
    // 整页文字不能先用：商详下方有推荐位，「477人想要」「6浏览」很可能
    // 分属推荐卡里的别的商品，抓到的是第一个匹配，不是这一件。
    const detail = apis.find(isDetailApi);
    const fromDetail = detail ? heatFromApi(url, detail, "") : undefined;
    if (fromDetail) {
      heatLog("detail-api", { itemId, wants: fromDetail.wants, views: fromDetail.views });
      return { ...fromDetail, ...seller, detailApi: detail };
    }
    // 热度没抽到也要把响应带回去 —— 正文和图在里面
    if (detail) {
      heatLog("detail-api", { itemId, note: "响应里没有热度，正文和图仍然带回去" });
      return { ...seller, detailApi: detail, visibleText: snippet };
    }

    if (fromText.wants !== undefined || fromText.views !== undefined) {
      heatLog("text-fallback", {
        itemId,
        wants: fromText.wants,
        views: fromText.views,
        note: "商详响应没给出热度，退回整页文字；推荐位可能串号",
      });
      return { ...fromText, ...seller };
    }

    for (const api of apis) {
      const fromApi = heatFromApi(url, api, text);
      if (fromApi) {
        heatLog("api", { itemId, wants: fromApi.wants, views: fromApi.views });
        return { ...fromApi, ...seller };
      }
    }

    const html = await page.content().catch(() => "");
    const fromHtml = heatFromItemHtml(html);
    heatLog("html", {
      itemId,
      htmlLen: html.length,
      wants: fromHtml.wants,
      views: fromHtml.views,
    });
    if (fromHtml.wants !== undefined || fromHtml.views !== undefined) {
      return { ...fromHtml, ...seller };
    }
    // 热度没读到，但卖家认出来了也值得带回去 —— 「进店铺」就靠它
    return seller.sellerId ? seller : undefined;
  } finally {
    page.off("response", onResponse);
  }
}

function apiHint(json: unknown): Record<string, unknown> {
  if (!json || typeof json !== "object") return { kind: typeof json };
  const record = json as Record<string, unknown>;
  return {
    api: typeof record.api === "string" ? record.api : undefined,
    ret: record.ret,
  };
}

function heatFromApi(url: string, api: unknown, text: string): ItemHeat | undefined {
  const parsed = parsePageSnapshot(
    {
      capturedAt: new Date().toISOString(),
      pageUrl: url,
      pageType: "detail",
      api,
      visibleText: text.slice(0, 4000),
    },
    Date.now(),
  );
  const item = parsed.items[0];
  if (!item || (item.wants === undefined && item.views === undefined)) return undefined;
  return {
    wants: item.wants,
    views: item.views,
    visibleText: text.slice(0, 400) || undefined,
  };
}

type Verdict = "risk" | "heat" | "blank" | "none";

/** 在页面里一次看完：要验证、热度出来了、还是干脆没渲染。 */
function readVerdict(page: Page): Promise<Verdict> {
  return page
    .evaluate(({ selectors, verify, blank, wants, views }): Verdict => {
      for (const selector of selectors) {
        const node = document.querySelector(selector);
        if (!node) continue;
        const style = window.getComputedStyle(node);
        if (style.display !== "none" && style.visibility !== "hidden") return "risk";
      }
      const text = document.body?.innerText ?? "";
      if (new RegExp(verify, "i").test(text)) return "risk";
      if (new RegExp(wants).test(text) && new RegExp(views).test(text)) return "heat";
      if (new RegExp(blank).test(text)) return "blank";
      return "none";
    }, {
      selectors: RISK_SELECTORS,
      verify: VERIFY_TEXT.source,
      blank: BLANK_TEXT.source,
      wants: HEAT_WANTS.source,
      views: HEAT_VIEWS.source,
    })
    .catch<Verdict>(() => "none");
}

async function waitForHeatOrRisk(
  page: Page,
  watch: { risk?: string },
  timeout: number,
): Promise<"heat" | "risk" | "blank" | "timeout"> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (watch.risk) return "risk";
    const verdict = await readVerdict(page);
    if (verdict !== "none") return verdict;
    await sleep(250);
  }
  return watch.risk ? "risk" : "timeout";
}

export function heatFromVisibleText(text: string): ItemHeat {
  return heatFromItemHtml(text);
}

function heatSnippet(text: string): string {
  const match = text.match(/.{0,20}(人想要|想要|浏览|网络不见了|滑块|验证).{0,20}/);
  if (match) return match[0].replace(/\s+/g, " ").trim();
  return text.replace(/\s+/g, " ").trim().slice(0, 80);
}
