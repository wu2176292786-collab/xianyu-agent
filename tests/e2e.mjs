/**
 * 浏览器冒烟测试：把审批、回复、擦亮、发货、规则开关跑一遍。
 *
 * 需要先起服务（`npm run dev` 或 `npm run build && npm run start`），然后：
 *   npm run test:e2e
 *
 * 用 playwright-core 驱动系统里已有的 Chrome，不下载额外的浏览器。
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const BASE = process.env.BASE ?? "http://127.0.0.1:43117";
const CHROME =
  process.env.CHROME_PATH ?? "/usr/bin/google-chrome-stable";
const results = [];
let failures = 0;

function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function report() {
  console.log(results.join("\n"));
  console.log(`\n${results.length - failures}/${results.length} passed`);
}

// 中途崩了也要把已经跑过的结果打出来，否则看不到是哪一步开始坏的。
for (const event of ["uncaughtException", "unhandledRejection"]) {
  process.on(event, (err) => {
    check("未预期的错误", false, String(err?.message ?? err).split("\n")[0]);
    report();
    process.exit(1);
  });
}

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const pageErrors = [];
page.on("pageerror", (err) => pageErrors.push(err.message));
page.on("console", (msg) => {
  if (msg.type() === "error" && !msg.text().includes("_rsc")) pageErrors.push(msg.text());
});

const text = () => page.locator("body").innerText();

/**
 * 点到目标出现为止。
 *
 * 开发模式下路由是按需编译的，页面可能还没 hydrate 完就被点了，
 * 这时第一次点击会石沉大海。
 */
async function clickUntil(trigger, expected, attempts = 6) {
  for (let i = 0; i < attempts; i += 1) {
    await trigger.click();
    try {
      await expected.waitFor({ state: "visible", timeout: 2500 });
      return true;
    } catch {
      await page.waitForTimeout(500);
    }
  }
  return false;
}

/** 等到出现符合预期的 toast，避免读到上一步残留的提示。 */
async function checkToast(name, pattern, timeout = 8000) {
  const deadline = Date.now() + timeout;
  let seen = "";
  while (Date.now() < deadline) {
    const all = await page.locator("[data-sonner-toast]").allInnerTexts();
    const hit = all.find((t) => pattern.test(t));
    if (hit) {
      check(name, true, hit.replace(/\n/g, " "));
      return;
    }
    if (all.length > 0) seen = all[all.length - 1];
    await page.waitForTimeout(200);
  }
  check(name, false, `最后看到的提示：${seen.replace(/\n/g, " ") || "(无)"}`);
}

// ---------- 0. 回到干净的示例数据，保证可重复运行 ----------
await page.goto(`${BASE}/automations`, { waitUntil: "networkidle" });
await clickUntil(
  page.getByRole("button", { name: "重置示例数据" }),
  page.locator("[data-sonner-toast]").first(),
);
await checkToast("重置示例数据", /已重置/);

// ---------- 1. dashboard ----------
await page.goto(BASE, { waitUntil: "networkidle" });
const dash = await text();
check("总览 renders KPI cards", /近 7 天曝光/.test(dash) && /待发货订单/.test(dash));
check("总览 renders chart", /近 14 天流量与成交/.test(dash) && /每日成交额/.test(dash));
check("sidebar has 6 nav items", (await page.locator("aside nav a").count()) === 6);

// ---------- 2. run the agent ----------
await clickUntil(
  page.getByRole("button", { name: "运行 Agent" }).first(),
  page.locator("[data-sonner-toast]").first(),
);
await checkToast("运行 Agent shows toast", /Agent 自动执行|没有新建议/);
// router.refresh() 之后页面才会重新渲染，开发模式下会慢一点。
await page
  .locator("text=审批队列是空的")
  .waitFor({ state: "detached", timeout: 10_000 })
  .catch(() => {});
const afterTick = await text();
check("待你确认 now has suggestions", /待你确认/.test(afterTick) && !/审批队列是空的/.test(afterTick));

// ---------- 3. queue ----------
await page.goto(`${BASE}/queue`, { waitUntil: "networkidle" });
const pendingCount = await page.locator('[data-slot="card"]').count();
check("行动队列 lists pending suggestions", pendingCount > 0, `${pendingCount} cards`);

