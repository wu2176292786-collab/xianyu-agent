/**
 * 闲鱼运营 Agent 的领域模型。
 *
 * 金额一律以「分」为单位存储，避免浮点误差；只有在渲染层才转成元。
 */

export type ListingStatus = "on_sale" | "sold_out" | "delisted";

export interface Listing {
  id: string;
  title: string;
  category: string;
  emoji: string;
  priceCents: number;
  /** 可以自动降价的下限，Agent 永远不会把价格压到这条线以下 */
  floorPriceCents: number;
  /**
   * 底价是不是你亲自确认过的。
   *
   * 从平台同步进来的新商品只有挂牌价，底价是猜的，这时候自动降价必须避开它 ——
   * 拿一个猜出来的底价去降价，等于没有底价。
   */
  floorConfirmed: boolean;
  costCents: number;
  stock: number;
  status: ListingStatus;
  createdAt: string;
  /** 上次擦亮时间 */
  lastRefreshedAt: string;
  views7d: number;
  wants: number;
  inquiries7d: number;
  tags: string[];
  /**
   * 平台这次没给浏览 / 想要 / 库存。
   *
   * 真实商品列表接口只回标题、价格和状态，没有热度数据。这时 `views7d` 之类
   * 只是占位的 0，**不能当成「浏览量很低」** —— 否则滞销降价规则会拿一个我们
   * 从来没拿到过的数字去降你的价。带这个标记的商品，降价规则会直接绕开。
   */
  metricsUnknown?: boolean;
}

export type Intent =
  | "bargain"
  | "spec_question"
  | "shipping_chase"
  | "availability"
  | "after_sale"
  | "other";

export type MessageAuthor = "buyer" | "seller";

export interface Message {
  id: string;
  author: MessageAuthor;
  text: string;
  createdAt: string;
  /** 由 Agent 起草并经人工确认后发出的消息 */
  viaAgent?: boolean;
}

export type ConversationStatus = "needs_reply" | "awaiting_buyer" | "closed";

export interface Conversation {
  id: string;
  buyerName: string;
  buyerEmoji: string;
  listingId: string;
  status: ConversationStatus;
  intent: Intent;
  /** 买家的出价（若有），单位分 */
  offerCents?: number;
  messages: Message[];
}

export type OrderStatus =
  | "pending_payment"
  | "pending_shipment"
  | "shipped"
  | "completed"
  | "refund_requested";

export interface Order {
  id: string;
  listingId: string;
  buyerName: string;
  amountCents: number;
  status: OrderStatus;
  createdAt: string;
  paidAt?: string;
  shippedAt?: string;
  carrier?: string;
  trackingNo?: string;
}

export type RuleKind =
  | "refresh_listing"
  | "price_drop"
  | "auto_reply"
  | "shipment_reminder"
  | "sold_out_delist";

export interface AutomationRule {
  id: string;
  kind: RuleKind;
  name: string;
  description: string;
  enabled: boolean;
  /** 关闭后 Agent 直接执行，不进审批队列 */
  requiresApproval: boolean;
  params: Record<string, number>;
}

export type ActionPayload =
  | { type: "refresh_listing"; listingId: string }
  | {
      type: "adjust_price";
      listingId: string;
      fromCents: number;
      toCents: number;
    }
  | { type: "send_reply"; conversationId: string; text: string }
  | {
      type: "ship_order";
      orderId: string;
      carrier: string;
      trackingNo: string;
    }
  | { type: "delist_listing"; listingId: string };

export type ActionType = ActionPayload["type"];

export type ActionStatus = "pending" | "applied" | "rejected" | "failed";

export type RiskLevel = "low" | "medium" | "high";

export interface AgentAction {
  id: string;
  ruleId: string;
  ruleKind: RuleKind;
  title: string;
  /** 为什么提出这个动作，展示给人看的解释 */
  reason: string;
  risk: RiskLevel;
  status: ActionStatus;
  createdAt: string;
  decidedAt?: string;
  /** 自动执行（规则未开启人工审批）还是人工点了通过 */
  decidedBy?: "agent" | "human";
  payload: ActionPayload;
  /** 执行失败时平台返回的原因 */
  failureReason?: string;
  /** 已经尝试执行的次数，重试会累加 */
  attempts?: number;
  /** 演练模式下「执行」的，实际什么都没发生 */
  dryRun?: boolean;
}

