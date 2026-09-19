import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

// 默认对着生产构建截图（`npm run start`），开发模式左下角会多一个 Next 调试浮标。
const BASE = process.env.BASE ?? "http://127.0.0.1:43117";
const DEFAULT_CHROME_PATHS =
  process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    : process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        ]
      : ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"];
const CHROME = [process.env.CHROME_PATH, ...DEFAULT_CHROME_PATHS].find(
  (candidate) => Boolean(candidate) && existsSync(candidate),
);
if (!CHROME) {
  throw new Error("找不到 Chrome；请设置 CHROME_PATH 为 Chrome 可执行文件路径。");
}
await mkdir("docs/screenshots", { recursive: true });

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 980 },
  deviceScaleFactor: 2,
});

await page.goto(`${BASE}/automations`, { waitUntil: "networkidle" });
await page.getByRole("button", { name: "重置示例数据" }).click();
await page.waitForTimeout(2500);

await page.goto(BASE, { waitUntil: "networkidle" });
await page.getByRole("button", { name: "运行 Agent" }).first().click();
await page.waitForTimeout(3000);
await page.mouse.move(1400, 960);
await page.waitForTimeout(4500); // 等 toast 消失
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
await page.screenshot({ path: "docs/screenshots/dashboard.png", fullPage: true });

await page.goto(`${BASE}/queue`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
await page.screenshot({ path: "docs/screenshots/queue.png", fullPage: true });

await page.goto(`${BASE}/inbox`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
await page.screenshot({ path: "docs/screenshots/inbox.png" });

await page.goto(`${BASE}/automations`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
await page.screenshot({ path: "docs/screenshots/automations.png", fullPage: true });

await page.goto(`${BASE}/research`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
await page.screenshot({ path: "docs/screenshots/research.png", fullPage: true });

await browser.close();
console.log("done");
