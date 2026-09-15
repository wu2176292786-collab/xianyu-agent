#!/usr/bin/env node
/**
 * 真实通道的排查工具。在你自己的机器上跑，凭证只从环境变量读，不会写到任何地方。
 *
 *   npm run xianyu:probe                      检查凭证 + 验证已知接口是否存在
 *   npm run xianyu:probe -- --api mtop.xxx    验证某个接口名是否存在
 *   npm run xianyu:probe -- --call mtop.xxx   带凭证真的调一次，并打印返回结构
 *
 * 怎么拿 cookie：浏览器登录 www.goofish.com → F12 → Network → 随便点一个
 * h5api.m.goofish.com 的请求 → 复制请求头里的整条 Cookie，放进 .env.local 的
 * XIANYU_COOKIE。这串东西等同于你的账号，别贴给任何人、别提交进仓库。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const HOST = "https://h5api.m.goofish.com";
const APP_KEY = "12574478";

function loadEnvLocal() {
  try {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
    }
  } catch {
    // 没有 .env.local 也没关系，直接用环境变量
  }
}

function args() {
  const out = {};
  for (let i = 2; i < process.argv.length; i += 1) {
    const key = process.argv[i];
    if (key.startsWith("--")) out[key.slice(2)] = process.argv[i + 1] ?? true;
  }
  return out;
}

function redact(cookie) {
  if (!cookie) return "(未配置)";
  const names = cookie
    .split(";")
    .map((pair) => pair.split("=")[0]?.trim())
    .filter(Boolean);
  return `${names.length} 个字段（${names.slice(0, 8).join(", ")}${names.length > 8 ? " …" : ""}）`;
}

function sign(token, t, data) {
  return createHash("md5").update(`${token}&${t}&${APP_KEY}&${data}`).digest("hex");
}

async function call(api, { cookie = "", payload = {} } = {}) {
  const token = cookie.match(/_m_h5_tk=([^;_]+)_/)?.[1] ?? "";
  const t = String(Date.now());
  const data = JSON.stringify(payload);
  const query = new URLSearchParams({
    jsv: "2.7.2",
    appKey: APP_KEY,
    t,
    sign: sign(token, t, data),
    v: "1.0",
    type: "originaljson",
    dataType: "json",
    api,
    data,
  });

  const response = await fetch(`${HOST}/h5/${api}/1.0/?${query}`, {
    headers: {
      accept: "application/json",
      referer: "https://www.goofish.com/",
      ...(cookie ? { cookie } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  return response.json();
}

function retOf(body) {
  return body?.ret?.[0] ?? "(没有 ret)";
}

/** 递归列出叶子路径，用来对照 src/lib/adapters/live/mapping.ts 里的候选字段。 */
function shape(value, prefix = "", depth = 0, out = []) {
  if (depth > 4 || value === null || typeof value !== "object") {
    out.push(`  ${prefix} = ${JSON.stringify(value)?.slice(0, 70)}`);
    return out;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) out.push(`  ${prefix}[] (空)`);
    else shape(value[0], `${prefix}[0]`, depth + 1, out);
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    shape(child, prefix ? `${prefix}.${key}` : key, depth + 1, out);
  }
  return out;
}

const KNOWN = [
  ["mtop.idle.web.xyh.item.list", "商品列表（已确认存在）"],
  ["mtop.idle.web.user.page.head", "用户主页（已确认存在）"],
  ["mtop.idle.web.user.page.nav", "用户导航（已确认存在）"],
  ["mtop.idle.web.trade.bought.list", "买到的订单（已确认存在）"],
];

loadEnvLocal();
const opts = args();
const cookie = (process.env.XIANYU_COOKIE ?? "").trim();

console.log("凭证：", redact(cookie));
if (cookie) {
  const hasSession = /(^|;\s*)(unb|cookie2|_tb_token_)=/.test(cookie);
  console.log("登录态字段：", hasSession ? "有" : "没有 —— 可能只复制了游客 cookie");
}
console.log();

if (opts.call) {
  if (!cookie) {
    console.error("--call 需要先配置 XIANYU_COOKIE。");
    process.exit(1);
  }
  const payload = opts.data ? JSON.parse(opts.data) : { pageNumber: 1, pageSize: 10 };
  const body = await call(opts.call, { cookie, payload });
  console.log(`调用 ${opts.call} → ${retOf(body)}\n`);
  if (body?.data) {
    console.log("返回结构（把这些路径填进 mapping.ts 的候选列表）：");
    console.log(shape(body.data).slice(0, 60).join("\n"));
  }
  process.exit(0);
}

const targets = opts.api ? [[opts.api, "你指定的接口"]] : KNOWN;
console.log("接口存在性检查（不需要登录，网关会直接告诉你路由在不在）：");
for (const [api, note] of targets) {
  const body = await call(api);
  const ret = retOf(body);
  const exists = !ret.startsWith("FAIL_SYS_API_NOT_FOUNDED");
  console.log(`  ${exists ? "✓ 存在  " : "✗ 不存在"} ${api}  ${note ?? ""}`);
  console.log(`           ${ret}`);
  await new Promise((r) => setTimeout(r, 400));
}

console.log(`
下一步：
  1. 在浏览器里打开闲鱼的消息页和订单页，F12 → Network 筛 h5api
  2. 找到对应请求，把 api 名字记下来，填进 .env.local：
       XIANYU_API_CONVERSATIONS=mtop.xxx
       XIANYU_API_ORDERS=mtop.xxx
  3. 用 --call 看返回结构，对照 src/lib/adapters/live/mapping.ts 里的候选字段
`);