export type TickTrigger = "manual" | "scheduled";

/** 一次巡检的结果摘要，用来回答「它到底有没有在干活」。 */
export interface AgentRun {
  id: string;
  at: string;
  trigger: TickTrigger;
  queued: number;
  applied: number;
  failed: number;
  /** 因为急停或限流没做的事 */
  skipped: number;
  durationMs: number;
}

export type ActivityKind = "agent" | "human" | "system";

export interface ActivityEntry {
  id: string;
  at: string;
  kind: ActivityKind;
  text: string;
}

export interface DailyMetric {
  /** YYYY-MM-DD */
  date: string;
  views: number;
  inquiries: number;
  orders: number;
  gmvCents: number;
}

export interface ShopSettings {
  shopName: string;
  /** Agent 议价时允许让出的最大折扣（0.15 = 15%） */
  maxDiscount: number;
  /** 承诺发货时效（小时） */
  shipWithinHours: number;
  signature: string;
  /** 关掉之后 Agent 只在你点「运行 Agent」时才动 */
  autoTickEnabled: boolean;
  /** 自动巡检间隔（分钟） */
  autoTickMinutes: number;
}

/** 数据从哪来。 */
export type ReadChannel = "mock" | "live";

/**
 * 写操作往哪去。
 *
 * - `mock`：改本地状态，模拟平台反应。演示和开发用，不碰任何真实账号。
 * - `dry_run`：演练。只记录「本来要干什么」，什么都不改，用来在接真实账号
 *   之前观察 Agent 到底想做哪些事。
 * - `live`：真实写入。通道还没实现，选了也会被拒绝。
 */
export type WriteMode = "mock" | "dry_run" | "live";

export interface ChannelConfig {
  read: ReadChannel;
  write: WriteMode;
  /** 每分钟最多几次写操作（只在非 mock 模式生效） */
  maxWritesPerMinute: number;
  /** 两次写操作之间的最小间隔（毫秒），避免看起来像机器 */
  minWriteIntervalMs: number;
  /** 连续失败多少次就自动急停 */
  autoPauseAfterFailures: number;
}

/** 急停与限流的运行时状态。 */
export interface SafetyState {
  paused: boolean;
  pausedReason?: string;
  pausedAt?: string;
  /** 谁按下的急停：人、连续失败、还是疑似风控 */
  pausedBy?: "human" | "failures" | "risk_control";
  /** 最近的写操作时间戳，用于滑动窗口限流 */
  recentWrites: number[];
  consecutiveFailures: number;
}

/**
 * ─── 选品研究：同行「想要」观察 ────────────────────────────────────────────
 *
 * 闲鱼没有给卖家看别人流量的入口，能拿到的公开代理指标是商品主页上的「想要」。
 * 单次数字没意义，有意义的是同一件商品多次回访之间的差值。
 *
 * 同行商品和本店商品彻底分表：`Listing` 上有底价、库存、擦亮时间，那是
 * 「我能操作的货」；同行只有「我能看到的数」。混在一起，规则引擎会去擦亮别人的商品。
 */

/** 这个数是从哪一层抽出来的。越靠前越稳。 */
export type ExtractionLayer =
  /** 你打开页面时，页面自己已经拉回来的响应 —— 不新开请求，只读已经发生的 */
  | "api"
  /** 页面里内嵌的初始 JSON */
  | "hydration"
  /** 当前页面上可见的文字，如「86人想要」 */
  | "dom";

/** 观察是在哪种页面上做的。搜索卡片和商详不能混算。 */
export type ObservationSource = "detail" | "search";

/** 交付方式只收页面上能看见的，看不出来就是 unknown，不猜。 */
export type DeliveryTerm = "free_shipping" | "buyer_pays" | "local" | "pickup" | "unknown";

export const DELIVERY_LABEL: Record<DeliveryTerm, string> = {
  free_shipping: "包邮",
  buyer_pays: "买家付运费",
  local: "同城",
  pickup: "自提",
  unknown: "未标明",
};

