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
// 故意让浏览器时区和服务端（UTC）不一致：时间格式化只要忘了钉死时区，
// hydration 就会报错，这里能第一时间抓到。
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  timezoneId: "Asia/Shanghai",
  locale: "zh-CN",
});

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
check("sidebar has 7 nav items", (await page.locator("aside nav a").count()) === 7);

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

// 配了 LLM 之后起草要等模型返回，不能再用固定等待。
await page.getByRole("button", { name: "让 Agent 起草" }).click();
const composer = page.locator("main textarea").first();
let drafted = "";
for (let i = 0; i < 40 && drafted.length === 0; i += 1) {
  await page.waitForTimeout(500);
  drafted = await composer.inputValue();
}
check("Agent 起草生成草稿", drafted.length > 10, `${drafted.length} chars`);
check("草稿里没有模型的思考过程", !/<think/i.test(drafted));
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

/**
 * 应用自己也在写这个文件，直接写一次可能被它的写入覆盖掉。
 * 写完回读确认，没写进去就再来一次。
 */
async function injectFailedAction(attempts = 4) {
  for (let i = 0; i < attempts; i += 1) {
    const stored = JSON.parse(await readFile(DATA_FILE, "utf8"));
    const staleListing = stored.state.listings.find(
      (l) => l.status === "on_sale" && l.stock > 0,
    );
    // 清掉此前可能残留的失败动作，让「有 1 条动作执行失败」成为确定的断言
    stored.state.actions = stored.state.actions.filter((a) => a.status !== "failed");
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

    await page.waitForTimeout(500);
    const after = JSON.parse(await readFile(DATA_FILE, "utf8"));
    const failed = after.state.actions.filter((a) => a.status === "failed");
    if (failed.length === 1 && failed[0].id === "ACT-e2e-failed") return true;
  }
  return false;
}

check("注入失败动作成功落盘", await injectFailedAction());

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

// ---------- 7.5 通道与安全 ----------
await page.goto(`${BASE}/automations`, { waitUntil: "networkidle" });
check("有通道与安全卡片", /通道与安全/.test(await text()));

// 从平台同步（读通道）
await clickUntil(
  page.getByRole("button", { name: "从平台同步" }),
  page.locator("[data-sonner-toast]").first(),
);
await checkToast("从平台同步可用", /同步完成/);

// 真实读通道的状态面板。这里**只切换不同步** —— 自动化测试绝不能去碰真实账号。
await clickUntil(
  page.locator("button").filter({ hasText: "真实闲鱼账号" }).first(),
  page.locator("text=商品接口：").first(),
);
const livePanel = await text();
check("切到真实读通道会显示凭证状态", /凭证：/.test(livePanel));
check("没导入登录态时如实说没导入", /还没有导入登录态|游客/.test(livePanel));
check("未配置的接口如实标出来", /未配置（同步时会保留本地/.test(livePanel));

await clickUntil(
  page.locator("button").filter({ hasText: "本地模拟数据" }).first(),
  page.locator("[data-sonner-toast]").first(),
);

// 切到演练模式
await clickUntil(
  page.locator("button").filter({ hasText: "演练（只记录不执行）" }).first(),
  page.locator("text=这个模式下「执行」不会真的改变任何东西").first(),
);
check("演练模式有全局横幅", /这个模式下「执行」不会真的改变任何东西/.test(await text()));

// 演练模式下擦亮：提示成功，但商品的擦亮时间不变
await page.goto(`${BASE}/listings`, { waitUntil: "networkidle" });
const beforeDryRun = await page.locator("tbody tr").first().innerText();
await page.locator("tbody tr").first().getByRole("button", { name: "擦亮" }).click();
await checkToast("演练模式下写操作被标记为演练", /演练/);
await page.goto(`${BASE}/listings`, { waitUntil: "networkidle" });
check(
  "演练模式下数据真的没变",
  (await page.locator("tbody tr").first().innerText()) === beforeDryRun,
);

// 急停
await page.goto(`${BASE}/automations`, { waitUntil: "networkidle" });
await clickUntil(
  page.getByRole("button", { name: "急停" }),
  page.locator("text=所有写操作已停止").first(),
);
await checkToast("急停生效", /已急停/);
check("急停后有全局横幅", /已急停/.test(await text()));

await page.goto(`${BASE}/listings`, { waitUntil: "networkidle" });
await page.locator("tbody tr").first().getByRole("button", { name: "擦亮" }).click();
await checkToast("急停时写操作被拒绝", /已急停/);

// 解除急停并切回本地模拟，别把状态留给后面的步骤
await page.goto(`${BASE}/automations`, { waitUntil: "networkidle" });
await clickUntil(
  page.getByRole("button", { name: "解除急停" }),
  page.locator("button").filter({ hasText: "本地模拟" }).first(),
);
await checkToast("可以解除急停", /已解除/);
await clickUntil(
  page.locator("button").filter({ hasText: "改本地数据，模拟平台反应" }).first(),
  page.locator("[data-sonner-toast]").first(),
);
await page.goto(`${BASE}/listings`, { waitUntil: "networkidle" });
await page.locator("tbody tr").first().getByRole("button", { name: "擦亮" }).click();
await checkToast("切回本地模拟后写操作恢复", /已擦亮/);

