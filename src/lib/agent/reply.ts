import type {
  Conversation,
  Intent,
  Listing,
  Order,
  ShopSettings,
} from "@/lib/domain/types";
import { yuan } from "@/lib/format";

const KEYWORDS: Array<{ intent: Intent; words: string[] }> = [
  {
    intent: "after_sale",
    words: [
      "退货",
      "退款",
      "坏了",
      "假货",
      "投诉",
      "售后",
      "维修",
      "不能用",
      "开不了机",
      "有问题",
      "货不对板",
    ],
  },
  {
    intent: "shipping_chase",
    words: [
      "发货",
      "什么时候发",
      "还没发",
      "单号",
      "物流",
      "快递到哪",
      "到哪了",
      "签收",
    ],
  },
  {
    intent: "bargain",
    words: [
      "便宜",
      "少点",
      "少些",
      "最低",
      "优惠",
      "让点",
      "抹零",
      "出不出",
      "包邮",
      "刀",
      "价格能",
      "能少",
    ],
  },
  {
    intent: "spec_question",
    words: [
      "尺寸",
      "成色",
      "划痕",
      "参数",
      "电池",
      "保修",
      "正品",
      "国行",
      "港版",
      "日版",
      "版本",
      "型号",
      "配件",
      "多大",
      "多重",
      "支持",
      "几年",
      "漂移",
      "中文",
      "蓝牙",
      "有线",
      "双模",
      "容量",
      "续航",
    ],
  },
  {
    intent: "availability",
    words: ["在吗", "在不在", "还有吗", "还在吗", "现货", "有货", "出了吗", "自提"],
  },
];

/** 从买家消息里抽取出价，只接受与商品价格量级相符的数字。 */
export function extractOfferCents(
  text: string,
  listingPriceCents: number,
): number | null {
  if (listingPriceCents <= 0) return null;
  const candidates: number[] = [];
  const pattern = /(\d+(?:\.\d{1,2})?)\s*(万|k|K|千|元|块)?/g;

  for (const match of text.matchAll(pattern)) {
    const base = Number(match[1]);
    if (!Number.isFinite(base)) continue;
    const unit = match[2];
    let value = base;
    if (unit === "万") value = base * 10_000;
    else if (unit === "k" || unit === "K" || unit === "千") value = base * 1_000;
    candidates.push(Math.round(value * 100));
  }

  const plausible = candidates.filter(
    (cents) => cents >= listingPriceCents * 0.3 && cents <= listingPriceCents * 1.05,
  );
  if (plausible.length === 0) return null;
  // 买家通常报的是他希望的价格，取最低的那个合理数字。
  return Math.min(...plausible);
}

export function classifyIntent(text: string, listing?: Listing): Intent {
  const offer = listing ? extractOfferCents(text, listing.priceCents) : null;
  for (const group of KEYWORDS) {
    if (group.words.some((word) => text.includes(word))) {
      // 带着具体报价的消息，本质上都是议价。
      if (offer !== null && (group.intent === "spec_question" || group.intent === "availability")) {
        return "bargain";
      }
      return group.intent;
    }
  }
  if (offer !== null) return "bargain";
  return "other";
}

export const INTENT_LABEL: Record<Intent, string> = {
  bargain: "议价",
  spec_question: "咨询细节",
  shipping_chase: "催发货",
  availability: "问库存",
  after_sale: "售后",
  other: "其他",
};

export interface ReplyDraft {
  text: string;
  intent: Intent;
  /** 0~1，越低越应该人工看一眼 */
  confidence: number;
  needsHumanEdit: boolean;
  counterOfferCents?: number;
}

export function lastBuyerMessage(conversation: Conversation) {
  for (let i = conversation.messages.length - 1; i >= 0; i -= 1) {
    if (conversation.messages[i].author === "buyer") return conversation.messages[i];
  }
  return undefined;
}

/** 买家未回复的消息才需要起草回复。 */
export function awaitingSellerReply(conversation: Conversation): boolean {
  if (conversation.status === "closed") return false;
  const last = conversation.messages.at(-1);
  return last?.author === "buyer";
}

/** 超过这个时间的「最后一条是买家」不再当成待回复 —— 那是旧账，不是最新消息。 */
export const FRESH_REPLY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** 只给最近还在聊的会话补历史，避免把同步名额花在几年前的对话上。 */
export const RECENT_CHAT_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;

export function lastActivityAt(conversation: Conversation): number {
  const last = conversation.messages.at(-1);
  const at = last ? Date.parse(last.createdAt) : Number.NaN;
  return Number.isFinite(at) ? at : 0;
}

