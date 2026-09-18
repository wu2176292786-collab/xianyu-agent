import { FRESH_REPLY_WINDOW_MS, lastActivityAt } from "@/lib/agent/reply";
import { DEMO_SHOP_NAME } from "@/lib/domain/seed";
import type { AppState, DailyMetric, Listing, PlatformSnapshot } from "@/lib/domain/types";
import { shopDay } from "@/lib/format";

/** 在售商品里已经同步到的浏览 / 想要。没拿到热度的不计入，避免把占位 0 当成没人看。 */
export function shopHeatFromListings(listings: Listing[]) {
  const known = listings.filter((listing) => listing.status === "on_sale" && !listing.metricsUnknown);
  return {
    known: known.length,
    views: known.reduce((sum, listing) => sum + listing.views7d, 0),
    wants: known.reduce((sum, listing) => sum + listing.wants, 0),
    inquiries: known.reduce((sum, listing) => sum + listing.inquiries7d, 0),
  };
}

/** 真实同步后记下今天的店铺曝光快照，总览才有数可加。 */
export function recordShopHeat(state: AppState, now: number): DailyMetric | undefined {
  const heat = shopHeatFromListings(state.listings);
  if (heat.known === 0) return undefined;
  const date = shopDay(now);
  const existing = state.metrics.find((row) => row.date === date);
  const next: DailyMetric = {
    date,
    views: heat.views,
    inquiries: heat.inquiries,
    orders: existing?.orders ?? 0,
    gmvCents: existing?.gmvCents ?? 0,
  };
  if (existing) Object.assign(existing, next);
  else state.metrics.push(next);
  state.metrics.sort((a, b) => a.date.localeCompare(b.date));
  return next;
}

/** 换号时清掉只属于上一账号的店内数据。规则、研究和通道设置留着。 */
export function resetAccountBoundData(state: AppState): void {
  state.listings = [];
  state.conversations = [];
  state.orders = [];
  state.actions = [];
  state.metrics = [];
}

/**
 * 记下当前闲鱼账号。换了人就清空上一号的商品 / 会话 / 订单。
 * 返回是不是刚换过号。
 */
export function adoptAccount(
  state: AppState,
  accountUserId: string,
  shopName?: string,
): boolean {
  const incoming = accountUserId.trim();
  if (!incoming || incoming === state.settings.accountUserId) return false;

  resetAccountBoundData(state);
  state.settings.accountUserId = incoming;
  if (shopName?.trim()) state.settings.shopName = shopName.trim();
  return true;
}

export interface MergeSummary {
  newListings: number;
  updatedListings: number;
  newConversations: number;
  newMessages: number;
  newOrders: number;
  updatedOrders: number;
  /** 同步进来、但底价还没人确认过的商品数 */
  needsFloorPrice: number;
}

/** 新商品先给一个保守的底价占位，并标成「未确认」。 */
function provisionalFloor(priceCents: number): number {
  return Math.round((priceCents * 0.9) / 100) * 100;
}

/**
 * 把平台快照合进本地状态。
 *
 * 分工是明确的：平台说了算的字段（价格、库存、状态、曝光、想要、擦亮时间）
 * 直接覆盖；只存在本地的字段（底价、成本、底价是否确认过）原样保留 ——
 * 这些是你自己的生意数据，平台上根本没有。
 *
 * 新同步进来的商品底价是按挂牌价估的，所以 `floorConfirmed` 为 false，
 * 自动降价规则会绕开它们，直到你亲自确认。
 */
