import { afterEach, describe, expect, it } from "vitest";
import {
  awaitingSellerReply,
  classifyIntent,
  draftReply,
  extractOfferCents,
  lowestQuoteCents,
} from "@/lib/agent/reply";
import { createSeedState } from "@/lib/domain/seed";
import { clockTime, relativeTime } from "@/lib/format";
import type { Conversation, Listing, ShopSettings } from "@/lib/domain/types";

const NOW = Date.parse("2026-01-10T12:00:00.000Z");

const listing: Listing = {
  id: "L001",
  title: "iPhone 14 Pro 256G",
  category: "手机数码",
  emoji: "📱",
  priceCents: 419000,
  floorPriceCents: 385000,
  costCents: 352000,
  stock: 1,
  status: "on_sale",
  createdAt: new Date(NOW - 3 * 86400000).toISOString(),
  lastRefreshedAt: new Date(NOW - 2 * 3600000).toISOString(),
  views7d: 1268,
  wants: 43,
  inquiries7d: 17,
  tags: ["验机报告", "可小刀"],
};

const settings: ShopSettings = {
  shopName: "测试小铺",
  maxDiscount: 0.12,
  shipWithinHours: 24,
  signature: "—— 老陈",
  autoTickEnabled: false,
  autoTickMinutes: 15,
};

function conversation(text: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "C001",
    buyerName: "小鱼",
    buyerEmoji: "🐟",
    listingId: listing.id,
    status: "needs_reply",
    intent: "other",
    messages: [
      { id: "m1", author: "buyer", text, createdAt: new Date(NOW).toISOString() },
    ],
    ...overrides,
  };
}

describe("时间格式化", () => {
  // 服务端在 UTC、浏览器在别的时区时，同一个时间戳必须渲染成同一个字符串，
  // 否则 hydration 会直接报错（/inbox 和 /orders 真的踩过）。
  const instant = "2026-01-10T12:00:00.000Z";
  const original = process.env.TZ;

  afterEach(() => {
    process.env.TZ = original;
  });

  it.each(["UTC", "Asia/Shanghai", "America/New_York", "Europe/Berlin"])(
    "在 %s 下 clockTime 都输出北京时间",
    (tz) => {
      process.env.TZ = tz;
      expect(clockTime(instant)).toBe("01/10 20:00");
    },
  );

  it("超过 30 天的相对时间也按北京时间渲染", () => {
    const longAgo = "2026-01-10T16:00:00.000Z"; // 北京时间已经是 1 月 11 日
    const now = Date.parse("2026-03-20T00:00:00.000Z");
    process.env.TZ = "America/New_York";
    expect(relativeTime(longAgo, now)).toBe("2026/1/11");
  });

  it("一分钟内算刚刚，跨过整分钟才换档", () => {
    const now = Date.parse(instant);
    expect(relativeTime(new Date(now - 59_000).toISOString(), now)).toBe("刚刚");
    expect(relativeTime(new Date(now - 61_000).toISOString(), now)).toBe("1 分钟前");
    expect(relativeTime(new Date(now - 3 * 3600_000).toISOString(), now)).toBe("3 小时前");
  });
});

describe("extractOfferCents", () => {
  it("接受与挂牌价同量级的报价", () => {
    expect(extractOfferCents("3900 可以的话我直接拍", listing.priceCents)).toBe(390000);
  });

  it("忽略电池健康度之类的无关数字", () => {
    expect(extractOfferCents("电池健康度还有 92 吗？", listing.priceCents)).toBeNull();
  });

  it("同时出现无关数字和报价时只取报价", () => {
    expect(
      extractOfferCents("电池 92 的话 3900 我就要了", listing.priceCents),
    ).toBe(390000);
  });

  it("支持 k / 万 单位", () => {
    expect(extractOfferCents("3.9k 出吗", listing.priceCents)).toBe(390000);
    expect(extractOfferCents("1.2万 收", 1289000)).toBe(1200000);
  });

  it("高于挂牌价的数字不算出价", () => {
    expect(extractOfferCents("隔壁卖 5000 呢", listing.priceCents)).toBeNull();
  });
});

