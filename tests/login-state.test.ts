import { describe, expect, it } from "vitest";
import { prepareLoginImport } from "@/lib/adapters/live/credentials";
import {
  describeLoginState,
  parseLoginState,
  resolveLoginOrigin,
} from "@/lib/adapters/live/login-state";

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

  // 下面这个形状对照的是扩展 v1.1 的真实导出结构（字段名真实，值全部是假的）
  it("认得出扩展 v1.1 的真实导出结构", () => {
    const exported = {
      capturedAt: "2026-09-15T03:50:50.040Z",
      pageUrl: "https://www.goofish.com/personal",
      page: { pageUrl: "https://www.goofish.com/personal", visibilityState: "visible" },
      env: {
        navigator: {
          // 真实导出里 UA 埋在 env.navigator 下面，比一层更深
          userAgent: "Mozilla/5.0 (Macintosh) Chrome/152.0.0.0",
          platform: "MacIntel",
          language: "zh-CN",
        },
        screen: { width: 1512, height: 982 },
        intl: { timeZone: "Asia/Shanghai", locale: "zh-CN" },
      },
      // storage 里也有令牌，但 MTOP 请求用不上，必须被忽略掉
      storage: { local: { tfstk__: "假的", syfhs: "假的" }, session: {} },
      headers: {
        "sec-ch-ua-platform": '"macOS"',
        "User-Agent": "Mozilla/5.0 (Macintosh) Chrome/152.0.0.0",
        "sec-ch-ua": '"Chromium";v="152"',
        "sec-ch-ua-mobile": "?0",
        Accept: "*/*",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        Referer: "https://www.goofish.com/personal",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
      cookies: [
        { name: "cookie2", value: "fake", domain: ".goofish.com", httpOnly: true },
        { name: "_tb_token_", value: "fake", domain: ".goofish.com" },
        { name: "unb", value: "000", domain: ".goofish.com" },
        { name: "sgcookie", value: "fake", domain: ".goofish.com", httpOnly: true },
        { name: "_m_h5_tk", value: "abc123_1789449730814", domain: ".goofish.com" },
        { name: "_m_h5_tk_enc", value: "fake", domain: ".goofish.com" },
      ],
    };

    const state = parseLoginState(exported)!;

    expect(state.cookie).toContain("cookie2=fake");
    expect(state.cookie).toContain("unb=000");
    expect(state.cookie).toContain("_m_h5_tk=abc123_1789449730814");
    // cookie 数组里的 domain / httpOnly 这些属性不能混进 cookie 串
    expect(state.cookie).not.toContain("goofish.com");
    expect(state.cookie).not.toContain("httpOnly");

    expect(state.headers["user-agent"]).toBe("Mozilla/5.0 (Macintosh) Chrome/152.0.0.0");
    expect(state.headers["sec-fetch-site"]).toBe("same-origin");
    expect(state.headers["sec-ch-ua"]).toBe('"Chromium";v="152"');
    // zstd Node 不一定解得开，照抄过来会把响应搞坏
    expect(state.headers["accept-encoding"]).toBeUndefined();
    expect(state.capturedAt).toBe("2026-09-15T03:50:50.040Z");
  });

  it("扩展导出的设备指纹要留下来，打开商详时照着它重建浏览器", () => {
    const state = parseLoginState({
      cookie: "unb=1",
      env: {
        navigator: {
          userAgent: "Mozilla/5.0 (Macintosh) Chrome/152.0.0.0",
          platform: "MacIntel",
          languages: ["zh-CN", "zh", "en"],
          hardwareConcurrency: 10,
          deviceMemory: 8,
          maxTouchPoints: 0,
        },
        screen: { width: 1512, height: 982, devicePixelRatio: 2, colorDepth: 30 },
        intl: { timeZone: "Asia/Shanghai", locale: "zh-CN" },
      },
    })!;

    expect(state.fingerprint).toEqual({
      platform: "MacIntel",
      locale: "zh-CN",
      languages: ["zh-CN", "zh", "en"],
      timeZone: "Asia/Shanghai",
      screen: { width: 1512, height: 982 },
      devicePixelRatio: 2,
      colorDepth: 30,
      maxTouchPoints: 0,
      hardwareConcurrency: 10,
      deviceMemory: 8,
    });
  });

  it("指纹缺字段就留空，不补一个假的", () => {
    // 老版本扩展只导了时区，屏幕还缺高度
    const state = parseLoginState({
      cookie: "unb=1",
      env: { timezone: "Asia/Shanghai", screen: { width: 1920 } },
    })!;

    expect(state.fingerprint?.timeZone).toBe("Asia/Shanghai");
    expect(state.fingerprint?.screen).toBeUndefined();
    expect(state.fingerprint?.devicePixelRatio).toBeUndefined();
  });

  it("裸 cookie 串没有指纹可还原", () => {
    expect(parseLoginState("unb=123; cookie2=abc")?.fingerprint).toBeUndefined();
  });

  it("存盘再读回来指纹不能丢（落盘走的是同一个解析函数）", () => {
    const imported = parseLoginState({
      cookie: "unb=1",
      env: {
        navigator: { platform: "MacIntel", maxTouchPoints: 0 },
        screen: { width: 1512, height: 982, devicePixelRatio: 2 },
        intl: { timeZone: "Asia/Shanghai", locale: "zh-CN" },
      },
    })!;

    const reread = parseLoginState(JSON.stringify(imported))!;
    expect(reread.fingerprint).toEqual(imported.fingerprint);
  });

  it("UA 埋在 env.navigator 里也能捞出来", () => {
    const state = parseLoginState({
      cookie: "unb=1",
      env: { navigator: { userAgent: "深一层的 UA" } },
    })!;
    expect(state.headers["user-agent"]).toBe("深一层的 UA");
  });

  it("storage 里的令牌不会被当成 cookie", () => {
    const state = parseLoginState({
      cookies: [{ name: "unb", value: "1" }],
      storage: { local: { tfstk__: "不该出现" } },
    })!;
    expect(state.cookie).toBe("unb=1");
    expect(state.cookie).not.toContain("tfstk__");
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

  it("环境变量优先于本机文件", () => {
    expect(resolveLoginOrigin({ envCookie: "unb=1; cookie2=a", hasFile: true })).toBe("env");
    expect(resolveLoginOrigin({ envCookie: "", hasFile: true })).toBe("file");
    expect(resolveLoginOrigin({ hasFile: false })).toBe("none");
  });

  it("页面导入认得出扩展 JSON，并补上导出时间", () => {
    const now = Date.parse("2026-09-15T12:00:00.000Z");
    const result = prepareLoginImport(
      JSON.stringify({
        cookies: [
          { name: "unb", value: "1" },
          { name: "cookie2", value: "a" },
        ],
        headers: { "User-Agent": "Mozilla/5.0 Test" },
      }),
      now,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.cookie).toContain("unb=1");
    expect(result.state.capturedAt).toBe("2026-09-15T12:00:00.000Z");
    expect(result.warnings).toEqual([]);
  });

  it("粘过来的不是登录态就失败，不落半残对象", () => {
    expect(prepareLoginImport("这不是 cookie").ok).toBe(false);
    const tourist = prepareLoginImport("foo=bar");
    expect(tourist.ok).toBe(true);
    if (tourist.ok) {
      expect(tourist.warnings.some((line) => line.includes("登录态字段"))).toBe(true);
    }
  });
});
