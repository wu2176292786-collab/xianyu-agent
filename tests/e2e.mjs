/**
 * 浏览器冒烟测试：把审批、回复、擦亮、队列备单、规则开关跑一遍。
 *
 * 需要先起服务（`npm run dev` 或 `npm run build && npm run start`），然后：
 *   npm run test:e2e
 *
 * 用 playwright-core 驱动系统里已有的 Chrome，不下载额外的浏览器。
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

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
const results = [];
let failures = 0;

function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

/**
 * 测试第一步就点「重置示例数据」，会把同步来的真实数据冲掉。
 *
 * 所以先把状态文件抄一份，跑完（哪怕是崩了）再放回去 —— 在接了真实账号的
 * 机器上跑一次测试，不该让人重新同步一遍。
 */
const STATE_FILE =
  process.env.XIANYU_STATE_FILE ?? path.join(process.cwd(), ".data", "state.json");
let savedState = null;
try {
  savedState = await readFile(STATE_FILE, "utf8");
} catch {
  // 还没有状态文件，说明是干净环境，跑完也不用还原
}

async function restoreState() {
  if (savedState === null) return;
  try {
    await writeFile(STATE_FILE, savedState, "utf8");
    console.log("\n（已还原测试前的数据）");
  } catch (error) {
    console.error("\n⚠️  还原数据失败：", error?.message ?? error);
  }
}

function report() {
  console.log(results.join("\n"));
  console.log(`\n${results.length - failures}/${results.length} passed`);
}

