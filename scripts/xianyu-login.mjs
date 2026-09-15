#!/usr/bin/env node
/**
 * 导入闲鱼登录态。
 *
 *   npm run xianyu:login                    从剪贴板粘贴（读 stdin），Ctrl-D 结束
 *   npm run xianyu:login -- --file a.json   从文件导入
 *   npm run xianyu:login -- --verify        导入后真的调一次网关验证
 *   npm run xianyu:login -- --status        只看当前状态
 *   npm run xianyu:login -- --clear         删掉已保存的登录态
 *
 * 推荐配合 Chrome 扩展「Xianyu Login State Extractor」使用：
 * 登录 www.goofish.com 后点「提取」，它会把 cookie + 请求头 + 浏览器环境
 * 一起生成 JSON 放到剪贴板，直接粘进来即可。
 *
 * 导出的内容等同于你的账号，不要发给任何人，也不要贴进任何对话框。
 * 保存位置是 .secrets/xianyu-login-state.json，权限 600，已在 .gitignore 里。
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const FILE = path.join(process.cwd(), ".secrets", "xianyu-login-state.json");
const HOST = "https://h5api.m.goofish.com";
const APP_KEY = "12574478";
// 故意不收 accept-encoding：浏览器会报 zstd，Node 的 fetch 不一定解得开
const HEADER_ALLOWLIST = [
  "user-agent",
  "accept",
  "accept-language",
  "referer",
  "origin",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
];
const SESSION_KEYS = ["unb", "cookie2", "_tb_token_", "sgcookie"];

function args() {
  const out = {};
  for (let i = 2; i < process.argv.length; i += 1) {
    const key = process.argv[i];
    if (key.startsWith("--")) {
      const next = process.argv[i + 1];
      out[key.slice(2)] = next && !next.startsWith("--") ? next : true;
    }
  }
  return out;
}

function cookieFromUnknown(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "string") return entry.trim();
        const name = entry?.name ?? entry?.key;
        return typeof name === "string" && entry?.value !== undefined
          ? `${name}=${entry.value}`
          : "";
      })
      .filter(Boolean)
      .join("; ");
  }
  if (value && typeof value === "object") {
    return Object.entries(value)
      .filter(([, inner]) => typeof inner === "string" || typeof inner === "number")
      .map(([name, inner]) => `${name}=${inner}`)
      .join("; ");
  }
  return "";
}

function headersFromUnknown(source) {
  const raw = {};
  const nested = source.headers ?? source.requestHeaders ?? source.header;
  if (Array.isArray(nested)) {
    for (const entry of nested) if (entry?.name) raw[entry.name] = entry.value;
  } else if (nested && typeof nested === "object") {
    Object.assign(raw, nested);
  }
  for (const key of ["userAgent", "ua", "user_agent"]) {
    if (typeof source[key] === "string") raw["user-agent"] = source[key];
  }
  // 扩展实际导出的是 env.navigator.userAgent，比预想的深一层
  const env = source.env ?? source.environment ?? source.browser;
  if (env && typeof env === "object") {
    for (const candidate of [env, env.navigator, env.nav]) {
      if (candidate && typeof candidate === "object" && !raw["user-agent"]) {
        if (typeof candidate.userAgent === "string") raw["user-agent"] = candidate.userAgent;
      }
    }
  }

  const headers = {};
  for (const [key, value] of Object.entries(raw)) {
    const name = key.toLowerCase();
    if (HEADER_ALLOWLIST.includes(name) && typeof value === "string" && value.trim()) {
      headers[name] = value.trim();
    }
  }
  return headers;
}

function parseLoginState(input) {
  const text = String(input).trim();
  if (!text) return null;

  let source;
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      source = Array.isArray(parsed) ? { cookies: parsed } : parsed;
    } catch {
      return null;
    }
  } else {
    return text.includes("=") ? { cookie: text, headers: {} } : null;
  }

  const cookie = cookieFromUnknown(
    source.cookie ?? source.cookies ?? source.cookieString ?? source.Cookie,
  );
  if (!cookie.includes("=")) return null;

  const stamp = source.capturedAt ?? source.timestamp;
  return {
    cookie,
    headers: headersFromUnknown(source),
    capturedAt:
      typeof stamp === "number"
        ? new Date(stamp).toISOString()
        : typeof stamp === "string"
          ? stamp
          : new Date().toISOString(),
  };
}

/** _m_h5_tk 的格式是 token_过期毫秒时间戳，实测有效期约 90 分钟。 */
function describeToken(cookie) {
  const match = cookie.match(/_m_h5_tk=[^;_]+_(\d+)/);
  if (!match) return "没有（首次请求会自动换取）";
  const minutes = Math.round((Number(match[1]) - Date.now()) / 60000);
  return minutes > 0 ? `有，约 ${minutes} 分钟后过期` : "已过期（首次请求会自动换取）";
}

