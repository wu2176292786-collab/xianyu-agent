import { describe, expect, it } from "vitest";
import { mapConversations, mapListings, mapOrders } from "@/lib/adapters/live/mapping";
import { describeShape, getList, getPath, pick, pickNumber } from "@/lib/adapters/live/paths";

const NOW = Date.parse("2026-01-10T12:00:00.000Z");

describe("路径取值", () => {
  const sample = {
    data: {
      cardList: [{ cardData: { id: "1", priceInfo: { price: "12.5" } } }],
      empty: [],
    },
  };

  it("按点号一层层取", () => {
    expect(getPath(sample, "data.cardList[0].cardData.id")).toBe("1");
    expect(getPath(sample, "data.cardList[].cardData.id")).toBe("1");
  });

  it("取不到就是 undefined，不抛异常", () => {
    expect(getPath(sample, "data.nope.deep.deeper")).toBeUndefined();
    expect(getPath(null, "a.b")).toBeUndefined();
    expect(getPath(sample, "")).toBeUndefined();
  });

  it("getList 只认数组", () => {
    expect(getList(sample, "data.cardList")).toHaveLength(1);
    expect(getList(sample, "data.empty")).toHaveLength(0);
    expect(getList(sample, "data.cardList[0].cardData")).toHaveLength(0);
  });

  it("候选路径按顺序命中第一个有值的", () => {
    const record = { b: "second" };
    expect(pick(record, ["a", "b", "c"])).toBe("second");
    expect(pick(record, ["a", "c"])).toBeUndefined();
  });

  it("数字能从带单位的字符串里抠出来", () => {
    expect(pickNumber({ p: "¥1,299.00" }, ["p"])).toBe(1299);
    expect(pickNumber({ p: "abc" }, ["p"])).toBeUndefined();
  });

  it("describeShape 能把结构摊平，方便对着抓包结果填字段", () => {
    const lines = describeShape(sample);
    expect(lines.some((line) => line.includes("data.cardList[0].cardData.id"))).toBe(true);
  });
});