// ---------- 7.6 选品研究：同行「想要」观察 ----------
await page.goto(`${BASE}/research`, { waitUntil: "networkidle" });
const researchText = await text();
check("研究台渲染出来", /选品研究/.test(researchText) && /观察结论/.test(researchText));
check(
  "结论里的价格来自观察点",
  /可比同行的中位价是 ¥1,699\.00/.test(researchText),
);
check("结论挂着可以点回去的证据", (await page.locator('a[href*="goofish.com/item"]').count()) > 0);
check("回访清单按上次观察时间列出", /回访清单/.test(researchText));
check(
  "缺失的字段如实显示，没有假装抽到",
  /可比但没抽到价格|没抽到/.test(researchText),
);

/** 打开导入弹窗，粘贴一份快照，返回这次导入的提示文案。 */
async function importSnapshot(snapshot) {
  // 先等上一条提示自己消失，否则会把上一步的结果当成这一次的
  await page
    .locator("[data-sonner-toast]")
    .last()
    .waitFor({ state: "detached", timeout: 8000 })
    .catch(() => {});

  await clickUntil(
    page.getByRole("button", { name: "导入页面快照" }),
    page.locator("#snapshot"),
  );
  await page.locator("#snapshot").fill(JSON.stringify(snapshot));
  await page.locator('[role="dialog"]').getByRole("button", { name: "导入" }).click();

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const toasts = await page.locator("[data-sonner-toast]").allInnerTexts();
    if (toasts.length > 0) return toasts.at(-1).replace(/\n/g, " ");
    await page.waitForTimeout(150);
  }
  return "(没有看到提示)";
}

const capturedAt = new Date().toISOString();
const firstImport = await importSnapshot({
  capturedAt,
  pageUrl: "https://www.goofish.com/item?id=812345001",
  pageType: "detail",
  api: {
    data: {
      itemDO: {
        itemId: "812345001",
        title: "Nintendo Switch OLED 白色 主机 带塞尔达卡带 包邮",
        wantCnt: 97,
        soldPrice: 1699,
      },
    },
  },
});
check("导入商详快照会追加一条观察", /记录 1 条观察/.test(firstImport), firstImport);

await page.goto(`${BASE}/research`, { waitUntil: "networkidle" });
const afterImport = await text();
check("时间线用上了新观察", afterImport.includes("97"));
check("算出了相对上一次观察的增量", /\+4\b/.test(afterImport));

// 同一件商品短时间内再导一次 —— 刷新不该变成一次「波动」
const dedupeImport = await importSnapshot({
  capturedAt: new Date(Date.now() + 60_000).toISOString(),
  pageUrl: "https://www.goofish.com/item?id=812345001",
  pageType: "detail",
  visibleText: "97人想要 · 包邮",
});
check("窗口内的重复观察被合并", /短时重复已合并/.test(dedupeImport), dedupeImport);

// 抽不到「想要」时如实说抽不到，绝不写成 0
const missingImport = await importSnapshot({
  capturedAt,
  pageUrl: "https://www.goofish.com/item?id=900777",
  pageType: "detail",
  visibleText: "Switch OLED 白色 成色九成新 无拆修",
});
check(
  "抽不到「想要」时如实报出来",
  /没抽到「想要」/.test(missingImport) && /新增 1 件同行商品/.test(missingImport),
  missingImport,
);

await page.goto(`${BASE}/research`, { waitUntil: "networkidle" });
const newRivalRow = page.locator("tbody tr").filter({ hasText: "900777" }).first();
check("没抽到的字段在表里标成缺失", (await newRivalRow.innerText()).includes("没抽到"));

// 展开时间线，确认每条观察都带证据和抽取层级
const firstRow = page.locator("tbody tr").filter({ hasText: "812345001" }).first();
await clickUntil(
  firstRow.getByRole("button", { name: "时间线" }),
  page.locator("text=页面接口").first(),
);
const timeline = await text();
check("时间线标出每个数是哪一层抽的", /页面接口|内嵌 JSON|可见文字/.test(timeline));
check("时间线区分商详与搜索", /商详/.test(timeline));

// 人工改对齐结论：改过之后不该再被关键词判定覆盖
const uncertainRow = page.locator("tbody tr").filter({ hasText: "812345005" }).first();
await uncertainRow.getByRole("button", { name: "不同款" }).click();
await checkToast("可以人工改对齐结论", /已标记为「不同款」/);
await page.goto(`${BASE}/research`, { waitUntil: "networkidle" });
check(
  "人工标过的对齐结论标出来源",
  (await page.locator("tbody tr").filter({ hasText: "812345005" }).first().innerText()).includes(
    "人工",
  ),
);

// ---------- 8. mobile ----------
// 等提示条自己消失，否则窄屏下它会盖住顶部的菜单按钮
await page
  .locator("[data-sonner-toast]")
  .last()
  .waitFor({ state: "detached", timeout: 10_000 })
  .catch(() => {});
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

const hydrationErrors = pageErrors.filter((e) => /hydrat|didn't match/i.test(e));
check(
  "没有 hydration 报错（浏览器时区与服务端不同）",
  hydrationErrors.length === 0,
  hydrationErrors[0]?.slice(0, 160) ?? "",
);
check("没有页面级 JS 错误", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

report();
await browser.close();
process.exit(failures > 0 ? 1 : 0);
