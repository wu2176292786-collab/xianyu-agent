import { existsSync } from "node:fs";
import type { Page } from "playwright-core";
import { loadLoginState } from "@/lib/adapters/live/login-state";
import { clampSearchPages, cookiesFromHeader } from "./search-pager";
import { SEARCH_PAGE_GAP_MS } from "./scout";
import { parsePageSnapshot, type PageSnapshot, type ParseResult } from "./snapshot";

/**
 * 常见 Chrome 可执行文件位置。`CHROME_PATH` 永远优先，方便便携版、企业安装或
 * 非默认磁盘；其余位置覆盖 macOS、Windows 和 Linux 的默认安装。
 */
export function chromePathCandidates(
  platform = process.platform,
  configuredPath = process.env.CHROME_PATH,
): string[] {
  const defaults =
    platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : platform === "win32"
        ? [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          ]
        : ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"];

  return [configuredPath, ...defaults].filter((path): path is string => Boolean(path));
}

export function findChromePath(): string | undefined {
  return chromePathCandidates().find((path) => existsSync(path));
}

/**
 * 用本机 Chrome 打开搜索页，真点「下一页」连采几页。
 * 点不动或没浏览器时返回空，调用方再走接口翻页。
 */
export async function browseSearchPages(
  keyword: string,
  pageCount?: number,
): Promise<{
  ok: boolean;
  pages: ParseResult[];
  message?: string;
}> {
  const login = await loadLoginState();
  const chrome = findChromePath();
  if (!login?.cookie || !chrome) {
    return { ok: false, pages: [], message: "没有浏览器或登录态，改走接口翻页。" };
  }

  let playwright: typeof import("playwright-core");
  try {
    playwright = await import("playwright-core");
  } catch {
    return { ok: false, pages: [], message: "本机没有 playwright-core，改走接口翻页。" };
  }

  let browser: Awaited<ReturnType<typeof playwright.chromium.launch>> | undefined;
  try {
    browser = await playwright.chromium.launch({
      executablePath: chrome,
      headless: true,
      args: ["--disable-blink-features=AutomationControlled"],
    });
  } catch (error) {
    return {
      ok: false,
      pages: [],
      message: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const context = await browser.newContext({
      userAgent: login.headers["user-agent"],
      locale: "zh-CN",
      viewport: { width: 1280, height: 900 },
    });
    await context.addCookies(cookiesFromHeader(login.cookie));
    const page = await context.newPage();

    let lastSearchApi: unknown;
    page.on("response", (response) => {
      const url = response.url();
      if (!/idlemtopsearch|pc\.search|search\.pc/i.test(url)) return;
      void response
        .json()
        .then((json) => {
          lastSearchApi = json;
        })
        .catch(() => undefined);
    });

    await page.goto(`https://www.goofish.com/search?q=${encodeURIComponent(keyword)}`, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    await page.waitForSelector('a[href*="id="], a[href*="/item/"]', {
      timeout: 15000,
    });

    const limit = clampSearchPages(pageCount);
    const pages: ParseResult[] = [];
    for (let index = 1; index <= limit; index += 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, 500);
      });
      const snapshot = await extractSearchSnapshot(page, lastSearchApi);
      const parsed = parsePageSnapshot(snapshot, Date.now());
      if (parsed.items.length === 0) break;
      pages.push(parsed);
      if (index < limit) {
        const clicked = await clickNextSearchPage(page);
        if (!clicked) break;
        await new Promise((resolve) => {
          setTimeout(resolve, SEARCH_PAGE_GAP_MS);
        });
      }
    }

    return {
      ok: pages.length > 0,
      pages,
      message: pages.length > 0 ? `浏览器点了 ${pages.length} 页。` : "搜索页没读到卡片。",
    };
  } catch (error) {
    return {
      ok: false,
      pages: [],
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

async function extractSearchSnapshot(page: Page, api: unknown): Promise<PageSnapshot> {
  const items = await page.evaluate(() => {
    const extractItemId = (href: string) => {
      const query = href.match(/[?&]id=(\d+)/);
      if (query) return query[1];
      const path = href.match(/\/item\/(\d+)/);
      return path?.[1];
    };
    const cards = new Map<
      string,
      { layer: string; itemId: string; url: string; title: string; visibleText: string }
    >();
    for (const node of document.querySelectorAll('a[href*="id="], a[href*="/item/"]')) {
      const anchor = node as HTMLAnchorElement;
      const itemId = extractItemId(anchor.href);
      if (!itemId || cards.has(itemId)) continue;
      let container: HTMLElement | null = anchor;
      for (let hops = 0; container && hops < 6; hops += 1) {
        if ((container.innerText || "").trim().length >= 20) break;
        container = container.parentElement;
      }
      const lines = (container?.innerText || "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length === 0) continue;
      const title =
        lines.filter((line) => line.length >= 6 && !/^[¥￥\d]/.test(line)).sort((a, b) => b.length - a.length)[0] ||
        lines[0];
      cards.set(itemId, {
        layer: "dom",
        itemId,
        url: anchor.href,
        title: title ?? itemId,
        visibleText: lines.join(" ").slice(0, 400),
      });
    }
    return [...cards.values()].slice(0, 60);
  });

  return {
    capturedAt: new Date().toISOString(),
    pageUrl: page.url(),
    pageType: "search",
    ...(api !== undefined ? { api } : {}),
    items,
  };
}

async function clickNextSearchPage(page: Page): Promise<boolean> {
  const beforeUrl = page.url();
  const firstHref = await page.evaluate(() => {
    const anchor = document.querySelector(
      'a[href*="id="], a[href*="/item/"]',
    ) as HTMLAnchorElement | null;
    return anchor?.href ?? "";
  });

  const locators = [
    page.getByRole("button", { name: "下一页" }),
    page.getByRole("link", { name: "下一页" }),
    page.locator('[aria-label="下一页"]'),
    page.getByText("下一页", { exact: true }),
  ];

  let clicked = false;
  for (const locator of locators) {
    if ((await locator.count()) === 0) continue;
    const target = locator.last();
    try {
      await target.scrollIntoViewIfNeeded();
      await target.click({ timeout: 4000 });
      clicked = true;
      break;
    } catch {
      continue;
    }
  }

  if (!clicked) {
    clicked = await page.evaluate(() => {
      const nodes = [
        ...document.querySelectorAll("button, a, [role='button'], [aria-label]"),
      ] as HTMLElement[];
      const usable = nodes.filter(
        (el) =>
          el.getAttribute("disabled") == null &&
          el.getAttribute("aria-disabled") !== "true",
      );
      const labeled = usable.find((el) => el.getAttribute("aria-label") === "下一页");
      const matches = usable.filter((el) => {
        const text = (el.innerText || "").replace(/\s+/g, "");
        return text === "下一页" || text === "下一页>" || text === "下一页›";
      });
      const target = labeled ?? matches.at(-1);
      if (!target) return false;
      target.scrollIntoView({ block: "center" });
      target.click();
      return true;
    });
  }

  if (!clicked) return false;

  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const afterUrl = page.url();
    const afterHref = await page.evaluate(() => {
      const anchor = document.querySelector(
        'a[href*="id="], a[href*="/item/"]',
      ) as HTMLAnchorElement | null;
      return anchor?.href ?? "";
    });
    if (afterUrl !== beforeUrl || (afterHref && afterHref !== firstHref)) return true;
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }
  return false;
}
