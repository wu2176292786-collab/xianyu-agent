import { randomInt } from "node:crypto";
import { decode as decodeMsgpack } from "@msgpack/msgpack";
import WebSocket from "ws";
import type { LoginState } from "./login-state";
import { loadLoginState } from "./login-state";
import { LiveChannelError, callMtop, selfUserId } from "./mtop-client";
import { pickString } from "./paths";

/**
 * 闲鱼网页私信走的是钉钉 IMPaaS，不是 MTOP 写接口。
 *
 * 协议对着 [XianYuApis](https://github.com/cv-cat/XianYuApis) 的
 * `get_token` + `/r/MessageSend/sendByReceiverScope` 对齐：
 *
 *   1. mtop.taobao.idlemessage.pc.login.token 换 accessToken
 *   2. wss://wss-goofish.dingtalk.com/ 带 cookie 升级
 *   3. /reg → /r/SyncStatus/ackDiff → 等 /s/vulcan
 *   4. /r/MessageSend/sendByReceiverScope 发文本
 *
 * 签名仍走我们自己的 `buildRequest`，不抄他们的 sign JS。
 */
export const IM_APP_KEY = "444e9908a51d1cb236a27862abc769c9";
export const IM_TOKEN_API = "mtop.taobao.idlemessage.pc.login.token";
export const IM_WS_URL = "wss://wss-goofish.dingtalk.com/";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

export function generateImMid(): string {
  return `${randomInt(0, 1000)}${Date.now()} 0`;
}

export function generateImUuid(): string {
  return `-${Date.now()}1`;
}

/** 网页 IM 的 deviceId：UUID v4 形态再拼上 unb。 */
export function generateDeviceId(userId: string): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const chars: string[] = [];
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      chars[i] = "-";
      continue;
    }
    if (i === 14) {
      chars[i] = "4";
      continue;
    }
    const nibble = randomInt(0, 16);
    chars[i] = alphabet[i === 19 ? (nibble & 3) | 8 : nibble]!;
  }
  return `${chars.join("")}-${userId}`;
}

export function imTokenPayload(deviceId: string): { appKey: string; deviceId: string } {
  return { appKey: IM_APP_KEY, deviceId };
}

export function encodeTextContent(text: string): string {
  return Buffer.from(
    JSON.stringify({ contentType: 1, text: { text } }),
    "utf8",
  ).toString("base64");
}

export interface TextSendFrame {
  mid: string;
  body: Record<string, unknown>;
}

export function buildTextSendFrame(input: {
  cid: string;
  toid: string;
  selfId: string;
  text: string;
  mid?: string;
  uuid?: string;
}): TextSendFrame {
  const mid = input.mid ?? generateImMid();
  return {
    mid,
    body: {
      lwp: "/r/MessageSend/sendByReceiverScope",
      headers: { mid },
      body: [
        {
          uuid: input.uuid ?? generateImUuid(),
          cid: `${input.cid}@goofish`,
          conversationType: 1,
          content: {
            contentType: 101,
            custom: { type: 1, data: encodeTextContent(input.text) },
          },
          redPointPolicy: 0,
          extension: { extJson: "{}" },
          ctx: { appVersion: "1.0", platform: "web" },
          mtags: {},
          msgReadStatusSetting: 1,
        },
        {
          actualReceivers: [`${input.toid}@goofish`, `${input.selfId}@goofish`],
        },
      ],
    },
  };
}

const NEWEST_CURSOR = 9_007_199_254_740_991;

export function imConversationId(cid: string): string {
  return cid.includes("@") ? cid : `${cid}@goofish`;
}

