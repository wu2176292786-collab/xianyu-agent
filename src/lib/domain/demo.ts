import type { ActionPayload, AppState } from "./types";
import { createSeedState } from "./seed";

/**
 * 清掉示例数据，留下真实同步来的部分。
 *
 * 为什么需要这个：同步只增不删（一次抓取失败不该把本地数据清空），所以真实
 * 商品进来之后，示例店铺还躺在里面 —— 38 件真商品和 11 件「老陈的数码小铺」
 * 混在一张表里，看不出哪个是哪个。而「重置示例数据」是反过来的：它把真实
 * 数据也一起冲掉。
 *
 * 怎么认出示例数据：**不靠 id 长得像不像**，而是现场生成一份种子状态，
 * 拿它的 id 集合去比。种子里的 id 是写死的（`L001`、`C001`、`RT001`…），
 * 所以这个判断是精确的，不是猜的 —— 真实 itemId 永远不会撞上 `L001`。
 */
export interface ClearDemoSummary {
  listings: number;
  conversations: number;
  orders: number;
  actions: number;
  activity: number;
  metrics: number;
  researchTasks: number;
  rivals: number;
}

/** 动作指向的那个对象。用来判断这条动作是不是冲着示例数据去的。 */
function targetId(payload: ActionPayload): string {
  switch (payload.type) {
    case "refresh_listing":
    case "delist_listing":
    case "adjust_price":
      return payload.listingId;
    case "send_reply":
      return payload.conversationId;
    case "ship_order":
      return payload.orderId;
  }
}

export function clearDemoData(state: AppState, platformNick?: string): ClearDemoSummary {
  // 时间不影响 id，种子里的 id 都是写死的
  const seed = createSeedState(0);
  const listingIds = new Set(seed.listings.map((l) => l.id));
  const conversationIds = new Set(seed.conversations.map((c) => c.id));
  const orderIds = new Set(seed.orders.map((o) => o.id));
  const activityIds = new Set(seed.activity.map((a) => a.id));
  const taskIds = new Set(seed.research.tasks.map((t) => t.id));
  const demoTargets = new Set([...listingIds, ...conversationIds, ...orderIds]);

  const before = {
    listings: state.listings.length,
    conversations: state.conversations.length,
    orders: state.orders.length,
    actions: state.actions.length,
    activity: state.activity.length,
    metrics: state.metrics.length,
    researchTasks: state.research.tasks.length,
    rivals: state.research.rivals.length,
  };

  state.listings = state.listings.filter((l) => !listingIds.has(l.id));
  state.conversations = state.conversations.filter((c) => !conversationIds.has(c.id));
  state.orders = state.orders.filter((o) => !orderIds.has(o.id));
  // 指向示例对象的建议一起清掉 —— 留着会指向一个已经不存在的商品
  state.actions = state.actions.filter((a) => !demoTargets.has(targetId(a.payload)));
  state.activity = state.activity.filter((a) => !activityIds.has(a.id));
  // 流量趋势整个是示例数据：平台不给这类数字，所以真实的一条都没有
  state.metrics = [];

  state.research.tasks = state.research.tasks.filter((t) => !taskIds.has(t.id));
  // 示例任务下的同行商品跟着走，否则会变成挂在不存在任务上的孤儿
  state.research.rivals = state.research.rivals.filter((r) => !taskIds.has(r.taskId));

  // 店铺名换成平台上的真名。示例数据清掉之后，「老陈的数码小铺」就更没有
  // 理由留在界面上了。
  if (platformNick?.trim()) state.settings.shopName = platformNick.trim();

  return {
    listings: before.listings - state.listings.length,
    conversations: before.conversations - state.conversations.length,
    orders: before.orders - state.orders.length,
    actions: before.actions - state.actions.length,
    activity: before.activity - state.activity.length,
    metrics: before.metrics - state.metrics.length,
    researchTasks: before.researchTasks - state.research.tasks.length,
    rivals: before.rivals - state.research.rivals.length,
  };
}

export function describeClearDemo(summary: ClearDemoSummary): string {
  const parts: string[] = [];
  if (summary.listings > 0) parts.push(`${summary.listings} 件商品`);
  if (summary.conversations > 0) parts.push(`${summary.conversations} 个会话`);
  if (summary.orders > 0) parts.push(`${summary.orders} 笔订单`);
  if (summary.actions > 0) parts.push(`${summary.actions} 条建议`);
  if (summary.metrics > 0) parts.push(`${summary.metrics} 天流量数据`);
  if (summary.researchTasks > 0) {
    parts.push(`${summary.researchTasks} 个研究任务（含 ${summary.rivals} 件同行商品）`);
  }
  return parts.length > 0 ? `已清除示例数据：${parts.join("、")}` : "没有示例数据需要清除";
}