/**
 * 一次观察。
 *
 * `wants` 和 `priceCents` 都是可选的 —— 读不到就是读不到。
 * `0` 和「没读到」是两回事：把没读到记成 0，下一次读到 86 就会显示「涨了 86」。
 */
export interface RivalObservation {
  id: string;
  /** 采集时间，来自快照里的 capturedAt */
  at: string;
  source: ObservationSource;
  /** 「想要」数量，抽不到就留空 */
  wants?: number;
  /** 这个数是哪一层给的，用来判断可信度 */
  wantsFrom?: ExtractionLayer;
  priceCents?: number;
  priceFrom?: ExtractionLayer;
  delivery: DeliveryTerm;
  /** 证据：当时那一页的地址，可以点回去对 */
  pageUrl: string;
  /** DOM 层命中的原文片段，方便人工核对 */
  excerpt?: string;
  /** 这次没抽到的字段，如实记录，不假装同步很完美 */
  missing: string[];
}

/**
 * 规格对齐判定。不靠模型看图，靠标题关键词 + 可见标签。
 *
 * 拿不准就是 `uncertain`，而且只有 `comparable` 会进价格带 ——
 * 拿日版当国行比，比不比更糟。
 */
export type Alignment = "comparable" | "uncertain" | "different";

export const ALIGNMENT_LABEL: Record<Alignment, string> = {
  comparable: "可比",
  uncertain: "存疑",
  different: "不同款",
};

/** 一件同行商品。以平台 itemId 为主键 —— 标题和价格都会改，itemId 不会。 */
export interface RivalListing {
  id: string;
  taskId: string;
  /** 平台 itemId，稳定主键 */
  itemId: string;
  title: string;
  sellerName?: string;
  /** 商详回链 */
  url: string;
  addedAt: string;
  alignment: Alignment;
  /** 对齐判定是自动算的还是你亲自改的。人工的不会被自动判定覆盖。 */
  alignmentBy: "auto" | "human";
  /** 只追加，不覆盖 —— 这一版的全部价值就是历史差值 */
  observations: RivalObservation[];
}

export interface ResearchTask {
  id: string;
  name: string;
  keyword: string;
  /**
   * 统一交付规格，做成可测的关键词而不是一段说明：
   * 命中 `mustExclude` 判为不同款，命中全部 `mustInclude` 判为可比，其余存疑。
   */
  mustInclude: string[];
  mustExclude: string[];
  /** 对标本店哪件货，用来并排看价格带 */
  linkedListingId?: string;
  /** 超过多少小时没观察就进回访清单 */
  revisitHours: number;
  status: "active" | "archived";
  createdAt: string;
}

export interface ResearchState {
  tasks: ResearchTask[];
  rivals: RivalListing[];
  /**
   * 浏览器采集端往本机 API 投快照时用的配对密钥。
   *
   * `localhost` 对任何网页都是可达的，没有密钥的话你随便打开的某个网站
   * 也能往研究里塞脏数据。它不是平台凭证 —— 既不能登录闲鱼，也动不了你的商品。
   */
  collectorToken?: string;
}

/** 一次平台同步拉回来的快照。 */
export interface PlatformSnapshot {
  fetchedAt: string;
  listings: Listing[];
  conversations: Conversation[];
  orders: Order[];
  /**
   * 通道想顺便告诉你的事，会记进动态。
   *
   * 比如平台自己报的分组件数（「在售 0 件 / 已售出 38 件」）—— 有这个数字，
   * 「同步回来怎么全是已售出」就不用靠猜了。
   */
  notes?: string[];
}

export interface AppState {
  settings: ShopSettings;
  channel: ChannelConfig;
  safety: SafetyState;
  listings: Listing[];
  conversations: Conversation[];
  orders: Order[];
  rules: AutomationRule[];
  /** 选品研究：同行商品与观察时间线，和本店 listings 完全分开 */
  research: ResearchState;
  actions: AgentAction[];
  activity: ActivityEntry[];
  metrics: DailyMetric[];
  /** 巡检历史，最近的在前 */
  runs: AgentRun[];
  lastTickAt?: string;
  lastSyncAt?: string;
  seededAt: string;
}
