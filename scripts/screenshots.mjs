import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const BASE = "http://127.0.0.1:43117";
await mkdir("docs/screenshots", { recursive: true });

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome-stable",
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

await browser.close();
console.log("done");
