import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { inspectLoginState } from "@/lib/adapters/live/credentials";
import { describeLoginState, parseLoginState } from "@/lib/adapters/live/login-state";
import {
  GOOFISH_APP_KEY,
  backoffMs,
  buildRequest,
  classifyRet,
  decideRetry,
  extractToken,
  readEnvelope,
  signRequest,
} from "@/lib/adapters/live/mtop";
import { endpointConfig } from "@/lib/adapters/live/reader";
import { callMtop, mergeCookie } from "@/lib/adapters/live/mtop-client";

describe("接口配置", () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it("会话接口默认用从网页版里读出来的那个，版本是 3.0", () => {
    delete process.env.XIANYU_API_CONVERSATIONS;
    expect(endpointConfig().conversations).toEqual({
      api: "mtop.taobao.idlemessage.pc.session.sync",
      version: "3.0",
    });
  });

  it("历史消息接口默认接上，版本是 1.0", () => {
    delete process.env.XIANYU_API_MESSAGES;
    expect(endpointConfig().messages).toEqual({
      api: "mtop.taobao.idlemessage.pc.message.sync",
      version: "1.0",
    });
  });

  it("可以用 @ 覆盖版本号", () => {
    process.env.XIANYU_API_ORDERS = "mtop.some.order.list@2.0";
    expect(endpointConfig().orders).toEqual({ api: "mtop.some.order.list", version: "2.0" });
  });

  it("不写版本号就按 1.0", () => {
    process.env.XIANYU_API_ORDERS = "mtop.some.order.list";
    expect(endpointConfig().orders).toEqual({ api: "mtop.some.order.list", version: "1.0" });
  });

  it("卖出订单接口没配就是没配，不拿「买到的」凑数", () => {
    delete process.env.XIANYU_API_ORDERS;
    expect(endpointConfig().orders).toBeUndefined();
  });
});

describe("MTOP 签名", () => {
  it("是 md5(token&时间戳&appKey&data)", () => {
    const expected = createHash("md5")
      .update("tok123&1700000000000&34839810&{}")
      .digest("hex");
    expect(signRequest("tok123", "1700000000000", "34839810", "{}")).toBe(expected);
  });

  it("任一入参变了签名就变", () => {
    const base = signRequest("tok", "1", "app", "{}");
    expect(signRequest("tok2", "1", "app", "{}")).not.toBe(base);
    expect(signRequest("tok", "2", "app", "{}")).not.toBe(base);
    expect(signRequest("tok", "1", "app2", "{}")).not.toBe(base);
    expect(signRequest("tok", "1", "app", '{"a":1}')).not.toBe(base);
  });

  it("用的是闲鱼自己的 appKey，不是淘宝 h5 那个", () => {
    // 填错 appKey 签名就永远算不对，所有需要登录的调用都会失败
    expect(GOOFISH_APP_KEY).toBe("34839810");
  });

  it("请求地址带齐网关要的参数，data 放进表单体", () => {
    const request = buildRequest({
      api: "mtop.idle.web.xyh.item.list",
      version: "1.0",
      appKey: "34839810",
      token: "tok",
      timestamp: "1700000000000",
      data: '{"pageNumber":1}',
    });
    const url = new URL(request.url);

    expect(url.pathname).toBe("/h5/mtop.idle.web.xyh.item.list/1.0/");
    expect(url.searchParams.get("appKey")).toBe("34839810");
    expect(url.searchParams.get("t")).toBe("1700000000000");
    expect(url.searchParams.get("sign")).toHaveLength(32);
    expect(url.searchParams.get("accountSite")).toBe("xianyu");
    expect(url.searchParams.get("sessionOption")).toBe("AutoLoginOnly");
    // data 走表单体，不塞在查询串里 —— 请求体一长 URL 就顶不住
    expect(url.searchParams.get("data")).toBeNull();
    expect(request.body).toBe(`data=${encodeURIComponent('{"pageNumber":1}')}`);
  });

  it("版本号会体现在路径上", () => {
    const request = buildRequest({
      api: "mtop.taobao.idlemessage.pc.session.sync",
      version: "3.0",
      appKey: "34839810",
      token: "tok",
      timestamp: "1700000000000",
      data: "{}",
    });
    expect(new URL(request.url).pathname).toBe(
      "/h5/mtop.taobao.idlemessage.pc.session.sync/3.0/",
    );
    expect(new URL(request.url).searchParams.get("v")).toBe("3.0");
  });
});