/** 最近两周内、最后一条还是买家说的，才钉在收件箱前面。 */
export function isFreshWait(conversation: Conversation, now: number): boolean {
  return awaitingSellerReply(conversation) && now - lastActivityAt(conversation) <= FRESH_REPLY_WINDOW_MS;
}

/** Agent 愿意给出的最低报价：底价与「最大折扣价」取高者。 */
export function lowestQuoteCents(listing: Listing, maxDiscount: number): number {
  const discounted = Math.round((listing.priceCents * (1 - maxDiscount)) / 100) * 100;
  return Math.max(listing.floorPriceCents, discounted);
}

export interface DraftInput {
  conversation: Conversation;
  listing?: Listing;
  settings: ShopSettings;
  /** 与该会话相关的最新订单，用于回答催发货 */
  order?: Order;
}

/**
 * 基于意图的确定性回复起草。没有任何模型依赖，离线也能跑；
 * 配置了 LLM 时会在此基础上做润色（见 `llm.ts`）。
 */
export function draftReply({
  conversation,
  listing,
  settings,
  order,
}: DraftInput): ReplyDraft {
  const buyerMessage = lastBuyerMessage(conversation);
  const text = buyerMessage?.text ?? "";
  const intent = classifyIntent(text, listing);
  const name = conversation.buyerName;
  const sign = settings.signature ? `\n${settings.signature}` : "";

  if (intent === "bargain" && listing) {
    const offer =
      conversation.offerCents ?? extractOfferCents(text, listing.priceCents);
    const lowest = lowestQuoteCents(listing, settings.maxDiscount);

    if (offer !== null && offer >= lowest) {
      return {
        text:
          `${name}你好，${yuan(offer)} 可以的，我这就把价格改好。\n` +
          `拍下后 ${settings.shipWithinHours} 小时内发出，走平台交易更有保障。${sign}`,
        intent,
        confidence: 0.82,
        needsHumanEdit: false,
        counterOfferCents: offer,
      };
    }

    const offerLine =
      offer !== null
        ? `${yuan(offer)} 确实做不了，这个成色我收上来也不便宜。`
        : `这个价格已经比较实在了。`;
    return {
      text:
        `${name}你好，${offerLine}\n` +
        `「${listing.title}」最低 ${yuan(lowest)}，诚心要的话我改价给你，` +
        `${settings.shipWithinHours} 小时内发出。${sign}`,
      intent,
      confidence: offer !== null ? 0.74 : 0.62,
      needsHumanEdit: false,
      counterOfferCents: lowest,
    };
  }

  if (intent === "shipping_chase") {
    const orderLine = order
      ? order.status === "shipped" && order.trackingNo
        ? `订单 ${order.id} 已经寄出了，${order.carrier} ${order.trackingNo}，物流更新有延迟，麻烦稍等下。`
        : `订单 ${order.id} 已经在打包了，今天之内一定发出，发出后第一时间把单号发你。`
      : `已经在打包了，今天之内发出，发出后第一时间把单号发你。`;
    return {
      text: `${name}你好，抱歉让你久等。\n${orderLine}${sign}`,
      intent,
      confidence: 0.86,
      needsHumanEdit: false,
    };
  }

  if (intent === "availability") {
    const stockLine = !listing
      ? "还在的，你想了解哪方面？"
      : listing.stock > 0 && listing.status === "on_sale"
        ? `在的，「${listing.title}」还有 ${listing.stock} 件现货。`
        : `不好意思，「${listing.title}」已经出掉了，这两天会补类似的，可以先关注下。`;
    const tagLine = listing?.tags.length ? `（${listing.tags.join(" · ")}）` : "";
    return {
      text: `${name}你好，${stockLine}${tagLine}${sign}`,
      intent,
      confidence: 0.88,
      needsHumanEdit: false,
    };
  }

  if (intent === "spec_question") {
    const detail = listing
      ? `「${listing.title}」的情况就是标题和详情里写的，${
          listing.tags.length ? listing.tags.join("、") + "。" : ""
        }`
      : "";
    return {
      text:
        `${name}你好，${detail}\n` +
        `你关心的细节我可以现拍视频或者细节图发你，具体想看哪里？${sign}`,
      intent,
      confidence: 0.48,
      needsHumanEdit: true,
    };
  }

  if (intent === "after_sale") {
    return {
      text:
        `${name}你好，实在抱歉给你添麻烦了。\n` +
        `麻烦拍个照片或者小视频发我看一下具体情况，确认后我们走平台售后，该退该补我都认，不会让你吃亏。${sign}`,
      intent,
      confidence: 0.35,
      needsHumanEdit: true,
    };
  }

  return {
    text: `${name}你好，消息收到了。${listing ? `「${listing.title}」还在的，` : ""}你具体想了解什么？${sign}`,
    intent,
    confidence: 0.4,
    needsHumanEdit: true,
  };
}
