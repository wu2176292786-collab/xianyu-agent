import type {
  ActivityEntry,
  AppState,
  AutomationRule,
  Conversation,
  DailyMetric,
  Listing,
  Order,
} from "./types";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** 固定种子的伪随机数，保证每次 seed 出来的示例数据一致，方便截图和测试。 */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function iso(now: number, offsetMs: number): string {
  return new Date(now + offsetMs).toISOString();
}

function dateKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

const LISTING_BLUEPRINTS: Array<
  Omit<Listing, "createdAt" | "lastRefreshedAt" | "id">
> = [
  {
    title: "iPhone 14 Pro 256G 暗紫色 国行双卡 电池健康 92%",
    category: "手机数码",
    emoji: "📱",
    priceCents: 419000,
    floorPriceCents: 385000,
    costCents: 352000,
    stock: 1,
    status: "on_sale",
    views7d: 1268,
    wants: 43,
    inquiries7d: 17,
    tags: ["验机报告", "可小刀", "支持验货宝"],
  },
  {
    title: "戴尔 U2723QE 27寸 4K 显示器 Type-C 90W 反向充电",
    category: "电脑办公",
    emoji: "🖥️",
    priceCents: 268000,
    floorPriceCents: 245000,
    costCents: 228000,
    stock: 2,
    status: "on_sale",
    views7d: 642,
    wants: 21,
    inquiries7d: 9,
    tags: ["自提优先", "带原包装"],
  },
  {
    title: "HHKB Professional HYBRID Type-S 静电容键盘 白无刻",
    category: "电脑办公",
    emoji: "⌨️",
    priceCents: 148000,
    floorPriceCents: 132000,
    costCents: 121000,
    stock: 1,
    status: "on_sale",
    views7d: 389,
    wants: 16,
    inquiries7d: 5,
    tags: ["9 成新", "含收纳包"],
  },
  {
    title: "索尼 A7M4 机身 快门数 8600 送原装电池两块",
    category: "影音摄影",
    emoji: "📷",
    priceCents: 1289000,
    floorPriceCents: 1215000,
    costCents: 1160000,
    stock: 1,
    status: "on_sale",
    views7d: 903,
    wants: 37,
    inquiries7d: 12,
    tags: ["官方保内", "支持当面交易"],
  },
  {
    title: "Nintendo Switch OLED 白色 + 塞尔达王国之泪 卡带",
    category: "游戏电玩",
    emoji: "🎮",
    priceCents: 179000,
    floorPriceCents: 162000,
    costCents: 150000,
    stock: 1,
    status: "on_sale",
    views7d: 1544,
    wants: 58,
    inquiries7d: 23,
    tags: ["带原装收纳包", "无拆修"],
  },
  {
    title: "乐高 10307 埃菲尔铁塔 已拼 含说明书全套",
    category: "潮玩模型",
    emoji: "🧱",
    priceCents: 268000,
    floorPriceCents: 238000,
    costCents: 219000,
    stock: 1,
    status: "on_sale",
    views7d: 221,
    wants: 9,
    inquiries7d: 2,
    tags: ["仅限自提", "零件齐全"],
  },
  {
    title: "迪卡侬 Quechua 露营折叠椅 两把打包出",
    category: "运动户外",
    emoji: "🏕️",
    priceCents: 12800,
    floorPriceCents: 9900,
    costCents: 8000,
    stock: 4,
    status: "on_sale",
    views7d: 156,
    wants: 6,
    inquiries7d: 3,
    tags: ["包邮", "八成新"],
  },
  {
    title: "Kindle Paperwhite 5 32G 信号灯版 带原装保护套",
    category: "图书文娱",
    emoji: "📖",
    priceCents: 62000,
    floorPriceCents: 55000,
    costCents: 49000,
    stock: 0,
    status: "on_sale",
    views7d: 74,
    wants: 4,
    inquiries7d: 1,
    tags: ["已售出待下架"],
  },
  {
    title: "AirPods Pro 2 USB-C 版 国行 激活半年",
    category: "手机数码",
    emoji: "🎧",
    priceCents: 108000,
    floorPriceCents: 96000,
    costCents: 89000,
    stock: 1,
    status: "on_sale",
    views7d: 812,
    wants: 29,
    inquiries7d: 11,
    tags: ["保内", "顺丰包邮"],
  },
  {
    title: "宜家 MARKUS 马库斯 人体工学办公椅 黑色",
    category: "家居家装",
    emoji: "🪑",
    priceCents: 49000,
    floorPriceCents: 39000,
    costCents: 33000,
    stock: 1,
    status: "on_sale",
    views7d: 97,
    wants: 3,
    inquiries7d: 1,
    tags: ["同城自提", "搬家出"],
  },
  {
    title: "小米空气净化器 4 Pro 新滤芯已换",
    category: "家用电器",
    emoji: "🌬️",
    priceCents: 59000,
    floorPriceCents: 49000,
    costCents: 42000,
    stock: 1,
    status: "sold_out",
    views7d: 48,
    wants: 2,
    inquiries7d: 0,
    tags: ["已成交"],
  },
];

