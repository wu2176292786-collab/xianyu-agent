import type { AppState } from "@/lib/domain/types";
import { yuan } from "@/lib/format";
import type { AdapterResult, XianyuAdapter } from "../types";
import { sendImText } from "./im";

const NOT_WIRED =
  "还没接到真实接口。对照 XianYuApis，目前只能真实发出私信；擦亮、改价、下架、发货不会拿猜的接口名去改你的商品。";

function fail(message: string, riskControl = false): AdapterResult {
  return { ok: false, message, riskControl };
}

/**
 * 真实写通道。
 *
 * 回复走闲鱼网页 IM（令牌 + WebSocket）。其余写操作明确拒绝，
 * 避免拿一个没验证过的 MTOP 名字去改价或下架。
 */
export class LiveXianyuAdapter implements XianyuAdapter {
  readonly id = "live";
  readonly label = "真实闲鱼账号";
  readonly isMock = false;

  constructor(
    private readonly send: typeof sendImText = sendImText,
  ) {}

  refreshListing(_state: AppState, _listingId: string, _now: number): AdapterResult {
    return fail(`擦亮${NOT_WIRED}`);
  }

  updatePrice(
    state: AppState,
    listingId: string,
    toCents: number,
    _now: number,
  ): AdapterResult {
    const listing = state.listings.find((item) => item.id === listingId);
    if (listing && toCents < listing.floorPriceCents) {
      return fail(`改价失败：${yuan(toCents)} 低于底价 ${yuan(listing.floorPriceCents)}`);
    }
    return fail(`改价${NOT_WIRED}`);
  }

  delistListing(_state: AppState, _listingId: string, _now: number): AdapterResult {
    return fail(`下架${NOT_WIRED}`);
  }

  async sendMessage(
    state: AppState,
    conversationId: string,
    text: string,
    now: number,
  ): Promise<AdapterResult> {
    const conversation = state.conversations.find((item) => item.id === conversationId);
    if (!conversation) return fail(`发送失败：找不到会话 ${conversationId}`);
    if (!text.trim()) return fail("发送失败：回复内容为空");
    if (!conversation.buyerId) {
      return fail("发送失败：会话里还没有对方的闲鱼 id，先同步一次消息。");
    }

    const result = await this.send({
      cid: conversation.id,
      toid: conversation.buyerId,
      text,
      now,
    });
    if (!result.ok) return fail(result.message, result.riskControl);

    conversation.messages.push({
      id: `${conversationId}-M${conversation.messages.length + 1}`,
      author: "seller",
      text: text.trim(),
      createdAt: new Date(now).toISOString(),
      viaAgent: true,
    });
    conversation.status = "awaiting_buyer";
    return { ok: true, message: `已回复「${conversation.buyerName}」（已发到闲鱼）。` };
  }

  shipOrder(_state: AppState, _orderId: string, _carrier: string, _trackingNo: string, _now: number): AdapterResult {
    return fail(`发货${NOT_WIRED}`);
  }
}

export const liveXianyuAdapter = new LiveXianyuAdapter();
