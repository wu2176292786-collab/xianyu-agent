import { describe, expect, it } from "vitest";
import {
  describeItemGroups,
  inferMessagePeer,
  mapConversations,
  mapItemGroups,
  mergeInboxConversations,
  mapListings,
  mapMessages,
  mapOrders,
  messageAuthor,
  messageSyncReq,
  readListingCard,
  readListingMetrics,
} from "@/lib/adapters/live/mapping";
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

  /**
   * reader 传给映射层的是**剥掉信封之后**的 `data` 本身，不是整个 `{ret, data}`。
   * 候选路径只写 `data.cardList` 的时候，真实同步会安静地说「没有变化」——
   * 因为它在找 `data.data.cardList`。两种形状都得认。
   */
  it("信封剥没剥掉都认得出来", () => {
    const card = {
      cardData: { id: "9001", title: "真实商品", priceInfo: { price: "128" } },
    };

    const unwrapped = mapListings({ cardList: [card] }, NOW);
    expect(unwrapped.items).toHaveLength(1);
    expect(unwrapped.items[0].priceCents).toBe(12800);

    const wrapped = mapListings({ data: { cardList: [card] } }, NOW);
    expect(wrapped.items).toHaveLength(1);
  });

  /**
   * 分组件数是平台自己报的数字。同步回来全是已售出时，它能直接区分
   * 「接口不对」和「确实一件在售的都没有」—— 我们为这个问题猜了
   * 14 个接口名和 18 个参数，而答案一直在 needGroupInfo 里。
   */
  it("读出平台自己报的分组件数", () => {
    const payload = {
      itemGroupList: [
        { groupId: 1, groupName: "综合", itemNumber: 38 },
        { groupId: 2, groupName: "在售", itemNumber: 0 },
        { groupId: 3, groupName: "已售出", itemNumber: 38 },
        // 名字或件数缺一个就跳过，不猜
        { groupId: 4, itemNumber: 5 },
      ],
    };

    const groups = mapItemGroups(payload);
    expect(groups).toEqual([
      { name: "综合", itemNumber: 38 },
      { name: "在售", itemNumber: 0 },
      { name: "已售出", itemNumber: 38 },
    ]);
    expect(describeItemGroups(groups)).toBe(
      "平台分组：综合 38 件，在售 0 件，已售出 38 件",
    );
  });

  it("没有分组信息时不编一句话出来", () => {
    expect(mapItemGroups({})).toEqual([]);
    expect(describeItemGroups([])).toBeUndefined();
  });

  /**
   * 详情接口的真实字段名，照抄实测结果。
   * 列表接口不给热度数据，这些只能从详情补。
   */
  it("从商品详情里读出标题和价格，给会话页用", () => {
    const detail = {
      itemDO: { itemId: 1070659254313, title: "追觅S7剃须刀 黑色", soldPrice: "268" },
    };
    expect(readListingCard(detail)).toEqual({
      id: "1070659254313",
      title: "追觅S7剃须刀 黑色",
      priceCents: 26800,
    });
    expect(readListingCard({ data: detail }).title).toBe("追觅S7剃须刀 黑色");
    expect(readListingCard({ itemDO: { soldPrice: "200" } }).title).toBeUndefined();
  });

  it("从商品详情里读出浏览 / 想要 / 库存", () => {
    const detail = {
      itemDO: { browseCnt: 687, wantCnt: 5, quantity: 1, collectCnt: 2, soldPrice: "200" },
    };
    expect(readListingMetrics(detail)).toEqual({ views7d: 687, wants: 5, stock: 1 });

    // 信封没剥掉也认
    expect(readListingMetrics({ data: detail }).views7d).toBe(687);
  });

  it("详情里没有这些字段时一律留空，不补 0", () => {
    expect(readListingMetrics({ itemDO: { soldPrice: "200" } })).toEqual({
      views7d: undefined,
      wants: undefined,
      stock: undefined,
    });
  });

  it("平台没给热度数据时标出来，不把占位的 0 当成真数据", () => {
    // 真实的 xyh.item.list 只回标题、价格、状态
    const { items } = mapListings(
      { cardList: [{ cardData: { id: "1", title: "东西", priceInfo: { price: "10" } } }] },
      NOW,
    );
    expect(items[0].metricsUnknown).toBe(true);

    const withMetrics = mapListings(
      { cardList: [{ cardData: { id: "1", title: "东西", price: 10, browseCnt: 30 } }] },
      NOW,
    );
    expect(withMetrics.items[0].metricsUnknown).toBe(false);
    expect(withMetrics.items[0].views7d).toBe(30);
  });

  /** 结构万一变了，扁平写法也得能认出来。 */
  it("扁平结构也认，昵称只认明确写着「对方」的字段", () => {
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

  it("认不出对方是谁时叫「买家」，绝不拿一个可能是我自己的昵称顶上", () => {
    const payload = {
      data: {
        // nick 既可能是买家也可能是我，所以不收
        sessions: [{ sessionId: "S9", nick: "老陈的数码小铺", content: "在吗", unreadCount: 1 }],
      },
    };
    expect(mapConversations(payload, NOW).items[0].buyerName).toBe("买家");
  });

  /** 真实的 session.sync 返回形状，字段名和嵌套都照抄实测结果。 */
  function realSession(overrides: Record<string, unknown> = {}) {
    return {
      sessions: [
        {
          message: { summary: { summary: "还能便宜点吗", ts: NOW - 60_000, unread: 2 } },
          session: {
            sessionId: 8001,
            sessionType: 1,
            itemInfo: { itemId: 812345 },
            userInfo: { userId: "2222", nick: "会走路的鱼" },
            ownerInfo: { userId: "1111", nick: "我自己" },
            ...overrides,
          },
        },
      ],
    };
  }

  it("认得出真实 session.sync 的嵌套结构", () => {
    const { items } = mapConversations(realSession(), NOW, "1111");
    expect(items[0]).toMatchObject({
      id: "8001",
      buyerName: "会走路的鱼",
      buyerId: "2222",
      listingId: "812345",
      status: "needs_reply",
    });
    expect(items[0].messages[0].text).toBe("还能便宜点吗");
  });

  /**
   * 实测踩到的坑：`ownerInfo` 不一定是我 —— 有的会话里我在 `userInfo` 那边。
   * 认错了就会用我自己的昵称去标会话。
   */
  it("我在哪一边都能认出对方", () => {
    const swapped = mapConversations(
      realSession({
        userInfo: { userId: "1111", nick: "我自己" },
        ownerInfo: { userId: "3333", nick: "拍照的老张" },
      }),
      NOW,
      "1111",
    );
    expect(swapped.items[0].buyerName).toBe("拍照的老张");
  });

  /**
   * 返回里混着系统会话（官方通知、物流提醒）。收进来的话，Agent 会一本正经地
   * 给「闲鱼小助手」起草回复。
   */
  it("系统会话不收，并如实计数", () => {
    const payload = {
      sessions: [
        {
          message: { summary: { summary: "买家问题", unread: 1 } },
          session: { sessionId: 1, sessionType: 1, userInfo: { userId: "2", nick: "买家" } },
        },
        {
          message: { summary: { summary: "您有一条新的物流通知", unread: 9 } },
          session: { sessionId: 2, sessionType: 25 },
        },
        {
          message: { summary: { summary: "活动推送", unread: 3 } },
          session: { sessionId: 3, sessionType: 62 },
        },
      ],
    };

    const { items, ignored } = mapConversations(payload, NOW, "1");
    expect(items).toHaveLength(1);
    expect(items[0].buyerName).toBe("买家");
    expect(ignored).toBe(2);
  });

  it("摘要带发送者 id 时，最后一条按 id 认，不靠未读数瞎猜", () => {
    const payload = {
      sessions: [
        {
          message: {
            summary: {
              summary: "刀还在的",
              ts: NOW - 60_000,
              unread: 0,
              senderUserId: "2222",
            },
          },
          session: {
            sessionId: 8002,
            sessionType: 1,
            userInfo: { userId: "2222", nick: "t***5" },
            ownerInfo: { userId: "1111", nick: "我自己" },
          },
        },
      ],
    };
    expect(mapConversations(payload, NOW, "1111").items[0].messages[0].author).toBe("buyer");
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

  it("按最后一条时间倒序，最新的会话排前面", () => {
    const payload = {
      sessions: [
        {
          message: { summary: { summary: "去年的还在吗", ts: NOW - 400 * 86400_000, unread: 1 } },
          session: { sessionId: 1, sessionType: 1, userInfo: { userId: "2", nick: "旧买家" } },
        },
        {
          message: { summary: { summary: "248 可出嘛", ts: NOW - 60_000, unread: 1 } },
          session: { sessionId: 2, sessionType: 1, userInfo: { userId: "3", nick: "新买家" } },
        },
      ],
    };

    const { items } = mapConversations(payload, NOW, "1");
    expect(items.map((item) => item.id)).toEqual(["2", "1"]);
    expect(items[0].buyerName).toBe("新买家");
  });

  it("超过两周的未读会话不当成待回复", () => {
    const payload = {
      sessions: [
        {
          message: { summary: { summary: "还在吗", ts: NOW - 40 * 86400_000, unread: 3 } },
          session: { sessionId: 9, sessionType: 1, userInfo: { userId: "2", nick: "旧买家" } },
        },
      ],
    };

    const { items } = mapConversations(payload, NOW, "1");
    expect(items[0].status).toBe("awaiting_buyer");
    expect(items[0].messages[0].author).toBe("buyer");
  });

  it("意图不在映射层瞎猜，交给规则引擎按文本判定", () => {
    const payload = {
      data: { sessions: [{ sessionId: "S3", content: "退货", unreadCount: 1 }] },
    };
    expect(mapConversations(payload, NOW).items[0].intent).toBe("other");
  });

  it("历史消息接口的 req 必须是字符串，字段是 fetchs", () => {
    expect(messageSyncReq("34543055754")).toEqual({
      req: JSON.stringify({ sessionId: "34543055754", start: 0, fetchs: 50, type: 1 }),
    });
  });

  /** 真实的 message.sync 返回形状，字段名照抄实测结果。 */
  function realMessages() {
    return {
      messages: [
        {
          messageUuid: "m-older",
          arg1: "MsgText",
          content: { contentType: 1, text: { text: "最近有没有维斯要出？" } },
          senderInfo: { nick: "tb578526545", userId: "2***1" },
          timeStamp: NOW - 120_000,
        },
        {
          messageUuid: "m-buyer",
          arg1: "MsgText",
          content: { contentType: 1, text: { text: "有的，你看这只" } },
          senderInfo: { nick: "欣***原", userId: "9***0" },
          timeStamp: NOW - 60_000,
        },
        {
          messageUuid: "m-pic",
          arg1: "MsgImage",
          content: { contentType: 2 },
          senderInfo: { nick: "欣***原", userId: "9***0" },
          timeStamp: NOW - 30_000,
        },
        {
          messageUuid: "m-latest",
          content: { text: { text: "就来问下你" } },
          senderInfo: { nick: "tb578526545", userId: "1111" },
          timeStamp: NOW,
        },
      ],
    };
  }

  it("认得出真实 message.sync 的嵌套结构，并按时间排好", () => {
    const { items, skipped } = mapMessages(realMessages(), NOW, "1111", ["tb578526545"]);
    expect(skipped).toBe(0);
    expect(items.map((m) => m.text)).toEqual([
      "最近有没有维斯要出？",
      "有的，你看这只",
      "[图片]",
      "就来问下你",
    ]);
    expect(items[0].author).toBe("seller");
    expect(items[1].author).toBe("buyer");
    expect(items[3].author).toBe("seller");
  });

  it("认得出 IM listUserMessages 的 messageId / createAt / reminderContent", () => {
    const { items, skipped } = mapMessages(
      {
        userMessageModels: [
          {
            message: {
              messageId: "m-buyer",
              createAt: NOW - 60_000,
              extension: {
                senderUserId: "2222",
                reminderTitle: "会走路的鱼",
                reminderContent: "还在吗",
              },
              content: { contentType: 101, custom: { type: 1, data: "" } },
            },
          },
          {
            message: {
              messageId: "m-seller",
              createAt: NOW - 30_000,
              extension: {
                senderUserId: "1111",
                reminderTitle: "我自己",
                reminderContent: "在的",
              },
            },
          },
        ],
      },
      NOW,
      "1111",
      ["我自己"],
      { peerId: "2222" },
    );
    expect(skipped).toBe(0);
    expect(items.map((message) => ({ author: message.author, text: message.text }))).toEqual([
      { author: "buyer", text: "还在吗" },
      { author: "seller", text: "在的" },
    ]);
  });

  it("能从历史里认出对方的 id 和昵称", () => {
    expect(
      inferMessagePeer(
        {
          userMessageModels: [
            {
              message: {
                extension: { senderUserId: "1111", reminderTitle: "我自己" },
              },
            },
            {
              message: {
                extension: { senderUserId: "2222", reminderTitle: "会走路的鱼" },
              },
            },
          ],
        },
        "1111",
        ["我自己"],
      ),
    ).toEqual({ peerId: "2222", peerNicks: ["会走路的鱼"] });
  });

  it("IM 推来的真人会话会并进收件箱，并丢掉过期摘要", () => {
    const existing = [
      {
        id: "stale",
        buyerName: "旧买家",
        buyerEmoji: "🐟",
        listingId: "",
        status: "awaiting_buyer" as const,
        intent: "other" as const,
        messages: [{ id: "s", author: "seller" as const, text: "在的", createdAt: new Date(NOW).toISOString() }],
      },
    ];
    const merged = mergeInboxConversations(
      [],
      [{ cid: "60585751957", sessionType: 1, itemId: "812345" }],
      existing,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: "60585751957", listingId: "812345" });
  });

  it("HTTP 和 IM 都没有新会话时，保留本地收件箱", () => {
    const existing = [
      {
        id: "keep",
        buyerName: "买家",
        buyerEmoji: "🐟",
        listingId: "",
        status: "awaiting_buyer" as const,
        intent: "other" as const,
        messages: [],
      },
    ];
    expect(mergeInboxConversations([], [], existing)).toEqual(existing);
  });

  it("脱敏的 userId 对不上自己时，改用昵称认出发送者", () => {
    const record = { senderInfo: { nick: "老陈的数码小铺", userId: "2***1" } };
    expect(messageAuthor(record, "2221529979637", ["老陈的数码小铺"])).toBe("seller");
    expect(messageAuthor(record, "2221529979637", [])).toBe("buyer");
  });

  it("网页 IM 那层套壳和 base64 正文也能抽出来，不会只剩自己发的", () => {
    const data = Buffer.from(
      JSON.stringify({ contentType: 1, text: { text: "刀还在的，包邮" } }),
      "utf8",
    ).toString("base64");
    const { items, skipped } = mapMessages(
      {
        messages: [
          {
            messageUuid: "mine",
            content: { contentType: 1, text: { text: "2488 可出嘛" } },
            senderInfo: { userId: "1111", nick: "tb578526545" },
            timeStamp: NOW - 60_000,
          },
          {
            message: {
              messageUuid: "theirs",
              content: { contentType: 101, custom: { type: 1, data } },
              senderInfo: { userId: "2222", nick: "t***5" },
              extension: { senderUserId: "2222", reminderContent: "刀还在的，包邮" },
              timeStamp: NOW,
            },
          },
        ],
      },
      NOW,
      "1111",
      ["tb578526545"],
      { peerId: "2222", peerNicks: ["t***5"] },
    );
    expect(skipped).toBe(0);
    expect(items.map((m) => [m.author, m.text])).toEqual([
      ["seller", "2488 可出嘛"],
      ["buyer", "刀还在的，包邮"],
    ]);
  });

  it("对方的 id / 昵称能把话标回买家，不会全部算成我", () => {
    expect(
      messageAuthor(
        { senderInfo: { userId: "2222", nick: "刀店老板" } },
        "1111",
        ["tb578526545"],
        { peerId: "2222", peerNicks: ["刀店老板"] },
      ),
    ).toBe("buyer");
  });

  it("缺 id 或正文的历史消息跳过，不编一句出来", () => {
    const { items, skipped } = mapMessages(
      {
        messages: [
          { messageUuid: "ok", content: { text: { text: "在的" } }, senderInfo: { nick: "买家" } },
          { content: { text: { text: "没有 id" } } },
          { messageUuid: "empty", content: { contentType: 1 } },
        ],
      },
      NOW,
    );
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe("在的");
    expect(skipped).toBe(2);
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