describe("extractToken", () => {
  it("取 _m_h5_tk 下划线前面的部分", () => {
    expect(extractToken("a=1; _m_h5_tk=abc123_1700000000000; b=2")).toBe("abc123");
  });

  it("没有就返回 null", () => {
    expect(extractToken("a=1; b=2")).toBeNull();
    expect(extractToken("")).toBeNull();
  });
});

describe("错误码分类", () => {
  // 下面这几个是对着真实网关实测拿到的，不是编的
  it.each([
    ["SUCCESS::接口调用成功", "ok"],
    ["FAIL_SYS_TOKEN_EMPTY::令牌为空", "token_expired"],
    ["FAIL_SYS_TOKEN_EXOIRED::令牌过期", "token_expired"],
    ["FAIL_SYS_SESSION_EXPIRED::Session过期", "session_expired"],
    ["FAIL_SYS_API_NOT_FOUNDED::请求API不存在", "api_not_found"],
    ["FAIL_SYS_TRAFFIC_LIMIT::哎哟喂,被挤爆啦", "rate_limited"],
    ["RGV587_ERROR::SM", "risk_control"],
    ["FAIL_SYS_ILLEGAL_ACCESS::非法请求", "risk_control"],
    ["FAIL_BIZ_SOMETHING::业务错误", "other"],
  ])("%s → %s", (ret, expected) => {
    expect(classifyRet(ret)).toBe(expected);
  });

  it("读信封时把原始 ret 保留下来方便排查", () => {
    const outcome = readEnvelope({
      api: "x",
      ret: ["FAIL_SYS_TOKEN_EMPTY::令牌为空"],
      data: { a: 1 },
    });
    expect(outcome.kind).toBe("token_expired");
    expect(outcome.ret).toBe("FAIL_SYS_TOKEN_EMPTY::令牌为空");
    expect(outcome.message).toBe("令牌为空");
    expect(outcome.data).toEqual({ a: 1 });
  });
});

describe("重试决策", () => {
  it("风控绝不重试", () => {
    expect(decideRetry("risk_control", 0, 5)).toBe("give_up");
  });

  it("登录失效绝不重试 —— 重试也没用，只会更危险", () => {
    expect(decideRetry("session_expired", 0, 5)).toBe("give_up");
  });

  it("接口不存在不重试", () => {
    expect(decideRetry("api_not_found", 0, 5)).toBe("give_up");
  });

  it("token 过期先换 token", () => {
    expect(decideRetry("token_expired", 0, 3)).toBe("refresh_token");
  });

  it("限流退避重试，次数用完为止", () => {
    expect(decideRetry("rate_limited", 0, 3)).toBe("retry");
    expect(decideRetry("rate_limited", 2, 3)).toBe("give_up");
  });

  it("退避时间随次数指数增长，并且带抖动", () => {
    expect(backoffMs(0, 800, () => 0.5)).toBe(800);
    expect(backoffMs(1, 800, () => 0.5)).toBe(1600);
    expect(backoffMs(2, 800, () => 0.5)).toBe(3200);
    expect(backoffMs(0, 800, () => 0)).toBeLessThan(backoffMs(0, 800, () => 1));
  });
});