function buildListings(now: number, rand: () => number): Listing[] {
  return LISTING_BLUEPRINTS.map((bp, index) => {
    // 前几个是最近上架的热门品，后面越来越「陈货」，方便展示降价 / 擦亮规则。
    const ageDays = 2 + index * 3 + Math.floor(rand() * 3);
    const refreshHoursAgo =
      index === 0 ? 2 : index === 1 ? 6 : 26 + index * 9 + Math.floor(rand() * 6);
    return {
      ...bp,
      id: `L${String(index + 1).padStart(3, "0")}`,
      createdAt: iso(now, -ageDays * DAY),
      lastRefreshedAt: iso(now, -refreshHoursAgo * HOUR),
    };
  });
}

function buildConversations(now: number): Conversation[] {
  return [
    {
      id: "C001",
      buyerName: "会走路的鱼",
      buyerEmoji: "🐟",
      listingId: "L001",
      status: "needs_reply",
      intent: "bargain",
      offerCents: 390000,
      messages: [
        {
          id: "C001-M1",
          author: "buyer",
          text: "在的话 3900 我现在就拍，电池健康度真的有 92 吗？",
          createdAt: iso(now, -38 * 60 * 1000),
        },
      ],
    },
    {
      id: "C002",
      buyerName: "阿栋不吃香菜",
      buyerEmoji: "🥬",
      listingId: "L005",
      status: "needs_reply",
      intent: "spec_question",
      messages: [
        {
          id: "C002-M1",
          author: "buyer",
          text: "你好，这个 Switch 是港版还是国行？屏幕有没有划痕？",
          createdAt: iso(now, -2 * HOUR),
        },
        {
          id: "C002-M2",
          author: "seller",
          text: "日版，港行电源，屏幕贴了膜没有划痕。",
          createdAt: iso(now, -105 * 60 * 1000),
        },
        {
          id: "C002-M3",
          author: "buyer",
          text: "那手柄会漂移吗？卡带是不是中文的？",
          createdAt: iso(now, -52 * 60 * 1000),
        },
      ],
    },
    {
      id: "C003",
      buyerName: "momo",
      buyerEmoji: "🧋",
      listingId: "L009",
      status: "needs_reply",
      intent: "shipping_chase",
      messages: [
        {
          id: "C003-M1",
          author: "buyer",
          text: "昨天下午付的款，今天还没看到物流，什么时候能发出呀？",
          createdAt: iso(now, -3 * HOUR),
        },
      ],
    },
    {
      id: "C004",
      buyerName: "西二旗搬砖仔",
      buyerEmoji: "🧱",
      listingId: "L002",
      status: "needs_reply",
      intent: "availability",
      messages: [
        {
          id: "C004-M1",
          author: "buyer",
          text: "在吗？显示器还有货吗，能同城自提吗",
          createdAt: iso(now, -6 * HOUR),
        },
      ],
    },
    {
      id: "C005",
      buyerName: "拍照的老张",
      buyerEmoji: "📸",
      listingId: "L004",
      status: "needs_reply",
      intent: "bargain",
      offerCents: 1180000,
      messages: [
        {
          id: "C005-M1",
          author: "buyer",
          text: "机身 11800 出不出？我今天下午可以去你那当面验机。",
          createdAt: iso(now, -25 * 60 * 1000),
        },
      ],
    },
    {
      id: "C006",
      buyerName: "小满",
      buyerEmoji: "🌾",
      listingId: "L003",
      status: "awaiting_buyer",
      intent: "spec_question",
      messages: [
        {
          id: "C006-M1",
          author: "buyer",
          text: "键盘是蓝牙版还是有线版？",
          createdAt: iso(now, -2 * DAY),
        },
        {
          id: "C006-M2",
          author: "seller",
          text: "HYBRID 是双模的，蓝牙和 Type-C 有线都支持，最多配对 4 台设备。",
          createdAt: iso(now, -2 * DAY + 20 * 60 * 1000),
          viaAgent: true,
        },
      ],
    },
    {
      id: "C007",
      buyerName: "露营爱好者阿May",
      buyerEmoji: "⛺",
      listingId: "L007",
      status: "closed",
      intent: "other",
      messages: [
        {
          id: "C007-M1",
          author: "buyer",
          text: "椅子收到了，很结实，谢谢老板！",
          createdAt: iso(now, -4 * DAY),
        },
        {
          id: "C007-M2",
          author: "seller",
          text: "感谢支持，用得开心～有问题随时找我。",
          createdAt: iso(now, -4 * DAY + 12 * 60 * 1000),
        },
      ],
    },
  ];
}

