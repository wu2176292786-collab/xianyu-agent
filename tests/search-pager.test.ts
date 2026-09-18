import { describe, expect, it } from "vitest";
import {
  clampSearchPages,
  cookiesFromHeader,
  isNextPageLabel,
  pickNextPageControl,
} from "@/lib/research/search-pager";

describe("搜索页数", () => {
  it("缺省按 3 页，超出范围就夹住", () => {
    expect(clampSearchPages(undefined)).toBe(3);
    expect(clampSearchPages(1)).toBe(1);
    expect(clampSearchPages(20)).toBe(20);
    expect(clampSearchPages(0)).toBe(1);
    expect(clampSearchPages(99)).toBe(20);
    expect(clampSearchPages("8")).toBe(8);
  });
});

describe("下一页按钮", () => {
  it("认常见的下一页文案", () => {
    expect(isNextPageLabel("下一页")).toBe(true);
    expect(isNextPageLabel("下一页 >")).toBe(true);
    expect(isNextPageLabel("上一页")).toBe(false);
  });

  it("优先 aria-label，多个匹配取最后一个", () => {
    const picked = pickNextPageControl([
      { item: "mid", text: "下一页" },
      { item: "footer", text: "下一页" },
      { item: "disabled", text: "下一页", disabled: true },
    ]);
    expect(picked).toBe("footer");

    expect(
      pickNextPageControl([
        { item: "aria", text: ">", ariaLabel: "下一页" },
        { item: "text", text: "下一页" },
      ]),
    ).toBe("aria");
  });
});

describe("登录态 cookie 拆给浏览器", () => {
  it("只按名字拆，不丢掉等号后面的值", () => {
    const cookies = cookiesFromHeader("unb=1; _m_h5_tk=abc=def");
    expect(cookies.map((cookie) => cookie.name)).toEqual(["unb", "_m_h5_tk"]);
    expect(cookies[1]?.value).toBe("abc=def");
    expect(cookies.every((cookie) => cookie.domain === ".goofish.com")).toBe(true);
  });
});