// 3a. edit-then-approve a drafted reply
const replyCard = page.locator('[data-slot="card"]').filter({ hasText: "回复「" }).first();
check("有回复类建议", (await replyCard.count()) > 0);
const textarea = page.locator('[role="dialog"] textarea').first();
check(
  "编辑对话框能打开",
  await clickUntil(replyCard.getByRole("button", { name: "编辑后通过" }), textarea),
);
const original = await textarea.inputValue();
check("草稿非空", original.length > 10, `${original.length} chars`);
await textarea.fill(`${original}\n（这句是我手动加的）`);
await page.locator('[role="dialog"]').getByRole("button", { name: "确认执行" }).click();
await page.waitForTimeout(2500);
await checkToast("编辑后通过 succeeds", /已回复/);

// 3b. floor price guard
const priceCard = page.locator('[data-slot="card"]').filter({ hasText: "降价" }).first();
check("有降价建议", (await priceCard.count()) > 0);
const priceInput = page.locator('[role="dialog"] input').first();
await clickUntil(priceCard.getByRole("button", { name: "编辑后通过" }), priceInput);
await priceInput.fill("1");
await page.locator('[role="dialog"]').getByRole("button", { name: "确认执行" }).click();
await page.waitForTimeout(2000);
await checkToast("低于底价被拒绝", /低于底价/);
await page.keyboard.press("Escape");
await page.waitForTimeout(500);

// 3c. approve the price drop normally
const priceCard2 = page.locator('[data-slot="card"]').filter({ hasText: "降价" }).first();
await priceCard2.getByRole("button", { name: "通过并执行" }).click();
await page.waitForTimeout(2500);
await checkToast("降价通过后价格变化", /价格 ¥/);

// 3d. reject one
const anyCard = page.locator('[data-slot="card"]').first();
const anyTitle = (await anyCard.innerText()).split("\n")[0];
await anyCard.getByRole("button", { name: "忽略" }).click();
await page.waitForTimeout(2000);
await checkToast("忽略 works", /已忽略/);

await page.getByRole("tab", { name: /已忽略/ }).click();
await page.waitForTimeout(800);
check("已忽略 tab lists it", (await text()).includes(anyTitle.slice(0, 8)));
await page.getByRole("tab", { name: /已执行/ }).click();
await page.waitForTimeout(800);
check("已执行 tab non-empty", !/还没有执行过任何动作/.test(await text()));

// ---------- 4. inbox ----------
await page.goto(`${BASE}/inbox`, { waitUntil: "networkidle" });
const listButtons = page.locator("div.rounded-lg.border button");
const convCount = await listButtons.count();
check("收件箱有会话列表", convCount >= 5, `${convCount} conversations`);

const threadFirst = await page.locator("main").innerText();
await listButtons.nth(2).click();
await page.waitForTimeout(800);
const threadSecond = await page.locator("main").innerText();
check("切换会话后对话内容变化", threadFirst !== threadSecond);

await page.getByRole("button", { name: "让 Agent 起草" }).click();
await page.waitForTimeout(2500);
const composer = page.locator("main textarea").first();
const drafted = await composer.inputValue();
check("Agent 起草生成草稿", drafted.length > 10, `${drafted.length} chars`);
await page.getByRole("button", { name: "发送" }).click();
await page.waitForTimeout(2500);
await checkToast("回复发送成功", /已回复/);
check("消息出现在对话里", (await page.locator("main").innerText()).includes(drafted.slice(0, 12)));

// ---------- 5. listings ----------
await page.goto(`${BASE}/listings`, { waitUntil: "networkidle" });
const rows = await page.locator("tbody tr").count();
check("商品表有 11 行", rows === 11, `${rows} rows`);
const firstRefresh = page.locator("tbody tr").first().getByRole("button", { name: "擦亮" });
await firstRefresh.click();
await page.waitForTimeout(2200);
await checkToast("擦亮 succeeds", /已擦亮/);
const firstRowText = await page.locator("tbody tr").first().innerText();
check("上次擦亮 变成刚刚", /刚刚/.test(firstRowText));

// price edit
const listingPrice = page.locator('[role="dialog"] input').first();
await clickUntil(
  page.locator("tbody tr").first().getByRole("button", { name: "改价" }),
  listingPrice,
);
await listingPrice.fill("1");
await page.locator('[role="dialog"]').getByRole("button", { name: "保存" }).click();
await page.waitForTimeout(1800);
await checkToast("手动改价也被底价拦住", /低于底价/);
await page.keyboard.press("Escape");