function buildOrders(now: number): Order[] {
  return [
    {
      id: "O20240001",
      listingId: "L009",
      buyerName: "momo",
      amountCents: 108000,
      status: "pending_shipment",
      createdAt: iso(now, -31 * HOUR),
      paidAt: iso(now, -30 * HOUR),
    },
    {
      id: "O20240002",
      listingId: "L007",
      buyerName: "带娃去郊游",
      amountCents: 12800,
      status: "pending_shipment",
      createdAt: iso(now, -9 * HOUR),
      paidAt: iso(now, -8 * HOUR),
    },
    {
      id: "O20240003",
      listingId: "L008",
      buyerName: "夜读人",
      amountCents: 62000,
      status: "shipped",
      createdAt: iso(now, -2 * DAY),
      paidAt: iso(now, -2 * DAY + 10 * 60 * 1000),
      shippedAt: iso(now, -1.4 * DAY),
      carrier: "顺丰速运",
      trackingNo: "SF7412885531xx",
    },
    {
      id: "O20240004",
      listingId: "L011",
      buyerName: "清风",
      amountCents: 59000,
      status: "completed",
      createdAt: iso(now, -6 * DAY),
      paidAt: iso(now, -6 * DAY + 8 * 60 * 1000),
      shippedAt: iso(now, -5 * DAY),
      carrier: "中通快递",
      trackingNo: "ZT9930271184xx",
    },
    {
      id: "O20240005",
      listingId: "L003",
      buyerName: "键圈萌新",
      amountCents: 148000,
      status: "refund_requested",
      createdAt: iso(now, -3 * DAY),
      paidAt: iso(now, -3 * DAY + 5 * 60 * 1000),
      shippedAt: iso(now, -2.5 * DAY),
      carrier: "京东物流",
      trackingNo: "JD0055213977xx",
    },
    {
      id: "O20240006",
      listingId: "L010",
      buyerName: "租房青年",
      amountCents: 49000,
      status: "pending_payment",
      createdAt: iso(now, -40 * 60 * 1000),
    },
  ];
}

