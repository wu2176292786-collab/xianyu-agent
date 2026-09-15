import type { AppState, Order, PlatformSnapshot } from "@/lib/domain/types";
import { mulberry32 } from "@/lib/random";
import type { XianyuReader } from "./types";

const BUYER_POOL = [
  { name: "夜跑的猫", emoji: "🐈", text: "老板在吗，这个还能便宜点不" },
  { name: "打工人小周", emoji: "🧋", text: "成色有图吗？想看看边角" },
  { name: "收纳控", emoji: "📦", text: "能今天发吗，急着用" },
  { name: "阿福", emoji: "🍜", text: "还有货吗？同城可以自提吗" },
];

/**
 * 模拟读通道。
 *
 * 它不是简单地把本地数据原样还回来 —— 那样同步就永远是空操作，合并逻辑也
 * 没机会被验证。这里会造出一点平台侧本来就会有的变化：曝光在涨、偶尔来一条
 * 新消息、偶尔多一笔订单。真实通道要做的事情形状完全一样，只是数据来源换成
 * 网络请求。
 */
export class MockXianyuReader implements XianyuReader {
  readonly id = "mock";
  readonly label = "本地模拟数据";
  readonly isMock = true;

  async fetchSnapshot(state: AppState, now: number): Promise<PlatformSnapshot> {
    const rand = mulberry32(Math.floor(now / 1000));

    const listings = state.listings.map((listing) => {
      if (listing.status !== "on_sale") return { ...listing };
      return {
        ...listing,
        views7d: listing.views7d + Math.floor(rand() * 40),
        wants: listing.wants + (rand() > 0.75 ? 1 : 0),
      };
    });

    const conversations = state.conversations.map((c) => ({
      ...c,
      messages: [...c.messages],
    }));

    // 大约每三次同步会冒出一个新买家
    if (rand() > 0.66 && listings.length > 0) {
      const buyer = BUYER_POOL[Math.floor(rand() * BUYER_POOL.length)];
      const onSale = listings.filter((l) => l.status === "on_sale");
      const listing = onSale[Math.floor(rand() * onSale.length)] ?? listings[0];
      const id = `C-remote-${Math.floor(now / 1000).toString(36)}`;

      if (!conversations.some((c) => c.id === id)) {
        conversations.push({
          id,
          buyerName: buyer.name,
          buyerEmoji: buyer.emoji,
          listingId: listing.id,
          status: "needs_reply",
          intent: "other",
          messages: [
            {
              id: `${id}-M1`,
              author: "buyer",
              text: buyer.text,
              createdAt: new Date(now).toISOString(),
            },
          ],
        });
      }
    }

    const orders: Order[] = state.orders.map((o) => ({ ...o }));

    // 大约每五次同步会多一笔订单
    if (rand() > 0.8) {
      const sellable = listings.filter((l) => l.status === "on_sale" && l.stock > 0);
      const listing = sellable[Math.floor(rand() * sellable.length)];
      const id = `O-remote-${Math.floor(now / 1000).toString(36)}`;
      if (listing && !orders.some((o) => o.id === id)) {
        orders.push({
          id,
          listingId: listing.id,
          buyerName: BUYER_POOL[Math.floor(rand() * BUYER_POOL.length)].name,
          amountCents: listing.priceCents,
          status: "pending_shipment",
          createdAt: new Date(now).toISOString(),
          paidAt: new Date(now).toISOString(),
        });
      }
    }

    return {
      fetchedAt: new Date(now).toISOString(),
      listings,
      conversations,
      orders,
    };
  }
}

export const mockReader = new MockXianyuReader();

/** 真实读通道的占位实现，接上之前明确地失败，而不是悄悄返回空数据。 */
export class NotImplementedReader implements XianyuReader {
  readonly id = "live";
  readonly label = "真实闲鱼账号（未接入）";
  readonly isMock = false;

  async fetchSnapshot(): Promise<PlatformSnapshot> {
    throw new Error(
      "真实读通道还没实现。需要先完成扫码登录与登录态管理，再实现 XianyuReader。",
    );
  }
}

export const liveReader = new NotImplementedReader();