describe("classifyIntent", () => {
  const cases: Array<[string, string]> = [
    ["能不能便宜点，少个两百", "bargain"],
    ["3900 我现在就拍，电池健康真的有 92 吗", "bargain"],
    ["昨天付的款，什么时候发货呀", "shipping_chase"],
    ["在吗？还有货吗，能自提不", "availability"],
    ["这个是国行还是港版？有划痕吗", "spec_question"],
    ["键盘是蓝牙版还是有线版？", "spec_question"],
    ["收到货开不了机，我要退款", "after_sale"],
    ["嗯嗯好的", "other"],
  ];

  it.each(cases)("「%s」→ %s", (text, expected) => {
    expect(classifyIntent(text, listing)).toBe(expected);
  });

  it("售后优先级高于议价", () => {
    expect(classifyIntent("东西坏了，便宜点我就不退了", listing)).toBe("after_sale");
  });
});

describe("lowestQuoteCents", () => {
  it("取底价和最大折扣价中的高者", () => {
    // 419000 * 0.88 = 368720 → 低于底价 385000，所以用底价
    expect(lowestQuoteCents(listing, 0.12)).toBe(385000);
    // 419000 * 0.97 = 406430 → 高于底价，四舍五入到元
    expect(lowestQuoteCents(listing, 0.03)).toBe(406400);
  });
});

describe("draftReply", () => {
  it("买家出价高于底线时直接接受并复述价格", () => {
    const draft = draftReply({
      conversation: conversation("3900 我现在就拍", { offerCents: 390000 }),
      listing,
      settings,
    });
    expect(draft.intent).toBe("bargain");
    expect(draft.counterOfferCents).toBe(390000);
    expect(draft.text).toContain("¥3,900.00");
    expect(draft.needsHumanEdit).toBe(false);
  });

  it("买家出价低于底线时还价到底线，绝不低于底价", () => {
    const draft = draftReply({
      conversation: conversation("3000 出不出", { offerCents: 300000 }),
      listing,
      settings,
    });
    expect(draft.counterOfferCents).toBe(385000);
    expect(draft.counterOfferCents!).toBeGreaterThanOrEqual(listing.floorPriceCents);
    expect(draft.text).toContain("¥3,850.00");
  });

  it("催发货会引用订单的真实物流信息", () => {
    const draft = draftReply({
      conversation: conversation("什么时候发货呀"),
      listing,
      settings,
      order: {
        id: "O1",
        listingId: listing.id,
        buyerName: "小鱼",
        amountCents: 419000,
        status: "shipped",
        createdAt: new Date(NOW - 86400000).toISOString(),
        carrier: "顺丰速运",
        trackingNo: "SF123",
      },
    });
    expect(draft.intent).toBe("shipping_chase");
    expect(draft.text).toContain("顺丰速运");
    expect(draft.text).toContain("SF123");
  });

  it("售后和细节咨询要求人工确认", () => {
    expect(
      draftReply({ conversation: conversation("屏幕坏了要退款"), listing, settings })
        .needsHumanEdit,
    ).toBe(true);
    expect(
      draftReply({ conversation: conversation("是国行还是港版？"), listing, settings })
        .needsHumanEdit,
    ).toBe(true);
  });

  it("库存为 0 时不会谎称还有货", () => {
    const draft = draftReply({
      conversation: conversation("在吗还有吗"),
      listing: { ...listing, stock: 0, status: "sold_out" },
      settings,
    });
    expect(draft.text).toContain("已经出掉了");
  });

  it("回复里带上店铺签名", () => {
    const draft = draftReply({ conversation: conversation("在吗"), listing, settings });
    expect(draft.text).toContain(settings.signature);
  });
});

describe("awaitingSellerReply", () => {
  const state = createSeedState(NOW);

  it("最后一条是买家消息才算待回复", () => {
    const needsReply = state.conversations.filter(awaitingSellerReply).map((c) => c.id);
    expect(needsReply).toEqual(["C001", "C002", "C003", "C004", "C005"]);
  });

  it("已关闭的会话即使买家最后发言也不再提醒", () => {
    const closed = conversation("再见", { status: "closed" });
    expect(awaitingSellerReply(closed)).toBe(false);
    expect(awaitingSellerReply({ ...closed, status: "needs_reply" })).toBe(true);
  });
});
