import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * 登录态：cookie + 当初那个浏览器的请求头。
 *
 * 请求头和 cookie 必须成对使用。cookie 是在某个具体浏览器里登录出来的，
 * 拿着它却用另一套 User-Agent 去请求，这种不一致本身就是风控的典型触发条件。
 *
 * 可以用「Xianyu Login State Extractor」这个 Chrome 扩展一键导出，
 * 也可以自己从 DevTools 里抄。
 */
/**
 * 导出登录态那台机器的设备特征。
 *
 * 用浏览器打开商详时要照着它重建 context。cookie 是在用户真机上签发的，
 * 却拿到一个屏幕尺寸、时区、触摸点数都对不上的壳子里去用，
 * 这种不一致和换 User-Agent 一样是风控的典型触发条件。
 */
export interface LoginFingerprint {
  platform?: string;
  locale?: string;
  languages?: string[];
  timeZone?: string;
  screen?: { width: number; height: number };
  devicePixelRatio?: number;
  colorDepth?: number;
  maxTouchPoints?: number;
  hardwareConcurrency?: number;
  deviceMemory?: number;
}

export interface LoginState {
  cookie: string;
  /** 只保留我们会原样带上的那几个头，全部小写 */
  headers: Record<string, string>;
  /** 导出时间，用来提示登录态有多旧 */
  capturedAt?: string;
  /** 导出那台机器的设备特征，只有扩展导出的 JSON 才有 */
  fingerprint?: LoginFingerprint;
}

/**
 * 会跟着请求一起带上的头。cookie 单独处理，其余一律丢掉。
 *
 * 故意不收 `accept-encoding`：浏览器会报 `gzip, deflate, br, zstd`，
 * 但 Node 的 fetch 不一定解得开 zstd，照抄过来反而会把响应搞坏。
 * 压缩协商交给 Node 自己去做。
 */
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

const CREDENTIALS_FILE = path.join(process.cwd(), ".secrets", "xianyu-login-state.json");

function cookieFromUnknown(value: unknown): string {
  if (typeof value === "string") return value.trim();

  // [{ name, value }, …]，扩展和 DevTools 导出常见的形状
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "string") return entry.trim();
        if (entry && typeof entry === "object") {
          const record = entry as Record<string, unknown>;
          const name = record.name ?? record.key;
          const inner = record.value;
          if (typeof name === "string" && inner !== undefined) return `${name}=${inner}`;
        }
        return "";
      })
      .filter(Boolean)
      .join("; ");
  }

  // { name: value, … }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, inner]) => typeof inner === "string" || typeof inner === "number")
      .map(([name, inner]) => `${name}=${inner}`)
      .join("; ");
  }

  return "";
}

function headersFromUnknown(source: Record<string, unknown>): Record<string, string> {
  const raw: Record<string, unknown> = {};

  const nested = source.headers ?? source.requestHeaders ?? source.header;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    Object.assign(raw, nested as Record<string, unknown>);
  }
  if (Array.isArray(nested)) {
    for (const entry of nested) {
      if (entry && typeof entry === "object") {
        const record = entry as Record<string, unknown>;
        if (typeof record.name === "string") raw[record.name] = record.value;
      }
    }
  }

  // 有些导出把 UA 放在顶层
  for (const key of ["userAgent", "ua", "user_agent"]) {
    if (typeof source[key] === "string") raw["user-agent"] = source[key];
  }

  // 也可能埋在 env 里。扩展实际导出的是 env.navigator.userAgent，
  // 比我原先预想的深一层 —— 两层都找一遍。
  const env = source.env ?? source.environment ?? source.browser;
  if (env && typeof env === "object") {
    const record = env as Record<string, unknown>;
    const candidates: Array<Record<string, unknown>> = [record];
    for (const key of ["navigator", "nav"]) {
      const nested = record[key];
      if (nested && typeof nested === "object") {
        candidates.push(nested as Record<string, unknown>);
      }
    }
    for (const candidate of candidates) {
      for (const key of ["userAgent", "ua"]) {
        if (typeof candidate[key] === "string" && !raw["user-agent"]) {
          raw["user-agent"] = candidate[key];
        }
      }
    }
  }

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const name = key.toLowerCase();
    if (!HEADER_ALLOWLIST.includes(name)) continue;
    if (typeof value === "string" && value.trim()) headers[name] = value.trim();
  }
  return headers;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * 捞设备特征。
 *
 * 两种来源：扩展导出的原始 `env`，以及我们自己存盘后再读回来的 `fingerprint`。
 * 存盘走的是同一个解析函数，不认后者的话，落一次盘指纹就没了。
 *
 * 字段名各版本不一样（`intl.timeZone` / 顶层 `timezone`），逐个候选试；
 * 认不出来就留空 —— 宁可不还原，也不能编一个假的塞进去。
 */