// 中途崩了也要把已经跑过的结果打出来，否则看不到是哪一步开始坏的。
for (const event of ["uncaughtException", "unhandledRejection"]) {
  process.on(event, async (err) => {
    check("未预期的错误", false, String(err?.message ?? err).split("\n")[0]);
    report();
    await restoreState();
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
  const text = msg.text();
  // Next 的 RSC 预取和本地采集夹具里的图片请求都可能留下 404 控制台噪声；
  // 它们不是页面执行异常。真正的 runtime error 仍由 pageerror 与其余 error 捕获。
  const ignored = text.includes("_rsc") || /Failed to load resource:.*status of 404/.test(text);
  if (msg.type() === "error" && !ignored) pageErrors.push(text);
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
check("总览 renders KPI cards", /近 7 天曝光/.test(dash) && /在售商品/.test(dash));
check("总览 renders chart", /近 14 天流量与成交/.test(dash) && /每日成交额/.test(dash));
check("sidebar 没有订单", (await page.locator("aside nav").getByRole("link", { name: "订单" }).count()) === 0);
check(
  "总览提供手动刷新店铺商品数据",
  (await page.getByRole("button", { name: "刷新店铺数据" }).count()) === 1,
);
await clickUntil(
  page.getByRole("button", { name: "刷新店铺数据" }),
  page.locator("[data-sonner-toast]").first(),
);
await checkToast("手动刷新店铺数据 succeeds", /同步完成/);
await page.getByText(/上次刷新/).waitFor({ state: "visible", timeout: 8_000 });
check("总览显示店铺数据刷新时间", /上次刷新/.test(await text()));

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

// ---------- 6. 队列里确认备单 ----------
await page.goto(`${BASE}/queue`, { waitUntil: "networkidle" });
const shipCard = page.locator('[data-slot="card"]').filter({ hasText: "备货发出订单" }).first();
check("有超时备单建议", (await shipCard.count()) > 0);
const trackInput = page.locator('[role="dialog"] input').nth(1);
await clickUntil(shipCard.getByRole("button", { name: "编辑后通过" }), trackInput);
await trackInput.fill("SF999888777");
await page.locator('[role="dialog"]').getByRole("button", { name: "确认执行" }).click();
await page.waitForTimeout(2500);
await checkToast("备单执行成功", /已发货：/);

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
// 导入过凭证的机器上会显示「已导入」，没导入的显示「还没有导入」。
// 断言「一定没导入」会让这条测试依赖开发机的状态 —— 要验的是它如实报告。
check(
  "凭证状态如实报告（有就说有，没有就说没有）",
  /还没有导入登录态|游客/.test(livePanel) || /已导入/.test(livePanel),
);
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
check("热度监控板在研究台上", /热度监控/.test(researchText));
check(
  "缺失的字段如实显示，没有假装抽到",
  /可比但没抽到价格|没抽到/.test(researchText),
);

// 全局监控间隔是用户可见的设置：保存后刷新仍应生效；已有采样的货在
// 该间隔内必须保持不可重复采集，避免一次 UI 改动重新打开真实商详。
const watchInterval = page.getByLabel("全局监控间隔（小时）");
await watchInterval.fill("12");
await watchInterval.blur();
await checkToast("监控间隔可保存", /已设为每 12 小时采一次监控中的商品/);
await page.goto(`${BASE}/research`, { waitUntil: "networkidle" });
check("刷新后保留监控间隔", (await page.getByLabel("全局监控间隔（小时）").inputValue()) === "12");
const watchedDetailButton = page.getByRole("button", { name: "12 小时内已采过" });
check(
  "监控间隔内不允许重复采集",
  (await watchedDetailButton.count()) > 0 && (await watchedDetailButton.first().isDisabled()),
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
  // 真实商详响应会给出结构化标题；不能只靠可见文字，否则筛选器无法判断
  // 它是不是本任务的 OLED 同款，测试也就观察不到“缺想要”的页面状态。
  api: {
    data: {
      itemDO: {
        itemId: "900777",
        title: "Switch OLED 白色 成色九成新 无拆修",
        soldPrice: 1699,
      },
    },
  },
  visibleText: "Switch OLED 白色 成色九成新 无拆修",
});
check(
  "抽不到「想要」时如实报出来",
  /没抽到「想要」/.test(missingImport) && /新增 1 件同行商品/.test(missingImport),
  missingImport,
);

await page.goto(`${BASE}/research`, { waitUntil: "networkidle" });
const newRivalRow = page
  .locator("tbody tr")
  .filter({ hasText: "Switch OLED 白色 成色九成新 无拆修" })
  .first();
check("没抽到的字段在表里标成缺失", (await newRivalRow.innerText()).includes("没抽到"));

// 展开时间线，确认每条观察都带证据和抽取层级
const firstRow = page.locator("tbody tr").filter({ hasText: "812345001" }).first();
await clickUntil(
  firstRow.getByRole("button", { name: "文案" }),
  page.locator("text=页面接口").first(),
);
const timeline = await text();
check("时间线标出每个数是哪一层抽的", /页面接口|内嵌 JSON|可见文字/.test(timeline));
check("时间线区分商详与搜索", /商详/.test(timeline));
check(
  "展开文案后能收起",
  (await page.getByRole("button", { name: "收起" }).count()) >= 1,
);

// 人工标成不同款会直接移出同行表，存疑也不进这张表
const comparableRow = page.locator("tbody tr").filter({ hasText: "812345003" }).first();
await comparableRow.getByRole("button", { name: "不同款" }).click();
await checkToast("不同款会移出同行列表", /已移出同行列表/);
await page.goto(`${BASE}/research`, { waitUntil: "networkidle" });
check(
  "不同款不再出现在同行表",
  (await page.locator("tbody tr").filter({ hasText: "812345003" }).count()) === 0,
);
check(
  "存疑种子也不会进同行表",
  (await page.locator("tbody tr").filter({ hasText: "812345005" }).count()) === 0,
);

// ---------- 7.7 浏览器采集端：本机 API ----------
// 扩展走的是 HTTP，不是界面，所以这里直接按扩展的方式调一遍。
const collectorToken = JSON.parse(await readFile(DATA_FILE, "utf8")).state.research
  .collectorToken;
check("采集密钥已生成", /^[0-9a-f]{32}$/.test(collectorToken ?? ""));

const taskList = await fetch(
  `${BASE}/api/research/tasks?token=${encodeURIComponent(collectorToken)}`,
).then((r) => r.json());
check("采集端能列出研究任务", taskList.ok && taskList.tasks.length > 0);

const badToken = await fetch(`${BASE}/api/research/tasks?token=deadbeef`);
check("密钥不对就拒绝列任务", badToken.status === 401, String(badToken.status));

async function postSnapshot(body) {
  const response = await fetch(`${BASE}/api/research/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

// 扩展在商详页采到的形态：dom 层字段 + 可见文字。
// 用一件前面没碰过的商品，免得撞上 10 分钟去重窗口。
const collected = await postSnapshot({
  token: collectorToken,
  taskId: taskList.tasks[0].id,
  snapshot: {
    capturedAt: new Date().toISOString(),
    pageUrl: "https://www.goofish.com/item?id=900901",
    pageType: "detail",
    dom: {
      itemId: "900901",
      title: "Switch OLED 白色 国行 带塞尔达卡带 包邮",
      wants: 104,
      price: 1699,
    },
    visibleText: "104人想要 · 包邮 · 九成新",
  },
});
check(
  "采集端投商详快照会入库",
  collected.status === 200 &&
    /新增 1 件同行商品/.test(collected.body.message) &&
    /记录 1 条观察/.test(collected.body.message),
  collected.body.message,
);

const pulseAfter = await fetch(`${BASE}/api/research/pulse`).then((r) => r.json());
check("导入后研究台短戳会变", pulseAfter.ok && typeof pulseAfter.stamp === "string" && pulseAfter.stamp.length > 0);

// 搜索页一次铺多张卡片，抽不到「想要」的如实报出来
const bulk = await postSnapshot({
  token: collectorToken,
  taskId: taskList.tasks[0].id,
  snapshot: {
    capturedAt: new Date().toISOString(),
    pageUrl: "https://www.goofish.com/search?q=switch+oled",
    pageType: "search",
    items: [
      {
        layer: "dom",
        itemId: "900801",
        title: "Switch OLED 白色 带塞尔达",
        price: 1720,
        visibleText: "18人想要 包邮",
      },
      { layer: "dom", itemId: "900802", title: "Switch OLED 港版", price: 1610 },
    ],
  },
});
check(
  "采集端投搜索页会一次铺多件",
  bulk.status === 200 && /新增 2 件同行商品/.test(bulk.body.message),
  bulk.body.message,
);
check("抽不到「想要」的卡片如实报出来", /1 条没抽到「想要」/.test(bulk.body.message));

const wrongToken = await postSnapshot({ token: "nope", taskId: "RT001", snapshot: {} });
check("密钥不对就拒绝入库", wrongToken.status === 401, String(wrongToken.status));

const noSnapshot = await postSnapshot({ token: collectorToken, taskId: "RT001" });
check(
  "缺快照时说清缺什么",
  noSnapshot.status === 400 && /缺少页面快照/.test(noSnapshot.body.message),
  noSnapshot.body.message,
);

const unknownPage = await postSnapshot({
  token: collectorToken,
  taskId: taskList.tasks[0].id,
  snapshot: { pageUrl: "https://www.goofish.com/personal" },
});
check(
  "认不出商品时先说这个原因",
  unknownPage.status === 422 && /没认出任何商品/.test(unknownPage.body.message),
  unknownPage.body.message,
);

await page.goto(`${BASE}/research`, { waitUntil: "networkidle" });
const afterCollector = await text();
check("采集端投的观察出现在页面上", afterCollector.includes("104"));
check("页面上有采集端配对信息", /浏览器采集端/.test(afterCollector));

// ---------- 7.8 采集端读页面的那段代码 ----------
// 对着本地伪造的页面跑，不碰真实的闲鱼 —— 真站点上跑自动化正是这套设计要避免的事。
// 拦掉请求本地应答，所以这里一个字节都不会发到 goofish.com。
const DETAIL_FIXTURE = `<!doctype html><html lang="zh-CN"><head>
  <meta name="description" content="原盒全套，自用一年，功能正常，走闲鱼包邮。" />
  <meta property="og:image" content="https://img.alicdn.com/bao/uploaded/i1/detail-cover.jpg" />
</head><body>
  <h1>Nintendo Switch OLED 白色 主机 带塞尔达卡带</h1>
  <img src="https://img.alicdn.com/bao/uploaded/i1/detail-cover.jpg" alt="cover" />
  <div class="price">¥1,699.00</div>
  <div class="meta">86人想要 · 包邮 · 九成新</div>
  <p>原盒全套，自用一年，功能正常，走闲鱼包邮。</p>
</body></html>`;

const SEARCH_FIXTURE = `<!doctype html><html lang="zh-CN"><body>
  <div class="feed">
    <div class="card">
      <a href="https://www.goofish.com/item?id=700001">
        <img src="https://img.alicdn.com/bao/uploaded/i1/card-700001.jpg" alt="cover" />
      </a>
      <div>Switch OLED 白色 带塞尔达王国之泪</div>
      <div>¥1,720</div>
      <div>18人想要 包邮</div>
    </div>
    <div class="card">
      <a href="https://www.goofish.com/item?id=700002">
        <img src="https://img.alicdn.com/bao/uploaded/i1/card-700002.jpg" alt="cover" />
      </a>
      <div>Switch OLED 港版 单主机</div>
      <div>¥1,610</div>
    </div>
  </div>
</body></html>`;

await page.route("https://www.goofish.com/**", (route) => {
  const url = route.request().url();
  route.fulfill({
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: url.includes("/item") ? DETAIL_FIXTURE : SEARCH_FIXTURE,
  });
});

/** 把 collect.js 塞进页面里跑一遍，返回它拼出来的快照。 */
async function runCollector(url) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  // collect.js 结尾要注册消息监听，页面里没有扩展 API，给个空壳
  await page.evaluate(() => {
    window.chrome = { runtime: { onMessage: { addListener: () => {} } } };
  });
  await page.addScriptTag({ path: "tools/xianyu-collector/collect.js" });
  return page.evaluate(() => buildSnapshot());
}

const detailSnapshot = await runCollector("https://www.goofish.com/item?id=999123");
check("采集端认出这是商详页", detailSnapshot.ok && detailSnapshot.snapshot.pageType === "detail");
check(
  "采集端从商详页读出 id / 想要 / 价格",
  detailSnapshot.snapshot?.dom?.itemId === "999123" &&
    detailSnapshot.snapshot?.dom?.wants === 86 &&
    detailSnapshot.snapshot?.dom?.price === 1699,
  JSON.stringify(detailSnapshot.snapshot?.dom),
);
check(
  "采集端从商详页带上封面和正文",
  detailSnapshot.snapshot?.dom?.imageUrls?.[0]?.includes("detail-cover.jpg") &&
    /原盒全套/.test(detailSnapshot.snapshot?.dom?.description ?? ""),
  JSON.stringify(detailSnapshot.snapshot?.dom),
);
check(
  "采集端带上可见文字当证据",
  /86人想要/.test(detailSnapshot.snapshot?.visibleText ?? ""),
);
check(
  "页面没有接口响应时不编一个 api 层",
  detailSnapshot.snapshot?.api === undefined,
);

const searchSnapshot = await runCollector("https://www.goofish.com/search?q=switch+oled");
check(
  "采集端认出这是搜索页并铺出卡片",
  searchSnapshot.ok && searchSnapshot.snapshot.items?.length === 2,
  `${searchSnapshot.snapshot?.items?.length ?? 0} cards`,
);
const [firstCard, secondCard] = searchSnapshot.snapshot?.items ?? [];
check(
  "卡片带 itemId / 标题 / 价格 / 想要，并标成 dom 层",
  firstCard?.itemId === "700001" &&
    firstCard?.layer === "dom" &&
    firstCard?.price === 1720 &&
    firstCard?.wants === 18 &&
    /Switch OLED/.test(firstCard?.title ?? ""),
  JSON.stringify(firstCard),
);
check(
  "搜索卡片带上封面图",
  firstCard?.imageUrls?.[0]?.includes("card-700001.jpg"),
  JSON.stringify(firstCard?.imageUrls),
);
check(
  "卡片上没有「想要」就不给这个字段",
  secondCard?.itemId === "700002" && secondCard?.wants === undefined,
  JSON.stringify(secondCard),
);

// 把采到的两张卡片真的投进去，验证采集端 → API → 入库整条路是通的
const fromCollector = await postSnapshot({
  token: collectorToken,
  taskId: taskList.tasks[0].id,
  snapshot: searchSnapshot.snapshot,
});
check(
  "采集端真采到的快照能直接入库",
  fromCollector.status === 200 && /新增 2 件同行商品/.test(fromCollector.body.message),
  fromCollector.body.message,
);

// 「这一页调了哪些接口」：装一个假的旁听器，验证去重、排序和版本号解析。
// 找接口名以前只能开 DevTools 或者靠猜（猜过一轮，14 个名字全错）。
await page.goto("https://www.goofish.com/personal", { waitUntil: "domcontentloaded" });
await page.evaluate(() => {
  window.chrome = { runtime: { onMessage: { addListener: () => {} } } };

  // 冒充页面世界里的旁听器：收到 request 就回一批假的记录
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.channel !== "xianyu-collector" || data.kind !== "request") return;
    window.postMessage(
      {
        channel: "xianyu-collector",
        kind: "response",
        requestId: data.requestId,
        captures: [
          {
            api: "mtop.idle.web.xyh.item.list",
            version: "1.0",
            at: 1000,
            requestData: '{"userId":"1","pageNumber":1}',
          },
          // 同一个接口的旧记录，应该被更新的那条顶掉
          { api: "mtop.taobao.idlemessage.pc.session.sync", version: "3.0", at: 500 },
          {
            api: "mtop.taobao.idlemessage.pc.session.sync",
            version: "3.0",
            at: 2000,
            requestData: '{"fetchNum":20}',
          },
          // 没有 api 名字的记录要丢掉
          { api: "", version: "1.0", at: 3000 },
        ],
        hydration: undefined,
      },
      location.origin,
    );
  });
});
await page.addScriptTag({ path: "tools/xianyu-collector/collect.js" });
const apiReport = await page.evaluate(() => listApis());

check("采集端能报出这一页调了哪些接口", apiReport.ok && apiReport.apis.length === 2, `${apiReport.apis?.length ?? 0} 个`);
check(
  "同一个接口只留最近一次，按时间倒序",
  apiReport.apis?.[0]?.api === "mtop.taobao.idlemessage.pc.session.sync" &&
    apiReport.apis?.[0]?.requestData === '{"fetchNum":20}',
  JSON.stringify(apiReport.apis?.[0]),
);
check(
  "带上版本号和请求参数 —— 光有名字还得再猜一轮参数",
  apiReport.apis?.[0]?.version === "3.0" &&
    apiReport.apis?.[1]?.requestData === '{"userId":"1","pageNumber":1}',
  JSON.stringify(apiReport.apis?.[1]),
);

await page.unroute("https://www.goofish.com/**");

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
await restoreState();
process.exit(failures > 0 ? 1 : 0);