describe("商品映射", () => {
  it("认得出常见的 cardList 结构", () => {
    const payload = {
      data: {
        cardList: [
          {
            cardData: {
              id: "812345",
              title: "iPhone 14 Pro 256G",
              priceInfo: { price: "3999" },
              quantity: 2,
              browseCnt: 128,
              wantCnt: 7,
            },
          },
        ],
      },
    };

    const { items, skipped } = mapListings(payload, NOW);
    expect(skipped).toBe(0);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "812345",
      title: "iPhone 14 Pro 256G",
      priceCents: 399900,
      stock: 2,
      views7d: 128,
      wants: 7,
    });
  });

  it("会话列表能还原出买家、商品和最后一条消息", () => {
    const payload = {
      data: {
        sessions: [
          {
            sessionId: "S1001",
            peerUserNick: "会走路的鱼",
            itemId: "812345",
            lastMessageContent: "3900 能出吗？",
            lastMessageTime: NOW - 60_000,
            unreadCount: 2,
          },
        ],
      },
    };

    const { items, skipped } = mapConversations(payload, NOW);
    expect(skipped).toBe(0);
    expect(items[0]).toMatchObject({
      id: "S1001",
      buyerName: "会走路的鱼",
      listingId: "812345",
      status: "needs_reply",
    });
    expect(items[0].messages).toHaveLength(1);
    expect(items[0].messages[0]).toMatchObject({
      author: "buyer",
      text: "3900 能出吗？",
    });
  });

  it("未读为 0 的会话算等买家回，不会催着 Agent 去回复", () => {
    const payload = {
      data: {
        sessionList: [
          { cid: "S2", nick: "小满", content: "好的，谢谢", unreadCount: 0 },
        ],
      },
    };

    const { items } = mapConversations(payload, NOW);
    expect(items[0].status).toBe("awaiting_buyer");
    expect(items[0].messages[0].author).toBe("seller");
  });

  it("意图不在映射层瞎猜，交给规则引擎按文本判定", () => {
    const payload = {
      data: { sessions: [{ sessionId: "S3", content: "退货", unreadCount: 1 }] },
    };
    expect(mapConversations(payload, NOW).items[0].intent).toBe("other");
  });

  it("缺会话 id 或最后一条消息的记录直接跳过", () => {
    const payload = {
      data: {
        sessions: [
          { sessionId: "S1", content: "有的" },
          { sessionId: "S2" },
          { content: "没有 id" },
        ],
      },
    };

    const { items, skipped } = mapConversations(payload, NOW);
    expect(items).toHaveLength(1);
    expect(skipped).toBe(2);
  });

  it("同步进来的商品底价一律是未确认的", () => {
    const payload = {
      data: { items: [{ itemId: "1", title: "东西", price: 100 }] },
    };
    const { items } = mapListings(payload, NOW);
    expect(items[0].floorConfirmed).toBe(false);
    expect(items[0].floorPriceCents).toBe(9000);
  });

  it("缺 id、标题或价格的记录直接跳过，绝不编一个值出来", () => {
    const payload = {
      data: {
        items: [
          { itemId: "1", title: "完整的", price: 10 },
          { itemId: "2", title: "没价格的" },
          { title: "没 id 的", price: 10 },
          { itemId: "4", price: 10 },
        ],
      },
    };

    const { items, skipped } = mapListings(payload, NOW);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("1");
    expect(skipped).toBe(3);
  });

  it("结构完全不认识时返回空，而不是瞎猜", () => {
    expect(mapListings({ whatever: true }, NOW)).toEqual({ items: [], skipped: 0 });
    expect(mapListings(null, NOW).items).toHaveLength(0);
  });

  it("价格单位优先用分，没有分才按元换算", () => {
    const byCent = mapListings({ data: { items: [{ id: "1", title: "t", priceCent: 1999 }] } }, NOW);
    expect(byCent.items[0].priceCents).toBe(1999);

    const byYuan = mapListings({ data: { items: [{ id: "1", title: "t", price: 19.99 }] } }, NOW);
    expect(byYuan.items[0].priceCents).toBe(1999);
  });

  it("状态码认得出售罄和下架，其余当在售", () => {
    const of = (itemStatus: string) =>
      mapListings({ data: { items: [{ id: "1", title: "t", price: 1, itemStatus }] } }, NOW)
        .items[0].status;
    expect(of("SOLD_OUT")).toBe("sold_out");
    expect(of("DELISTED")).toBe("delisted");
    expect(of("ON_SALE")).toBe("on_sale");
    expect(of("什么鬼")).toBe("on_sale");
  });
});

describe("订单映射", () => {
  it("认得出常见字段", () => {
    const payload = {
      data: {
        orders: [
          {
            orderId: "2000123",
            itemId: "812345",
            buyerNick: "会走路的鱼",
            actualFee: 3999,
            orderStatus: "WAIT_SELLER_SEND_GOODS",
          },
        ],
      },
    };

    const { items } = mapOrders(payload, NOW);
    expect(items[0]).toMatchObject({
      id: "2000123",
      listingId: "812345",
      buyerName: "会走路的鱼",
      amountCents: 399900,
      status: "pending_shipment",
    });
  });

  it("缺订单号或金额的记录跳过", () => {
    const payload = { data: { orders: [{ orderId: "1" }, { actualFee: 10 }] } };
    const { items, skipped } = mapOrders(payload, NOW);
    expect(items).toHaveLength(0);
    expect(skipped).toBe(2);
  });

  it("订单状态映射覆盖几种常见写法", () => {
    const of = (orderStatus: string) =>
      mapOrders({ data: { orders: [{ orderId: "1", actualFee: 1, orderStatus }] } }, NOW)
        .items[0].status;
    expect(of("WAIT_BUYER_PAY")).toBe("pending_payment");
    expect(of("WAIT_SELLER_SEND_GOODS")).toBe("pending_shipment");
    expect(of("WAIT_BUYER_CONFIRM_GOODS")).toBe("shipped");
    expect(of("TRADE_FINISHED")).toBe("completed");
    expect(of("REFUND_PROCESSING")).toBe("refund_requested");
  });
});
