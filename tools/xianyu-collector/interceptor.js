/**
 * 页面世界（MAIN world）里的旁听器。
 *
 * 它做的事只有一件：**记下页面自己已经发出并拿回来的响应**。
 * 不发请求、不改请求、不加请求头 —— 页面该怎么跑还是怎么跑，
 * 我们只是在响应回来的时候顺手留一份。
 *
 * 为什么必须在页面世界里跑：内容脚本活在隔离世界，看不到页面的
 * `window.fetch`，也读不到页面内嵌的初始 JSON。
 */
(() => {
  const CHANNEL = "xianyu-collector";
  if (window.__xianyuCollectorInstalled) return;
  window.__xianyuCollectorInstalled = true;

  /** 只旁听闲鱼的接口网关，别的请求一概不碰。 */
  const GATEWAY = /h5api\.m\.goofish\.com/;
  const MAX_KEEP = 40;
  const MAX_BODY = 2_000_000;

  /** @type {Array<{api: string, url: string, at: number, payload: unknown}>} */
  const captures = [];

  function remember(url, body) {
    if (!GATEWAY.test(String(url))) return;
    if (typeof body !== "string" || body.length === 0 || body.length > MAX_BODY) return;

    try {
      // MTOP 有时回 `mtopjsonp123({...})`，有时回纯 JSON
      const start = body.indexOf("{");
      if (start < 0) return;
      const end = body.lastIndexOf("}");
      const payload = JSON.parse(body.slice(start, end + 1));
      captures.push({
        api: String(payload?.api ?? ""),
        url: String(url),
        at: Date.now(),
        payload,
      });
      if (captures.length > MAX_KEEP) captures.shift();
    } catch {
      // 不是 JSON 就算了，这里不该因为一个奇怪的响应把页面搞坏
    }
  }

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    window.fetch = function (...args) {
      const result = nativeFetch.apply(this, args);
      try {
        const input = args[0];
        const url =
          typeof input === "string" ? input : (input && input.url) || "";
        if (GATEWAY.test(String(url))) {
          result
            .then((response) => {
              // 必须 clone，否则页面自己就读不到响应体了
              response
                .clone()
                .text()
                .then((text) => remember(url, text))
                .catch(() => {});
            })
            .catch(() => {});
        }
      } catch {
        // 旁听失败不能影响页面的请求
      }
      return result;
    };
  }

  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      if (GATEWAY.test(String(url))) {
        this.addEventListener("load", () => {
          try {
            if (this.responseType === "" || this.responseType === "text") {
              remember(url, this.responseText);
            }
          } catch {
            // 同上
          }
        });
      }
    } catch {
      // 同上
    }
    return nativeOpen.call(this, method, url, ...rest);
  };

  /** 页面内嵌的初始 JSON。找不到就找不到，不编。 */
  function hydration() {
    const names = [
      "__INITIAL_DATA__",
      "__INITIAL_STATE__",
      "__NEXT_DATA__",
      "__NUXT__",
      "INIT_DATA",
      "_TS_DATA_",
    ];
    for (const name of names) {
      const value = window[name];
      if (!value || typeof value !== "object") continue;
      try {
        if (JSON.stringify(value).includes("wantCnt")) return value;
      } catch {
        // 循环引用之类的，跳过
      }
    }

    const scripts = document.querySelectorAll(
      'script[type="application/json"], script:not([src])',
    );
    for (const script of scripts) {
      const raw = script.textContent || "";
      if (raw.length < 40 || raw.length > 800_000) continue;
      if (!raw.includes("wantCnt")) continue;
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start < 0 || end <= start) continue;
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        // 不是完整 JSON，继续找下一个
      }
    }

    return undefined;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.kind !== "request") return;

    window.postMessage(
      {
        channel: CHANNEL,
        kind: "response",
        requestId: data.requestId,
        captures: captures.slice(-12),
        hydration: hydration(),
      },
      window.location.origin,
    );
  });
})();
