import type { AppState } from "@/lib/domain/types";
import { yuan } from "@/lib/format";
import type { AdapterResult, XianyuAdapter } from "./types";

const CARRIERS = ["顺丰速运", "中通快递", "圆通速递", "京东物流"];

function fail(message: string): AdapterResult {
  return { ok: false, message };
}

/**
 * 本地模拟通道：所有写操作只改动本地状态，并模拟平台侧的一些副作用
 * （擦亮会带来曝光增长、发货会生成快递单号等）。
 */
export class MockXianyuAdapter implements XianyuAdapter {
  readonly id = "mock";
  readonly label = "本地模拟通道";
  readonly isMock = true;

  refreshListing(state: AppState, listingId: string, now: number): AdapterResult {
    const listing = state.listings.find((l) => l.id === listingId);
    if (!listing) return fail(`擦亮失败：找不到商品 ${listingId}`);
    if (listing.status !== "on_sale") return fail(`擦亮失败：${listing.title} 不在售`);

    listing.lastRefreshedAt = new Date(now).toISOString();
    // 擦亮后短期曝光回升，按当前热度给一个 6%~10% 的提升。
    listing.views7d += Math.max(8, Math.round(listing.views7d * 0.08));
    return { ok: true, message: `已擦亮「${listing.title}」，重新排到搜索前排。` };
  }

  updatePrice(
    state: AppState,
    listingId: string,
    toCents: number,
    now: number,
  ): AdapterResult {
    const listing = state.listings.find((l) => l.id === listingId);
    if (!listing) return fail(`改价失败：找不到商品 ${listingId}`);
    if (toCents < listing.floorPriceCents) {
      return fail(
        `改价失败：${yuan(toCents)} 低于底价 ${yuan(listing.floorPriceCents)}`,
      );
    }
    const from = listing.priceCents;
    listing.priceCents = toCents;
    listing.lastRefreshedAt = new Date(now).toISOString();
    return {
      ok: true,
      message: `「${listing.title}」价格 ${yuan(from)} → ${yuan(toCents)}。`,
    };
  }

  delistListing(state: AppState, listingId: string, now: number): AdapterResult {
    const listing = state.listings.find((l) => l.id === listingId);
    if (!listing) return fail(`下架失败：找不到商品 ${listingId}`);
    listing.status = "delisted";
    listing.lastRefreshedAt = new Date(now).toISOString();
    return { ok: true, message: `已下架「${listing.title}」。` };
  }

  sendMessage(
    state: AppState,
    conversationId: string,
    text: string,
    now: number,
  ): AdapterResult {
    const conversation = state.conversations.find((c) => c.id === conversationId);
    if (!conversation) return fail(`发送失败：找不到会话 ${conversationId}`);
    if (!text.trim()) return fail("发送失败：回复内容为空");

    conversation.messages.push({
      id: `${conversationId}-M${conversation.messages.length + 1}`,
      author: "seller",
      text: text.trim(),
      createdAt: new Date(now).toISOString(),
      viaAgent: true,
    });
    conversation.status = "awaiting_buyer";
    return { ok: true, message: `已回复「${conversation.buyerName}」。` };
  }

  shipOrder(
    state: AppState,
    orderId: string,
    carrier: string,
    trackingNo: string,
    now: number,
  ): AdapterResult {
    const order = state.orders.find((o) => o.id === orderId);
    if (!order) return fail(`发货失败：找不到订单 ${orderId}`);
    if (order.status !== "pending_shipment") {
      return fail(`发货失败：订单 ${orderId} 当前不是待发货状态`);
    }
    order.status = "shipped";
    order.carrier = carrier;
    order.trackingNo = trackingNo;
    order.shippedAt = new Date(now).toISOString();

    const listing = state.listings.find((l) => l.id === order.listingId);
    if (listing && listing.stock > 0) {
      listing.stock -= 1;
      if (listing.stock === 0) listing.status = "sold_out";
    }
    return { ok: true, message: `订单 ${orderId} 已发货：${carrier} ${trackingNo}。` };
  }
}

/** 模拟运单号，真实通道下应由快递接口返回。 */
export function mockTrackingNumber(orderId: string, now: number): string {
  const seed = [...orderId].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const digits = String((seed * 7919 + (now % 100000)) % 1_000_000_000).padStart(
    9,
    "0",
  );
  return `SF${digits}${String(seed % 100).padStart(2, "0")}`;
}

export function suggestCarrier(orderId: string): string {
  const seed = [...orderId].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return CARRIERS[seed % CARRIERS.length];
}

export const mockAdapter = new MockXianyuAdapter();