function describe(state) {
  if (!state) return "未配置";
  const names = state.cookie
    .split(";")
    .map((pair) => pair.split("=")[0]?.trim())
    .filter(Boolean);
  const session = SESSION_KEYS.filter((key) =>
    new RegExp(`(^|;\\s*)${key}=`).test(state.cookie),
  );
  const headerNames = Object.keys(state.headers);

  return [
    `  cookie 字段：${names.length} 个`,
    `  登录态字段：${session.length > 0 ? session.join("、") : "没有 —— 可能只导出了游客状态"}`,
    `  签名 token：${describeToken(state.cookie)}`,
    `  请求头：${headerNames.length > 0 ? headerNames.join(", ") : "没有 —— 建议用扩展一并导出"}`,
    `  User-Agent：${state.headers["user-agent"] ? "有" : "没有 —— 和 cookie 不一致容易触发风控"}`,
    `  导出时间：${state.capturedAt ?? "未知"}`,
  ].join("\n");
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function verify(state) {
  const token = state.cookie.match(/_m_h5_tk=([^;_]+)_/)?.[1] ?? "";
  const t = String(Date.now());
  const data = "{}";
  const query = new URLSearchParams({
    jsv: "2.7.2",
    appKey: APP_KEY,
    t,
    sign: createHash("md5").update(`${token}&${t}&${APP_KEY}&${data}`).digest("hex"),
    v: "1.0",
    type: "originaljson",
    dataType: "json",
    api: "mtop.idle.web.user.page.nav",
    data,
  });

  const response = await fetch(`${HOST}/h5/mtop.idle.web.user.page.nav/1.0/?${query}`, {
    headers: {
      accept: "application/json",
      referer: "https://www.goofish.com/",
      ...state.headers,
      cookie: state.cookie,
    },
    signal: AbortSignal.timeout(15_000),
  });

  const body = await response.json();
  const ret = body?.ret?.[0] ?? "(没有 ret)";
  console.log(`\n验证结果：${ret}`);

  if (ret.startsWith("SUCCESS")) {
    console.log("登录态有效。");
    return true;
  }
  if (ret.includes("SESSION_EXPIRED") || ret.includes("TOKEN")) {
    console.log("登录态无效或已过期 —— 回浏览器重新登录再导出一次。");
    return false;
  }
  console.log("网关返回了别的错误，原样贴在上面，可以拿去排查。");
  return false;
}

const opts = args();

if (opts.clear) {
  await rm(FILE, { force: true });
  console.log(`已删除 ${FILE}`);
  process.exit(0);
}

if (opts.status) {
  try {
    const state = parseLoginState(await readFile(FILE, "utf8"));
    console.log(`当前登录态（${FILE}）：\n${describe(state)}`);
    if (opts.verify && state) await verify(state);
  } catch {
    console.log("还没有导入登录态。");
  }
  process.exit(0);
}

const raw = opts.file ? await readFile(opts.file, "utf8") : await readStdin();
if (!raw.trim()) {
  console.error(`
没有读到内容。

用法：
  1. 浏览器登录 www.goofish.com
  2. 点扩展「Xianyu Login State Extractor」→ 勾选同意 → 提取（内容进剪贴板）
  3. 回到终端：

       npm run xianyu:login
       （粘贴，然后按 Ctrl-D）

     或者先存成文件：

       npm run xianyu:login -- --file ~/Downloads/xianyu.json
`);
  process.exit(1);
}

const state = parseLoginState(raw);
if (!state) {
  console.error("解析失败：既不是 cookie 串，也不是认得出来的 JSON。");
  console.error("把导出内容的字段名（不要带值）贴出来，可以据此补上解析规则。");
  process.exit(1);
}

await mkdir(path.dirname(FILE), { recursive: true });
await writeFile(FILE, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
await chmod(FILE, 0o600);

console.log(`已保存到 ${FILE}（权限 600，已在 .gitignore 里）\n`);
console.log(describe(state));

if (!/(^|;\s*)(unb|cookie2|_tb_token_)=/.test(state.cookie)) {
  console.log("\n⚠️  没找到登录态字段，多半是在未登录的页面上点了提取。");
}
if (!state.headers["user-agent"]) {
  console.log(
    "\n⚠️  没拿到 User-Agent。cookie 是在某个浏览器里登录出来的，\n" +
      "    用对不上的请求头去请求，本身就是风控的典型触发条件。",
  );
}

if (opts.verify) await verify(state);

console.log(`
下一步：
  npm run xianyu:probe                 验证接口名
  然后在「自动化 → 通道与安全」里把读通道切成真实、写模式保持演练
`);