export interface ImSessionHint {
  cid: string;
  sessionType?: number;
  itemId?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value instanceof Map) {
    const record: Record<string, unknown> = {};
    for (const [key, item] of value) {
      record[String(key)] = item;
    }
    return record;
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function field(record: Record<string, unknown>, key: string): unknown {
  if (key in record) return record[key];
  const numeric = Number(key);
  return Number.isInteger(numeric) ? record[numeric] : undefined;
}

/** 网页 IM 推送：明文 JSON、base64(JSON)，或 base64(MessagePack)。 */
export function decodeImPushData(raw: unknown): Record<string, unknown> | undefined {
  const direct = asRecord(raw);
  if (direct) return direct;
  if (typeof raw !== "string" || !raw.trim()) return undefined;

  try {
    const parsed = asRecord(JSON.parse(raw));
    if (parsed) return parsed;
  } catch {
    // 再试二进制
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(raw.replace(/[^A-Za-z0-9+/]/g, ""), "base64");
  } catch {
    return undefined;
  }
  if (bytes.length === 0) return undefined;

  try {
    const parsed = asRecord(JSON.parse(bytes.toString("utf8")));
    if (parsed) return parsed;
  } catch {
    // MessagePack
  }

  try {
    return asRecord(decodeMsgpack(bytes));
  } catch {
    return undefined;
  }
}

export function extractImPushPayloads(frame: unknown): Record<string, unknown>[] {
  const body = asRecord(asRecord(frame)?.body);
  const data = body?.syncPushPackage
    ? asRecord(body.syncPushPackage)?.data
    : undefined;
  if (!Array.isArray(data)) {
    const decoded = decodeImPushData(frame);
    return decoded ? [decoded] : [];
  }

  const out: Record<string, unknown>[] = [];
  for (const item of data) {
    const decoded = decodeImPushData(asRecord(item)?.data ?? item);
    if (decoded) out.push(decoded);
  }
  return out;
}

function cidFrom(value: unknown): string | undefined {
  if (typeof value === "number") return String(value);
  if (typeof value !== "string" || !value) return undefined;
  const cid = value.split("@")[0];
  if (!cid || cid.includes("PNM") || !/^\d+$/.test(cid)) return undefined;
  return cid;
}

export function extractImSessionHint(decoded: Record<string, unknown>): ImSessionHint | undefined {
  const operation = asRecord(decoded.operation);
  const sessionInfo = asRecord(operation?.sessionInfo);
  const namedCid = cidFrom(decoded.sessionId ?? sessionInfo?.sessionId);
  if (namedCid) {
    const extensions = asRecord(sessionInfo?.extensions);
    const sessionType = sessionInfo?.sessionType ?? decoded.chatType;
    const itemId = extensions?.itemId;
    return {
      cid: namedCid,
      sessionType: typeof sessionType === "number" ? sessionType : undefined,
      itemId: itemId === undefined || itemId === null ? undefined : String(itemId),
    };
  }

  const one = field(decoded, "1");
  if (typeof one === "string") {
    const cid = cidFrom(one);
    return cid ? { cid } : undefined;
  }

  const nested = asRecord(one);
  const nestedCid = cidFrom(nested ? field(nested, "2") : undefined);
  if (nestedCid) {
    const ten = asRecord(nested ? field(nested, "10") : undefined);
    const itemId = ten?.itemId ?? nested?.itemId;
    return {
      cid: nestedCid,
      itemId: itemId === undefined || itemId === null ? undefined : String(itemId),
    };
  }

  const three = field(decoded, "3");
  if (typeof three === "string" && three.endsWith("@goofish")) {
    const cid = cidFrom(three);
    return cid ? { cid } : undefined;
  }
  return undefined;
}

export function isBuyerImSession(hint: ImSessionHint): boolean {
  return hint.sessionType === undefined || hint.sessionType === 1;
}

export function buildListUserMessagesFrame(input: {
  cid: string;
  cursor?: number;
  limit?: number;
  mid?: string;
}): { mid: string; body: Record<string, unknown> } {
  const mid = input.mid ?? generateImMid();
  return {
    mid,
    body: {
      lwp: "/r/MessageManager/listUserMessages",
      headers: { mid },
      body: [
        imConversationId(input.cid),
        false,
        input.cursor ?? NEWEST_CURSOR,
        input.limit ?? 40,
        false,
      ],
    },
  };
}

export function readAccessToken(data: unknown): string | undefined {
  return (
    pickString(data, ["accessToken", "data.accessToken", "result.accessToken"]) ??
    undefined
  );
}

export interface SendImTextInput {
  cid: string;
  toid: string;
  text: string;
  loginState?: LoginState | null;
  now?: number;
  timeoutMs?: number;
}

export interface SendImTextResult {
  ok: boolean;
  message: string;
  riskControl?: boolean;
}

function ackFrame(incoming: Record<string, unknown>, mid: string): Record<string, unknown> {
  const headers = (incoming.headers ?? {}) as Record<string, unknown>;
  const ackHeaders: Record<string, unknown> = {
    mid: typeof headers.mid === "string" ? headers.mid : mid,
    sid: typeof headers.sid === "string" ? headers.sid : "",
  };
  if (typeof headers["app-key"] === "string") ackHeaders["app-key"] = headers["app-key"];
  if (typeof headers.ua === "string") ackHeaders.ua = headers.ua;
  if (typeof headers.dt === "string") ackHeaders.dt = headers.dt;
  return { code: 200, headers: ackHeaders };
}

function looksFailed(incoming: Record<string, unknown>): string | undefined {
  const code = incoming.code;
  if (typeof code === "number" && code !== 200 && code !== 0) {
    return `闲鱼 IM 返回 ${code}`;
  }
  const body = incoming.body;
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const reason =
      (typeof record.reason === "string" && record.reason) ||
      (typeof record.message === "string" && record.message) ||
      (typeof record.error === "string" && record.error);
    if (reason) return reason;
  }
  return undefined;
}

