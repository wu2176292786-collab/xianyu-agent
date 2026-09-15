import { describe, expect, it } from "vitest";
import { acceptPolished } from "@/lib/agent/llm";

/** 一条典型的议价草稿：买家出价 ¥3,000.00，按底价算出的还价是 ¥3,850.00。 */
const DRAFT =
  "会走路的鱼你好，¥3,000.00 确实做不了。\n" +
  "「iPhone 14 Pro」最低 ¥3,850.00，诚心要的话我改价给你，24 小时内发出。\n—— 老陈";

const KEEP = { mustKeep: [3850] };

describe("acceptPolished", () => {
  it("剥掉推理模型的思考块", () => {
    const raw = "<think>用户想让我改写得口语一点</think>\n\n你好，最低 ¥3,850.00，要的话我改价。";
    expect(acceptPolished(DRAFT, raw, KEEP)).toBe("你好，最低 ¥3,850.00，要的话我改价。");
  });

  it("也认 <thinking> 这种写法", () => {
    const raw = "<thinking>思考中</thinking>最低 ¥3,850.00 哦，¥3,000.00 真做不了。";
    expect(acceptPolished(DRAFT, raw, KEEP)).toBe("最低 ¥3,850.00 哦，¥3,000.00 真做不了。");
  });

  it("思考块没闭合说明输出被截断，直接弃用", () => {
    expect(acceptPolished(DRAFT, "<think>我先想想这个价格能不能再压一点", KEEP)).toBeNull();
  });

  it("只看数值，换个写法也认", () => {
    const raw = "鱼总你好，3000 真到不了，最低 3850，诚心要我马上改价。";
    expect(acceptPolished(DRAFT, raw, KEEP)).toBe(raw);
    expect(acceptPolished(DRAFT, "最低 3,850 元，24 小时内发出。", KEEP)).not.toBeNull();
  });

  it("编一个草稿里没有的价格就弃用，写成裸数字也拦得住", () => {
    expect(acceptPolished(DRAFT, "你好，最低 ¥3,500.00，要的话我改价。", KEEP)).toBeNull();
    expect(acceptPolished(DRAFT, "你好，最低 3500，要的话我改价。", KEEP)).toBeNull();
  });

  it("擅自改动承诺时效也拦得住", () => {
    const raw = "鱼总你好，最低 3850，48 小时内发出。";
    expect(acceptPolished(DRAFT, raw, KEEP)).toBeNull();
  });

  it("把还价说没了也弃用", () => {
    const raw = "你好，这个价格真做不了，最低就这样了，诚心要我给你改价。";
    expect(acceptPolished(DRAFT, raw, KEEP)).toBeNull();
  });

  it("只删掉买家自己报的价是允许的", () => {
    const raw = "鱼总你好，这个价到不了，最低 ¥3,850.00，诚心要我马上改价。";
    expect(acceptPolished(DRAFT, raw, KEEP)).toBe(raw);
  });

  it("空输出弃用", () => {
    expect(acceptPolished(DRAFT, "   ", KEEP)).toBeNull();
    expect(acceptPolished(DRAFT, "<think>只有思考</think>", KEEP)).toBeNull();
  });

  it("不涉及金额的回复照常放行", () => {
    const plain = "在的，这款还有 2 件现货。";
    expect(acceptPolished(plain, "<think>x</think>在的，还有两件呢。")).toBe(
      "在的，还有两件呢。",
    );
    expect(acceptPolished(plain, "在的，还有 2 台现货。")).toBe("在的，还有 2 台现货。");
  });

  it("不涉及金额的回复里也不许凭空冒出价格", () => {
    const plain = "在的，这款还有 2 件现货。";
    expect(acceptPolished(plain, "在的，还有两件，99 元包邮。")).toBeNull();
  });
});
