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

/** 一次平台同步拉回来的快照。 */
export interface PlatformSnapshot {
  fetchedAt: string;
  listings: Listing[];
  conversations: Conversation[];
  orders: Order[];
}

export interface AppState {
  settings: ShopSettings;
  channel: ChannelConfig;
  safety: SafetyState;
  listings: Listing[];
  conversations: Conversation[];
  orders: Order[];
  rules: AutomationRule[];
  actions: AgentAction[];
  activity: ActivityEntry[];
  metrics: DailyMetric[];
  /** 巡检历史，最近的在前 */
  runs: AgentRun[];
  lastTickAt?: string;
  lastSyncAt?: string;
  seededAt: string;
}