/**
 * 拿 IM accessToken，再连 WebSocket 发一条文本。
 *
 * 一次发送一条、用完就关。不常驻、不自动回、不心跳循环。
 */
export async function sendImText(input: SendImTextInput): Promise<SendImTextResult> {
  const text = input.text.trim();
  if (!text) return { ok: false, message: "发送失败：回复内容为空" };

  const loginState = input.loginState !== undefined ? input.loginState : await loadLoginState();
  if (!loginState?.cookie) {
    return { ok: false, message: "还没有导入登录态。到「自动化 → 账号登录」粘贴扩展导出的内容。" };
  }

  const selfId = selfUserId(loginState.cookie);
  if (!selfId) {
    return { ok: false, message: "cookie 里没有 unb（用户 id），发不了私信。重新导出一次登录态。" };
  }

  const deviceId = generateDeviceId(selfId);
  let tokenOutcome;
  try {
    tokenOutcome = await callMtop({
      api: IM_TOKEN_API,
      version: "1.0",
      payload: imTokenPayload(deviceId),
      loginState,
    });
  } catch (error) {
    if (error instanceof LiveChannelError) {
      return {
        ok: false,
        message: error.message,
        riskControl: error.kind === "risk_control",
      };
    }
    throw error;
  }

  if (tokenOutcome.kind === "risk_control") {
    return { ok: false, message: tokenOutcome.message, riskControl: true };
  }
  if (tokenOutcome.kind !== "ok") {
    return { ok: false, message: `换取私信令牌失败：${tokenOutcome.message}` };
  }

  const accessToken = readAccessToken(tokenOutcome.data);
  if (!accessToken) {
    return { ok: false, message: "私信令牌接口没有返回 accessToken。" };
  }

  const timeoutMs = input.timeoutMs ?? 15_000;
  const now = input.now ?? Date.now();
  const userAgent = loginState.headers["user-agent"] ?? DEFAULT_UA;
  const frame = buildTextSendFrame({
    cid: input.cid,
    toid: input.toid,
    selfId,
    text,
  });

  return new Promise<SendImTextResult>((resolve) => {
    let settled = false;
    let ready = false;
    const finish = (result: SendImTextResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // 已经关了就不管
      }
      resolve(result);
    };

    const socket = new WebSocket(IM_WS_URL, {
      headers: {
        Cookie: loginState.cookie,
        Host: "wss-goofish.dingtalk.com",
        Origin: "https://www.goofish.com",
        "User-Agent": userAgent,
        "Accept-Language": loginState.headers["accept-language"] ?? "zh-CN,zh;q=0.9",
      },
    });

    const timer = setTimeout(() => {
      finish({ ok: false, message: "闲鱼 IM 发送超时，请稍后再试。" });
    }, timeoutMs);

    const sendJson = (payload: Record<string, unknown>) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
    };

    const sendMessage = () => {
      if (ready || settled) return;
      ready = true;
      sendJson(frame.body);
    };

    socket.on("open", () => {
      sendJson({
        lwp: "/reg",
        headers: {
          "cache-header": "app-key token ua wv",
          "app-key": IM_APP_KEY,
          token: accessToken,
          ua: `${userAgent} DingTalk(2.1.5) OS(Windows/10) Browser(Chrome/133.0.0.0) DingWeb/2.1.5 IMPaaS DingWeb/2.1.5`,
          dt: "j",
          wv: "im:3,au:3,sy:6",
          sync: "0,0;0;0;",
          did: deviceId,
          mid: generateImMid(),
        },
      });
      sendJson({
        lwp: "/r/SyncStatus/ackDiff",
        headers: { mid: generateImMid() },
        body: [
          {
            pipeline: "sync",
            tooLong2Tag: "PNM,1",
            channel: "sync",
            topic: "sync",
            highPts: 0,
            pts: now * 1000,
            seq: 0,
            timestamp: now,
          },
        ],
      });
    });

    socket.on("message", (raw) => {
      let incoming: Record<string, unknown>;
      try {
        incoming = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        return;
      }

      sendJson(ackFrame(incoming, generateImMid()));

      if (incoming.lwp === "/s/vulcan") {
        sendMessage();
        return;
      }

      const headers = (incoming.headers ?? {}) as Record<string, unknown>;
      if (headers.mid === frame.mid) {
        const failed = looksFailed(incoming);
        finish(
          failed
            ? { ok: false, message: `发送失败：${failed}` }
            : { ok: true, message: "已发到闲鱼。" },
        );
      }
    });

    socket.on("error", () => {
      finish({ ok: false, message: "闲鱼 IM 连接失败。" });
    });

    socket.on("close", () => {
      finish({ ok: false, message: "闲鱼 IM 连接在发送完成前被关闭。" });
    });

    // /s/vulcan 偶尔不来。注册后稍等再发，避免一直卡着。
    setTimeout(sendMessage, 1_200);
  });
}