export function mergeSnapshot(
  state: AppState,
  snapshot: PlatformSnapshot,
  now: number,
): MergeSummary {
  const summary: MergeSummary = {
    newListings: 0,
    updatedListings: 0,
    newConversations: 0,
    newMessages: 0,
    newOrders: 0,
    updatedOrders: 0,
    needsFloorPrice: 0,
  };

  const switched = snapshot.accountUserId
    ? adoptAccount(state, snapshot.accountUserId, snapshot.shopName)
    : false;

  const localListings = new Map(state.listings.map((l) => [l.id, l] as const));
  const mergedListings: Listing[] = snapshot.listings.map((remote) => {
    const local = localListings.get(remote.id);
    if (!local) {
      summary.newListings += 1;
      return {
        ...remote,
        floorPriceCents: provisionalFloor(remote.priceCents),
        floorConfirmed: false,
      };
    }

    const changed =
      local.priceCents !== remote.priceCents ||
      local.stock !== remote.stock ||
      local.status !== remote.status ||
      local.views7d !== remote.views7d ||
      local.wants !== remote.wants;
    if (changed) summary.updatedListings += 1;

    return {
      ...remote,
      // 只存在本地的生意数据，平台不知道，也不该被覆盖
      floorPriceCents: local.floorPriceCents,
      floorConfirmed: local.floorConfirmed,
      costCents: local.costCents,
      copy: remote.copy ?? local.copy,
      // 这次没拿到热度数据时，保留上一次拿到的，别用占位的 0 把它冲掉
      ...(remote.metricsUnknown
        ? {
            views7d: local.views7d,
            wants: local.wants,
            inquiries7d: local.inquiries7d,
            metricsUnknown: local.metricsUnknown,
          }
        : {}),
    };
  });

  // 同一账号：平台上暂时没返回的商品留着，避免一次抓取失败就丢数据。
  // 换号：只收新账号的，绝不把上一号的货拼进来。
  if (!switched) {
    const remoteIds = new Set(snapshot.listings.map((l) => l.id));
    for (const local of state.listings) {
      if (!remoteIds.has(local.id)) mergedListings.push(local);
    }
  }
  state.listings = mergedListings;
  summary.needsFloorPrice = state.listings.filter(
    (l) => !l.floorConfirmed && l.status === "on_sale",
  ).length;

  for (const remote of snapshot.conversations) {
    const local = state.conversations.find((c) => c.id === remote.id);
    if (!local) {
      state.conversations.push({ ...remote, messages: [...remote.messages] });
      summary.newConversations += 1;
      summary.newMessages += remote.messages.length;
      continue;
    }

    if (remote.listingId) local.listingId = remote.listingId;
    if (remote.listingTitle) local.listingTitle = remote.listingTitle;
    if (remote.listingPriceCents !== undefined) local.listingPriceCents = remote.listingPriceCents;
    if (remote.buyerName && remote.buyerName !== "买家") local.buyerName = remote.buyerName;
    if (remote.buyerId) local.buyerId = remote.buyerId;

    // 会话列表那条 `${id}-last` 只是摘要。历史消息进来之后要丢掉，
    // 否则同一句话会以两个 id 出现两次。
    const remoteHasHistory = remote.messages.some((message) => !message.id.endsWith("-last"));
    if (remoteHasHistory) {
      local.messages = local.messages.filter((message) => !message.id.endsWith("-last"));
    }

    const known = new Set(local.messages.map((m) => m.id));
    const incoming = remote.messages.filter(
      (m) => !known.has(m.id) && !(remoteHasHistory && m.id.endsWith("-last")),
    );
    if (incoming.length > 0) {
      local.messages.push(...incoming);
      local.messages.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      summary.newMessages += incoming.length;
    }

    // 会话列表带的是「当前最后一条」。id 固定是 `${会话}-last`，
    // 最新一条变了时 id 不变，只换文本和时间，必须覆盖。
    // 历史页没翻到最新一条时，也要把这条更新的摘要合进来。
    const remoteLast = remote.messages.at(-1);
    const localLast = local.messages.at(-1);
    if (remoteLast && localLast) {
      const sameId = local.messages.findIndex((message) => message.id === remoteLast.id);
      if (sameId >= 0) {
        const existing = local.messages[sameId]!;
        if (existing.text !== remoteLast.text || existing.createdAt !== remoteLast.createdAt) {
          local.messages[sameId] = { ...remoteLast };
          local.messages.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
          summary.newMessages += 1;
        }
      } else if (Date.parse(remoteLast.createdAt) > Date.parse(localLast.createdAt)) {
        if (localLast.id.endsWith("-last")) {
          local.messages[local.messages.length - 1] = { ...remoteLast };
        } else {
          local.messages.push({ ...remoteLast });
        }
        local.messages.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
        summary.newMessages += 1;
      }
    }

    if (local.status !== "closed") {
      const last = local.messages.at(-1);
      local.status =
        last?.author === "buyer" && now - lastActivityAt(local) <= FRESH_REPLY_WINDOW_MS
          ? "needs_reply"
          : "awaiting_buyer";
    }
  }

  // IM 收件箱是当前真人会话。只剩 `${id}-last` 摘要的旧会话丢掉，
  // 免得消息页一直显示自己账号的最后一句。
  const remoteHasHistory = snapshot.conversations.some((conversation) =>
    conversation.messages.some((message) => !message.id.endsWith("-last")),
  );
  if (remoteHasHistory) {
    const keep = new Set(snapshot.conversations.map((conversation) => conversation.id));
    state.conversations = state.conversations.filter((conversation) => {
      if (keep.has(conversation.id)) return true;
      return conversation.messages.some((message) => !message.id.endsWith("-last"));
    });
  }

  for (const remote of snapshot.orders) {
    const local = state.orders.find((o) => o.id === remote.id);
    if (!local) {
      state.orders.push({ ...remote });
      summary.newOrders += 1;
      continue;
    }
    if (local.status !== remote.status) summary.updatedOrders += 1;
    Object.assign(local, remote);
  }

  /**
   * 店铺名只在它还是示例数据那个名字时才跟着平台改。
   *
   * 一律覆盖的话，你自己改过的名字会在下一次同步时被平台的显示名冲掉；
   * 一律不覆盖的话，接上真实账号后侧栏还挂着「老陈的数码小铺」，容易
   * 让人以为同步错了账号。
   */
  if (
    snapshot.shopName?.trim() &&
    (switched || state.settings.shopName === DEMO_SHOP_NAME)
  ) {
    state.settings.shopName = snapshot.shopName.trim();
  }

  if (state.channel.read === "live") {
    recordShopHeat(state, now);
  }

  state.lastSyncAt = new Date(now).toISOString();
  return summary;
}

export function describeMerge(summary: MergeSummary): string {
  const parts: string[] = [];
  if (summary.newListings > 0) parts.push(`新增 ${summary.newListings} 件商品`);
  if (summary.updatedListings > 0) parts.push(`更新 ${summary.updatedListings} 件商品`);
  if (summary.newConversations > 0) parts.push(`新增 ${summary.newConversations} 个会话`);
  if (summary.newMessages > 0) parts.push(`${summary.newMessages} 条新消息`);
  if (summary.newOrders > 0) parts.push(`${summary.newOrders} 笔新订单`);
  if (summary.updatedOrders > 0) parts.push(`${summary.updatedOrders} 笔订单状态变化`);
  return parts.length > 0 ? parts.join("，") : "没有变化";
}