export function fingerprintFromUnknown(
  source: Record<string, unknown>,
): LoginFingerprint | undefined {
  const env = asRecord(source.env ?? source.environment ?? source.browser);
  const navigator = asRecord(env.navigator ?? env.nav);
  const screen = asRecord(env.screen);
  const intl = asRecord(env.intl);
  const saved = asRecord(source.fingerprint);
  const savedScreen = asRecord(saved.screen);

  const rawLanguages = navigator.languages ?? saved.languages;
  const languages = Array.isArray(rawLanguages)
    ? rawLanguages.filter((item): item is string => typeof item === "string")
    : undefined;

  const width = positiveInt(screen.width ?? savedScreen.width);
  const height = positiveInt(screen.height ?? savedScreen.height);

  const fingerprint: LoginFingerprint = {
    platform: trimmedString(navigator.platform ?? env.platform ?? saved.platform),
    locale: trimmedString(intl.locale ?? navigator.language ?? env.locale ?? saved.locale),
    languages: languages && languages.length > 0 ? languages : undefined,
    timeZone: trimmedString(
      intl.timeZone ?? env.timeZone ?? env.timezone ?? saved.timeZone,
    ),
    screen: width !== undefined && height !== undefined ? { width, height } : undefined,
    devicePixelRatio: positiveNumber(
      screen.devicePixelRatio ?? env.devicePixelRatio ?? saved.devicePixelRatio,
    ),
    colorDepth: positiveInt(screen.colorDepth ?? saved.colorDepth),
    maxTouchPoints: nonNegativeInt(navigator.maxTouchPoints ?? saved.maxTouchPoints),
    hardwareConcurrency: positiveInt(
      navigator.hardwareConcurrency ?? saved.hardwareConcurrency,
    ),
    deviceMemory: positiveNumber(navigator.deviceMemory ?? saved.deviceMemory),
  };

  const filled = Object.values(fingerprint).some((value) => value !== undefined);
  return filled ? fingerprint : undefined;
}

/**
 * 尽量把各种导出格式解析成统一的登录态。
 *
 * 认得出：纯 cookie 串、扩展导出的 JSON、DevTools 复制出来的 cookie 数组。
 * 认不出来就返回 null，绝不返回一个半残的对象让它在真实请求里出问题。
 */
export function parseLoginState(input: string | Record<string, unknown>): LoginState | null {
  let source: Record<string, unknown>;

  if (typeof input === "string") {
    const text = input.trim();
    if (!text) return null;
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(text);
        source = Array.isArray(parsed)
          ? { cookies: parsed }
          : (parsed as Record<string, unknown>);
      } catch {
        return null;
      }
    } else {
      // 不是 JSON，当成裸 cookie 串
      return text.includes("=") ? { cookie: text, headers: {} } : null;
    }
  } else {
    source = input;
  }

  const cookie = cookieFromUnknown(
    source.cookie ?? source.cookies ?? source.cookieString ?? source.Cookie,
  );
  if (!cookie.includes("=")) return null;

  const capturedAt =
    typeof source.capturedAt === "string"
      ? source.capturedAt
      : typeof source.timestamp === "string"
        ? source.timestamp
        : typeof source.timestamp === "number"
          ? new Date(source.timestamp).toISOString()
          : undefined;

  return {
    cookie,
    headers: headersFromUnknown(source),
    capturedAt,
    fingerprint: fingerprintFromUnknown(source),
  };
}

/** 落盘，权限 600。目录 `.secrets/` 已经在 .gitignore 里。 */
export async function saveLoginState(state: LoginState): Promise<string> {
  await mkdir(path.dirname(CREDENTIALS_FILE), { recursive: true });
  await writeFile(CREDENTIALS_FILE, JSON.stringify(state, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(CREDENTIALS_FILE, 0o600);
  return CREDENTIALS_FILE;
}

export async function readLoginStateFile(): Promise<LoginState | null> {
  try {
    const raw = await readFile(CREDENTIALS_FILE, "utf8");
    return parseLoginState(raw);
  } catch {
    return null;
  }
}

export async function clearLoginState(): Promise<void> {
  await rm(CREDENTIALS_FILE, { force: true });
}

export function resolveLoginOrigin(input: {
  envCookie?: string;
  hasFile: boolean;
}): "env" | "file" | "none" {
  const env = input.envCookie?.trim();
  if (env && parseLoginState(env)) return "env";
  return input.hasFile ? "file" : "none";
}

export async function loginStateOrigin(): Promise<"env" | "file" | "none"> {
  return resolveLoginOrigin({
    envCookie: process.env.XIANYU_COOKIE,
    hasFile: Boolean(await readLoginStateFile()),
  });
}

export function loginStateFilePath(): string {
  return CREDENTIALS_FILE;
}

/**
 * 登录态的版本戳，用户重新导一次就会变。
 *
 * 撞风控时记下当时的戳，之后发现戳变了就说明用户换了新的登录态，
 * 可以提前解除暂停，不用干等满六小时。值本身不含任何凭证。
 */
export async function loginStateStamp(): Promise<string | undefined> {
  if (process.env.XIANYU_COOKIE?.trim()) return "env";
  try {
    const info = await stat(CREDENTIALS_FILE);
    return `file:${Math.round(info.mtimeMs)}`;
  } catch {
    return undefined;
  }
}

/**
 * 读登录态。环境变量优先（显式覆盖），否则读 `.secrets/` 里的文件。
 */
export async function loadLoginState(): Promise<LoginState | null> {
  const fromEnv = process.env.XIANYU_COOKIE?.trim();
  if (fromEnv) {
    const parsed = parseLoginState(fromEnv);
    if (parsed) {
      const ua = process.env.XIANYU_USER_AGENT?.trim();
      if (ua) parsed.headers["user-agent"] = ua;
      return parsed;
    }
  }
  return readLoginStateFile();
}

/** 脱敏描述，任何要打日志或者传到浏览器的地方都必须先过这一层。 */
export function describeLoginState(state: LoginState | null): string {
  if (!state) return "未配置";
  const names = state.cookie
    .split(";")
    .map((pair) => pair.split("=")[0]?.trim())
    .filter(Boolean);
  const headerNames = Object.keys(state.headers);
  return [
    `${names.length} 个 cookie 字段`,
    headerNames.length > 0 ? `${headerNames.length} 个请求头（${headerNames.join(", ")}）` : "没有请求头",
    state.fingerprint ? "带设备指纹" : "",
    state.capturedAt ? `导出于 ${state.capturedAt}` : "",
  ]
    .filter(Boolean)
    .join("，");
}