// ---------- 6. orders ----------
await page.goto(`${BASE}/orders`, { waitUntil: "networkidle" });
const shipButtons = page.getByRole("button", { name: "发货" });
const shipCount = await shipButtons.count();
check("有待发货订单", shipCount > 0, `${shipCount} shippable`);
if (shipCount > 0) {
  const trackInput = page.locator('[role="dialog"] input').nth(1);
  await clickUntil(shipButtons.first(), trackInput);
  await trackInput.fill("SF999888777");
  await page.locator('[role="dialog"]').getByRole("button", { name: "确认发货" }).click();
  await page.waitForTimeout(2500);
  await checkToast("发货成功", /已发货：/);
  check("订单表出现运单号", (await text()).includes("SF999888777"));
}

// ---------- 6.5 执行失败与重试 ----------
// 模拟通道几乎不会失败，这里直接往状态里塞一条失败动作，验证失败标签页和重试。
const DATA_FILE = path.join(process.cwd(), ".data", "state.json");
const stored = JSON.parse(await readFile(DATA_FILE, "utf8"));
const staleListing = stored.state.listings.find(
  (l) => l.status === "on_sale" && l.stock > 0,
);
stored.state.actions.unshift({
  id: "ACT-e2e-failed",
  ruleId: "R-refresh",
  ruleKind: "refresh_listing",
  title: `擦亮「${staleListing.title}」`,
  reason: "e2e 注入的失败动作",
  risk: "low",
  status: "failed",
  createdAt: new Date().toISOString(),
  payload: { type: "refresh_listing", listingId: staleListing.id },
  failureReason: "平台返回了 503",
  attempts: 1,
});
await writeFile(DATA_FILE, JSON.stringify(stored, null, 2), "utf8");

await page.goto(BASE, { waitUntil: "networkidle" });
const dashWithFailure = await text();
check("总览提示执行失败", /有 1 条动作执行失败/.test(dashWithFailure));

await clickUntil(
  page.locator('a[href="/queue?tab=failed"]'),
  page.locator('[data-slot="card"]').filter({ hasText: "平台返回了 503" }).first(),
);
const queueBody = await text();
const failedTabLabel = await page.getByRole("tab").filter({ hasText: "执行失败" }).innerText();
check("失败动作进入执行失败标签页", /执行失败（1）/.test(failedTabLabel), failedTabLabel);
check("失败原因展示出来", queueBody.includes("平台返回了 503"));

const failedCard = page.locator('[data-slot="card"]').filter({ hasText: "平台返回了 503" }).first();
await failedCard.getByRole("button", { name: "重试" }).click();
await checkToast("重试成功", /已擦亮/);
await page.goto(`${BASE}/queue`, { waitUntil: "networkidle" });
check("重试成功后离开失败列表", /执行失败（0）/.test(await text()));

// ---------- 7. automations ----------
await page.goto(`${BASE}/automations`, { waitUntil: "networkidle" });
const ruleCards = await page.locator('[data-slot="card"]').count();
check("自动化页面有规则卡片", ruleCards >= 5, `${ruleCards} cards`);

const automationsText = await text();
check("有自动巡检设置卡片", /自动巡检/.test(automationsText) && /巡检间隔/.test(automationsText));
check("有巡检记录", /最近巡检/.test(automationsText));
check("展示下次巡检时间", /下次巡检/.test(automationsText));
// 只点规则卡片上的开关，别误伤自动巡检的开关
const ruleSwitch = page.locator('[aria-label^="开关 "]').first();
await ruleSwitch.click();
await checkToast("规则开关可用", /已关闭「|已开启「/);
await ruleSwitch.click();
await page.waitForTimeout(1500);
check("自动巡检保持开启", await page.locator('[aria-label="自动巡检开关"]').getAttribute("data-checked") !== null);

// ---------- 8. mobile ----------
await page.setViewportSize({ width: 420, height: 860 });
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(600);
check("移动端隐藏侧边栏", !(await page.locator("aside").first().isVisible()));
const burger = page.getByRole("button", { name: "打开菜单" });
check("移动端有菜单按钮", await burger.isVisible());
await burger.click();
await page.waitForTimeout(900);
check("抽屉里有导航", (await page.locator('[role="dialog"]').innerText()).includes("行动队列"));
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
const overflow = await page.evaluate(
  () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
);
check("移动端无横向溢出", overflow <= 1, `overflow ${overflow}px`);

await page.goto(`${BASE}/inbox`, { waitUntil: "networkidle" });
const inboxOverflow = await page.evaluate(
  () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
);
check("移动端收件箱无横向溢出", inboxOverflow <= 1, `overflow ${inboxOverflow}px`);

check("没有页面级 JS 错误", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

report();
await browser.close();
process.exit(failures > 0 ? 1 : 0);