describe("cookie 合并", () => {
  it("同名字段被新值覆盖，其余保留", () => {
    const merged = mergeCookie(
      "unb=123; _m_h5_tk=old_111; other=x",
      "_m_h5_tk=new_222; Path=/; HttpOnly",
    );
    expect(merged).toContain("unb=123");
    expect(merged).toContain("_m_h5_tk=new_222");
    expect(merged).not.toContain("old_111");
    expect(merged).toContain("other=x");
  });

  it("新出现的字段会被追加", () => {
    expect(mergeCookie("a=1", "b=2; Path=/")).toBe("a=1; b=2");
  });
});

describe("凭证检查", () => {
  const of = (cookie: string, headers: Record<string, string> = {}) =>
    inspectLoginState({ cookie, headers });

  it("没导入就明确说没导入", () => {
    const status = inspectLoginState(null);
    expect(status.configured).toBe(false);
    expect(status.detail).toContain("还没有导入");
  });

  it("只有游客 cookie 时会指出来", () => {
    const status = of("_m_h5_tk=abc_123; cna=xyz");
    expect(status.configured).toBe(true);
    expect(status.hasToken).toBe(true);
    expect(status.hasSession).toBe(false);
    expect(status.detail).toContain("游客");
  });

  it("有登录态字段就算齐全", () => {
    const status = of("unb=999; cookie2=abc; _m_h5_tk=tok_1", {
      "user-agent": "Mozilla/5.0",
    });
    expect(status.hasSession).toBe(true);
    expect(status.hasToken).toBe(true);
    expect(status.hasUserAgent).toBe(true);
  });

  it("缺 User-Agent 会明确提醒 —— 请求头和 cookie 不一致容易触发风控", () => {
    const status = of("unb=999; cookie2=abc; _m_h5_tk=tok_1");
    expect(status.hasUserAgent).toBe(false);
    expect(status.detail).toContain("风控");
  });

  it("脱敏之后不能泄漏任何值", () => {
    const described = describeLoginState(
      parseLoginState("unb=SECRET123; cookie2=ALSOSECRET; _m_h5_tk=tok_1"),
    );
    expect(described).not.toContain("SECRET123");
    expect(described).not.toContain("ALSOSECRET");
    expect(described).toContain("3 个 cookie 字段");
  });
});