export function buildRules(): AutomationRule[] {
  return [
    {
      id: "R-refresh",
      kind: "refresh_listing",
      name: "定时擦亮在售宝贝",
      description:
        "超过设定小时数没有擦亮的在售商品会被重新擦亮，让它回到搜索结果前排。",
      enabled: true,
      requiresApproval: false,
      params: { minHoursSinceRefresh: 24, maxPerRun: 4 },
    },
    {
      id: "R-price",
      kind: "price_drop",
      name: "滞销商品阶梯降价",
      description:
        "上架超过 N 天且近 7 天浏览低于阈值的商品，按比例降价，但绝不低于你设定的底价。",
      enabled: true,
      requiresApproval: true,
      params: { staleDays: 14, maxViews7d: 260, stepPercent: 5, maxPerRun: 2 },
    },
    {
      id: "R-reply",
      kind: "auto_reply",
      name: "买家消息自动起草回复",
      description:
        "识别买家意图（议价 / 咨询 / 催发货 / 问库存 / 售后）并起草回复，议价会自动带上还价。",
      enabled: true,
      requiresApproval: true,
      params: { maxPerRun: 6 },
    },
    {
      id: "R-ship",
      kind: "shipment_reminder",
      name: "超时未发货自动备单",
      description:
        "付款后超过承诺时效仍未发货的订单，自动生成发货单并预填快递单号等待确认。",
      enabled: true,
      requiresApproval: true,
      params: { graceHours: 24 },
    },
    {
      id: "R-delist",
      kind: "sold_out_delist",
      name: "零库存自动下架",
      description: "库存为 0 但仍在售的商品会被下架，避免超卖和纠纷。",
      enabled: true,
      requiresApproval: false,
      params: {},
    },
  ];
}

function buildMetrics(now: number, rand: () => number): DailyMetric[] {
  const out: DailyMetric[] = [];
  for (let i = 13; i >= 0; i -= 1) {
    const ts = now - i * DAY;
    const weekday = new Date(ts).getUTCDay();
    const weekendBoost = weekday === 0 || weekday === 6 ? 1.25 : 1;
    const views = Math.round((520 + rand() * 340) * weekendBoost + (13 - i) * 18);
    const inquiries = Math.round(views * (0.028 + rand() * 0.015));
    const orders = Math.max(0, Math.round(inquiries * (0.16 + rand() * 0.14)));
    const gmvCents = orders * Math.round(48000 + rand() * 180000);
    out.push({ date: dateKey(ts), views, inquiries, orders, gmvCents });
  }
  return out;
}

function buildActivity(now: number): ActivityEntry[] {
  return [
    {
      id: "A1",
      at: iso(now, -2 * DAY + 20 * 60 * 1000),
      kind: "agent",
      text: "已发送回复给「小满」：解释 HHKB HYBRID 双模连接方式。",
    },
    {
      id: "A2",
      at: iso(now, -1.4 * DAY),
      kind: "human",
      text: "你确认发货订单 O20240003，顺丰速运 SF7412885531xx。",
    },
    {
      id: "A3",
      at: iso(now, -20 * HOUR),
      kind: "agent",
      text: "擦亮了 3 件在售商品：iPhone 14 Pro、Switch OLED、AirPods Pro 2。",
    },
    {
      id: "A4",
      at: iso(now, -9 * HOUR),
      kind: "system",
      text: "新订单 O20240002 已付款，承诺 24 小时内发货。",
    },
  ];
}

export function createSeedState(now = Date.now()): AppState {
  const rand = mulberry32(20240614);
  return {
    settings: {
      shopName: "老陈的数码小铺",
      maxDiscount: 0.12,
      shipWithinHours: 24,
      signature: "—— 老陈｜工作日 22:00 前的订单当天寄出",
      autoTickEnabled: true,
      autoTickMinutes: 15,
    },
    listings: buildListings(now, rand),
    conversations: buildConversations(now),
    orders: buildOrders(now),
    rules: buildRules(),
    actions: [],
    activity: buildActivity(now),
    metrics: buildMetrics(now, rand),
    runs: [],
    seededAt: new Date(now).toISOString(),
  };
}