export interface ListImHistoriesResult {
  ok: boolean;
  message: string;
  payloads: Map<string, unknown>;
  errors: string[];
  sessions: ImSessionHint[];
  riskControl?: boolean;
}

/**
 * 一次连上 IM，按会话拉最近一页历史。
 *
 * HTTP 的 `message.sync` 现在会回 FAIL_BIZ_120。网页端改走
 * `/r/MessageManager/listUserMessages`，body 是
 * `[cid@goofish, false, cursor, limit, false]`。
 */
export async function listImHistories(
  cids: string[],
  input: {
    loginState?: LoginState | null;
    limit?: number;
    timeoutMs?: number;
    now?: number;
    /** 先收会话激活推送再拉历史。HTTP 会话列表经常只有系统通知。 */
    collectMs?: number;
    maxConversations?: number;
  } = {},
): Promise<ListImHistoriesResult> {
  const unique = [...new Set(cids.filter(Boolean))];
  const collectMs = input.collectMs ?? 0;
  if (unique.length === 0 && collectMs <= 0) {
    return { ok: true, message: "没有要拉的会话。", payloads: new Map(), errors: [], sessions: [] };
  }

  const loginState = input.loginState !== undefined ? input.loginState : await loadLoginState();
  if (!loginState?.cookie) {
    return {
      ok: false,
      message: "还没有导入登录态。到「自动化 → 账号登录」粘贴扩展导出的内容。",
      payloads: new Map(),
      errors: [],
      sessions: [],
    };
  }

  const selfId = selfUserId(loginState.cookie);
  if (!selfId) {
    return {
      ok: false,
      message: "cookie 里没有 unb（用户 id），拉不了私信。",
      payloads: new Map(),
      errors: [],
      sessions: [],
    };
  }

  const deviceId = generateDeviceId(selfId);
  let tokenOutcome;
  try {
    tokenOutcome = await callMtop({
      api: IM_TOKEN_API,
      version: "1.0",
      payload: imTokenPayload(deviceId),
      loginState,
    });
  } catch (error) {
    if (error instanceof LiveChannelError) {
      return {
        ok: false,
        message: error.message,
        payloads: new Map(),
        errors: [],
        sessions: [],
        riskControl: error.kind === "risk_control",
      };
    }
    throw error;
  }

  if (tokenOutcome.kind === "risk_control") {
    return {
      ok: false,
      message: tokenOutcome.message,
      payloads: new Map(),
      errors: [],
      sessions: [],
      riskControl: true,
    };
  }
  if (tokenOutcome.kind !== "ok") {
    return {
      ok: false,
      message: `换取私信令牌失败：${tokenOutcome.message}`,
      payloads: new Map(),
      errors: [],
      sessions: [],
    };
  }

  const accessToken = readAccessToken(tokenOutcome.data);
  if (!accessToken) {
    return {
      ok: false,
      message: "私信令牌接口没有返回 accessToken。",
      payloads: new Map(),
      errors: [],
      sessions: [],
    };
  }

  const timeoutMs = input.timeoutMs ?? Math.max(20_000, collectMs + Math.max(unique.length, 8) * 2_500);
  const now = input.now ?? Date.now();
  const userAgent = loginState.headers["user-agent"] ?? DEFAULT_UA;
  const limit = input.limit ?? 40;
  const maxConversations = input.maxConversations ?? 15;

  return new Promise<ListImHistoriesResult>((resolve) => {
    let settled = false;
    let ready = false;
    let listingStarted = false;
    let index = 0;
    let frames: Array<{ cid: string; mid: string; body: Record<string, unknown> }> = [];
    const payloads = new Map<string, unknown>();
    const errors: string[] = [];
    const sessionHints = new Map<string, ImSessionHint>();
    let collectTimer: ReturnType<typeof setTimeout> | undefined;

    const snapshotSessions = () => [...sessionHints.values()];

    const finish = (result: Omit<ListImHistoriesResult, "sessions"> & { sessions?: ImSessionHint[] }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(collectTimer);
      try {
        socket.close();
      } catch {
        // 已经关了就不管
      }
      resolve({ ...result, sessions: result.sessions ?? snapshotSessions() });
    };

    const socket = new WebSocket(IM_WS_URL, {
      headers: {
        Cookie: loginState.cookie,
        Host: "wss-goofish.dingtalk.com",
        Origin: "https://www.goofish.com",
        "User-Agent": userAgent,
        "Accept-Language": loginState.headers["accept-language"] ?? "zh-CN,zh;q=0.9",
      },
    });

    const timer = setTimeout(() => {
      finish({
        ok: payloads.size > 0,
        message: payloads.size > 0 ? "部分会话的历史超时，先用已经拉到的。" : "闲鱼 IM 拉历史超时。",
        payloads,
        errors,
      });
    }, timeoutMs);

    const sendJson = (payload: Record<string, unknown>) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
    };

    const rememberSession = (hint: ImSessionHint | undefined) => {
      if (!hint?.cid) return;
      const previous = sessionHints.get(hint.cid);
      sessionHints.set(hint.cid, { ...previous, ...hint });
    };

    const collectFromFrame = (incoming: Record<string, unknown>) => {
      for (const decoded of extractImPushPayloads(incoming)) {
        rememberSession(extractImSessionHint(decoded));
      }
    };

    const sendNext = () => {
      const current = frames[index];
      if (!current) {
        finish({
          ok: true,
          message: `已从闲鱼 IM 拉回 ${payloads.size} 个会话的历史。`,
          payloads,
          errors,
        });
        return;
      }
      sendJson(current.body);
    };

    const startListing = () => {
      if (listingStarted || settled) return;
      listingStarted = true;
      const collected = [...sessionHints.values()]
        .filter(isBuyerImSession)
        .map((hint) => hint.cid);
      const cids = [...new Set([...unique, ...collected])].slice(0, maxConversations);
      frames = cids.map((cid) => ({ cid, ...buildListUserMessagesFrame({ cid, limit }) }));
      index = 0;
      sendNext();
    };

    const markReady = () => {
      if (ready || settled) return;
      ready = true;
      if (collectMs <= 0) {
        startListing();
        return;
      }
      collectTimer = setTimeout(startListing, collectMs);
    };

    socket.on("open", () => {
      sendJson({
        lwp: "/reg",
        headers: {
          "cache-header": "app-key token ua wv",
          "app-key": IM_APP_KEY,
          token: accessToken,
          ua: `${userAgent} DingTalk(2.1.5) OS(Windows/10) Browser(Chrome/133.0.0.0) DingWeb/2.1.5 IMPaaS DingWeb/2.1.5`,
          dt: "j",
          wv: "im:3,au:3,sy:6",
          sync: "0,0;0;0;",
          did: deviceId,
          mid: generateImMid(),
        },
      });
      sendJson({
        lwp: "/r/SyncStatus/ackDiff",
        headers: { mid: generateImMid() },
        body: [
          {
            pipeline: "sync",
            tooLong2Tag: "PNM,1",
            channel: "sync",
            topic: "sync",
            highPts: 0,
            pts: 0,
            seq: 0,
            timestamp: now,
          },
        ],
      });
    });

    socket.on("message", (raw) => {
      let incoming: Record<string, unknown>;
      try {
        incoming = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        return;
      }

      sendJson(ackFrame(incoming, generateImMid()));
      collectFromFrame(incoming);

      if (incoming.lwp === "/s/vulcan") {
        markReady();
        return;
      }

      if (!listingStarted) return;

      const current = frames[index];
      const headers = (incoming.headers ?? {}) as Record<string, unknown>;
      if (!current || String(headers.mid) !== String(current.mid)) return;

      const body = incoming.body;
      const hasModels =
        Boolean(body && typeof body === "object" && !Array.isArray(body) && "userMessageModels" in body) ||
        (Array.isArray(body) && body.length > 0);
      const failed = looksFailed(incoming);
      if (hasModels) {
        payloads.set(current.cid, body ?? incoming);
      } else if (!failed) {
        payloads.set(current.cid, body ?? incoming);
      } else {
        const record = body && typeof body === "object" && !Array.isArray(body)
          ? (body as Record<string, unknown>)
          : undefined;
        const reason = [record?.reason, record?.developerMessage, record?.code, record?.moreInfo]
          .filter((value) => typeof value === "string" || typeof value === "number")
          .map((value) => String(value).slice(0, 80))
          .join(" / ");
        errors.push(reason || failed);
      }
      index += 1;
      sendNext();
    });

    socket.on("error", () => {
      finish({
        ok: payloads.size > 0,
        message: payloads.size > 0 ? "IM 连接中断，先用已经拉到的历史。" : "闲鱼 IM 连接失败。",
        payloads,
        errors,
      });
    });

    socket.on("close", () => {
      finish({
        ok: payloads.size > 0,
        message: payloads.size > 0 ? "IM 连接已关闭，先用已经拉到的历史。" : "闲鱼 IM 连接在拉历史前被关闭。",
        payloads,
        errors,
      });
    });

    // 历史请求必须等 /s/vulcan。提前发会被服务端以 400 拒掉。
  });
}