describe("callMtop", () => {
  const originalCookie = process.env.XIANYU_COOKIE;

  afterEach(() => {
    if (originalCookie === undefined) delete process.env.XIANYU_COOKIE;
    else process.env.XIANYU_COOKIE = originalCookie;
  });

  function fakeFetch(bodies: unknown[], headers: Array<Record<string, string>> = []) {
    let call = 0;
    const calls: string[] = [];
    const impl = (async (url: string) => {
      calls.push(url);
      const body = bodies[Math.min(call, bodies.length - 1)];
      const header = headers[Math.min(call, headers.length - 1)] ?? {};
      call += 1;
      return {
        headers: { get: (name: string) => header[name] ?? null },
        json: async () => body,
      };
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it("没导入登录态时直接抛出未配置错误", async () => {
    delete process.env.XIANYU_COOKIE;
    // 必须显式说「没有登录态」。不然它会退回去读 .secrets/，
    // 在导入过真凭证的机器上就变成拿真账号打真网关了。
    await expect(callMtop({ api: "mtop.x", loginState: null })).rejects.toThrow(
      "还没有导入登录态",
    );
  });

  it("按浏览器的样子发：POST + 表单体里的 data", async () => {
    let seenInit: { method?: string; body?: string; headers: Record<string, string> } = {
      headers: {},
    };
    const impl = (async (_url: string, init: typeof seenInit) => {
      seenInit = init;
      return {
        headers: { get: () => null },
        json: async () => ({ ret: ["SUCCESS::ok"], data: {} }),
      };
    }) as unknown as typeof fetch;

    await callMtop({
      api: "mtop.taobao.idlemessage.pc.session.sync",
      version: "3.0",
      payload: { sessionTypes: "1,19" },
      fetchImpl: impl,
      loginState: { cookie: "unb=1; _m_h5_tk=tok_1", headers: {} },
    });

    expect(seenInit.method).toBe("POST");
    expect(seenInit.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(seenInit.body).toBe(`data=${encodeURIComponent('{"sessionTypes":"1,19"}')}`);
  });

  it("请求会带上导出时抓到的请求头", async () => {
    let seenHeaders: Record<string, string> = {};
    const impl = (async (_url: string, init: { headers: Record<string, string> }) => {
      seenHeaders = init.headers;
      return {
        headers: { get: () => null },
        json: async () => ({ ret: ["SUCCESS::ok"], data: {} }),
      };
    }) as unknown as typeof fetch;

    await callMtop({
      api: "mtop.x",
      fetchImpl: impl,
      loginState: {
        cookie: "unb=1; _m_h5_tk=tok_1",
        headers: { "user-agent": "从扩展抓到的 UA", "sec-ch-ua-platform": '"macOS"' },
      },
    });

    expect(seenHeaders["user-agent"]).toBe("从扩展抓到的 UA");
    expect(seenHeaders["sec-ch-ua-platform"]).toBe('"macOS"');
    expect(seenHeaders.cookie).toBe("unb=1; _m_h5_tk=tok_1");
  });

  it("成功就一次返回，不会多打请求", async () => {
    process.env.XIANYU_COOKIE = "unb=1; _m_h5_tk=tok_1";
    const { impl, calls } = fakeFetch([{ ret: ["SUCCESS::ok"], data: { n: 1 } }]);

    const outcome = await callMtop({ api: "mtop.x", fetchImpl: impl });
    expect(outcome.kind).toBe("ok");
    expect(outcome.data).toEqual({ n: 1 });
    expect(calls).toHaveLength(1);
  });

  it("撞上风控立刻停手，一次都不重试", async () => {
    process.env.XIANYU_COOKIE = "unb=1; _m_h5_tk=tok_1";
    const { impl, calls } = fakeFetch([{ ret: ["RGV587_ERROR::SM"] }]);

    const outcome = await callMtop({ api: "mtop.x", fetchImpl: impl, maxAttempts: 5 });
    expect(outcome.kind).toBe("risk_control");
    expect(calls).toHaveLength(1);
  });

  it("token 过期时用网关换发的新 token 重试", async () => {
    process.env.XIANYU_COOKIE = "unb=1; _m_h5_tk=old_111";
    const { impl, calls } = fakeFetch(
      [{ ret: ["FAIL_SYS_TOKEN_EMPTY::令牌为空"] }, { ret: ["SUCCESS::ok"], data: { n: 2 } }],
      [{ "set-cookie": "_m_h5_tk=fresh_222; Path=/" }, {}],
    );

    const outcome = await callMtop({
      api: "mtop.x",
      fetchImpl: impl,
      sleep: async () => {},
    });

    expect(outcome.kind).toBe("ok");
    expect(calls).toHaveLength(2);
    // 第二次请求必须用新 token 重新签名
    const firstSign = new URL(calls[0]).searchParams.get("sign");
    const secondSign = new URL(calls[1]).searchParams.get("sign");
    expect(secondSign).not.toBe(firstSign);
  });

  it("限流会退避重试，到上限后放弃", async () => {
    process.env.XIANYU_COOKIE = "unb=1; _m_h5_tk=tok_1";
    const { impl, calls } = fakeFetch([{ ret: ["FAIL_SYS_TRAFFIC_LIMIT::挤爆啦"] }]);
    const waits: number[] = [];

    const outcome = await callMtop({
      api: "mtop.x",
      fetchImpl: impl,
      maxAttempts: 3,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    expect(outcome.kind).toBe("rate_limited");
    expect(calls).toHaveLength(3);
    expect(waits).toHaveLength(2);
    expect(waits[1]).toBeGreaterThan(waits[0]);
  });
});
