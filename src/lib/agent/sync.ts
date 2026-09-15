import type { AppState, Listing, PlatformSnapshot } from "@/lib/domain/types";

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

  // 平台上已经没有、但本地还留着的商品保留下来，避免一次抓取失败就丢数据
  const remoteIds = new Set(snapshot.listings.map((l) => l.id));
  for (const local of state.listings) {
    if (!remoteIds.has(local.id)) mergedListings.push(local);
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

    const known = new Set(local.messages.map((m) => m.id));
    const incoming = remote.messages.filter((m) => !known.has(m.id));
    if (incoming.length > 0) {
      local.messages.push(...incoming);
      local.messages.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      summary.newMessages += incoming.length;
      // 买家又说话了，会话重新变成待回复
      if (local.messages.at(-1)?.author === "buyer" && local.status !== "closed") {
        local.status = "needs_reply";
      }
    }
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
