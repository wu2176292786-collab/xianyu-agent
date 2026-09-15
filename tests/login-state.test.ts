import { describe, expect, it } from "vitest";
import { describeLoginState, parseLoginState } from "@/lib/adapters/live/login-state";

describe("登录态解析", () => {
  it("认得出裸 cookie 串", () => {
    const state = parseLoginState("unb=123; cookie2=abc; _m_h5_tk=tok_1");
    expect(state?.cookie).toBe("unb=123; cookie2=abc; _m_h5_tk=tok_1");
    expect(state?.headers).toEqual({});
  });

  it("认得出扩展导出的 JSON：cookie 串 + 请求头 + 环境", () => {
    const exported = JSON.stringify({
      cookie: "unb=123; cookie2=abc",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh) Chrome/131",
        "Accept-Language": "zh-CN,zh;q=0.9",
        Referer: "https://www.goofish.com/",
        "Sec-Ch-Ua-Platform": '"macOS"',
        // 不在白名单里的头要被丢掉
        "X-Whatever": "noise",
        Cookie: "别从这里拿 cookie",
      },
      env: { timezone: "Asia/Shanghai", screen: { width: 1920 } },
      timestamp: 1700000000000,
    });

    const state = parseLoginState(exported)!;
    expect(state.cookie).toBe("unb=123; cookie2=abc");
    expect(state.headers["user-agent"]).toBe("Mozilla/5.0 (Macintosh) Chrome/131");
    expect(state.headers["accept-language"]).toBe("zh-CN,zh;q=0.9");
    expect(state.headers["sec-ch-ua-platform"]).toBe('"macOS"');
    expect(state.headers["x-whatever"]).toBeUndefined();
    expect(state.headers.cookie).toBeUndefined();
    expect(state.capturedAt).toBe(new Date(1700000000000).toISOString());
  });

  it("认得出 cookie 数组（DevTools 和部分扩展是这种形状）", () => {
    const state = parseLoginState(
      JSON.stringify({
        cookies: [
          { name: "unb", value: "123" },
          { name: "cookie2", value: "abc" },
        ],
        userAgent: "顶层的 UA",
      }),
    )!;
    expect(state.cookie).toBe("unb=123; cookie2=abc");
    expect(state.headers["user-agent"]).toBe("顶层的 UA");
  });

  it("认得出顶层就是数组的导出", () => {
    const state = parseLoginState(
      JSON.stringify([
        { name: "unb", value: "123" },
        { key: "cookie2", value: "abc" },
      ]),
    )!;
    expect(state.cookie).toBe("unb=123; cookie2=abc");
  });

  it("认得出 cookie 是对象的形状", () => {
    const state = parseLoginState({ cookie: { unb: "123", cookie2: "abc" } })!;
    expect(state.cookie).toBe("unb=123; cookie2=abc");
  });

  it("请求头是数组形式也能认", () => {
    const state = parseLoginState({
      cookie: "unb=1",
      headers: [
        { name: "user-agent", value: "数组里的 UA" },
        { name: "accept", value: "application/json" },
      ],
    })!;
    expect(state.headers["user-agent"]).toBe("数组里的 UA");
    expect(state.headers.accept).toBe("application/json");
  });

  it("UA 藏在 env 里也能捞出来", () => {
    const state = parseLoginState({
      cookie: "unb=1",
      env: { userAgent: "环境里的 UA", timezone: "Asia/Shanghai" },
    })!;
    expect(state.headers["user-agent"]).toBe("环境里的 UA");
  });

  it("认不出来就返回 null，不返回半残的对象", () => {
    expect(parseLoginState("")).toBeNull();
    expect(parseLoginState("这不是 cookie 也不是 JSON")).toBeNull();
    expect(parseLoginState("{ 坏掉的 json")).toBeNull();
    expect(parseLoginState(JSON.stringify({ headers: { "User-Agent": "x" } }))).toBeNull();
    expect(parseLoginState(JSON.stringify({ cookie: "" }))).toBeNull();
  });

  it("描述里不能出现任何凭证值", () => {
    const state = parseLoginState({
      cookie: "unb=SECRET; cookie2=ALSOSECRET",
      headers: { "User-Agent": "Mozilla/5.0 机密" },
      capturedAt: "2026-01-10T00:00:00.000Z",
    });
    const described = describeLoginState(state);

    expect(described).not.toContain("SECRET");
    expect(described).not.toContain("Mozilla");
    expect(described).toContain("2 个 cookie 字段");
    expect(described).toContain("user-agent");
  });

  it("没导入时如实说未配置", () => {
    expect(describeLoginState(null)).toBe("未配置");
  });
});
