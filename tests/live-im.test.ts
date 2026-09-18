import { describe, expect, it } from "vitest";
import { encode as encodeMsgpack } from "@msgpack/msgpack";
import {
  IM_APP_KEY,
  buildListUserMessagesFrame,
  buildTextSendFrame,
  decodeImPushData,
  encodeTextContent,
  extractImPushPayloads,
  extractImSessionHint,
  generateDeviceId,
  generateImMid,
  imConversationId,
  imTokenPayload,
  isBuyerImSession,
  readAccessToken,
} from "@/lib/adapters/live/im";
import { LiveXianyuAdapter } from "@/lib/adapters/live/writer";
import { writeChannelFor } from "@/lib/adapters";
import { createSeedState } from "@/lib/domain/seed";

const NOW = Date.parse("2026-01-10T12:00:00.000Z");

describe("闲鱼 IM 报文", () => {
  it("deviceId 是 UUID 形态再拼上用户 id", () => {
    const deviceId = generateDeviceId("3888777108");
    expect(deviceId).toMatch(
      /^[0-9A-Za-z]{8}-[0-9A-Za-z]{4}-4[0-9A-Za-z]{3}-[89ABab][0-9A-Za-z]{3}-[0-9A-Za-z]{12}-3888777108$/,
    );
  });

  it("令牌 payload 带 IM appKey 和 deviceId", () => {
    expect(imTokenPayload("device-1")).toEqual({
      appKey: IM_APP_KEY,
      deviceId: "device-1",
    });
  });

  it("文本内容按网页 IM 的 contentType 1 做 base64", () => {
    const encoded = encodeTextContent("还在的");
    expect(JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))).toEqual({
      contentType: 1,
      text: { text: "还在的" },
    });
  });

  it("发送帧走 sendByReceiverScope，cid / toid 带 @goofish", () => {
    const mid = generateImMid();
    const { body } = buildTextSendFrame({
      cid: "47812870000",
      toid: "3149637063",
      selfId: "1111",
      text: "在的",
      mid,
      uuid: "-1",
    });
    expect(body.lwp).toBe("/r/MessageSend/sendByReceiverScope");
    expect(body.headers).toMatchObject({ mid });
    const [message, receivers] = body.body as [Record<string, unknown>, Record<string, unknown>];
    expect(message.cid).toBe("47812870000@goofish");
    expect(receivers.actualReceivers).toEqual(["3149637063@goofish", "1111@goofish"]);
    expect((message.content as { custom: { type: number } }).custom.type).toBe(1);
  });

  it("拉历史走 listUserMessages，cid 带 @goofish，从最新往旧翻", () => {
    const mid = generateImMid();
    const { body } = buildListUserMessagesFrame({
      cid: "65289538993",
      cursor: 9_007_199_254_740_991,
      limit: 40,
      mid,
    });
    expect(body.lwp).toBe("/r/MessageManager/listUserMessages");
    expect(body.headers).toMatchObject({ mid });
    expect(body.body).toEqual(["65289538993@goofish", false, 9_007_199_254_740_991, 40, false]);
    expect(imConversationId("65289538993@goofish")).toBe("65289538993@goofish");
  });

  it("从 vulcan 推送里抽出真人会话 cid", () => {
    const frame = {
      lwp: "/s/vulcan",
      body: {
        syncPushPackage: {
          data: [
            {
              data: JSON.stringify({
                sessionId: "60585751957",
                chatType: 1,
                operation: {
                  sessionInfo: {
                    sessionType: 1,
                    extensions: { itemId: "812345" },
                  },
                },
              }),
            },
            {
              data: Buffer.from(JSON.stringify({ "1": "47812870000@goofish", "2": 1, "3": "m1" })).toString(
                "base64",
              ),
            },
          ],
        },
      },
    };
    const payloads = extractImPushPayloads(frame);
    expect(payloads).toHaveLength(2);
    expect(extractImSessionHint(payloads[0]!)).toEqual({
      cid: "60585751957",
      sessionType: 1,
      itemId: "812345",
    });
    expect(extractImSessionHint(payloads[1]!)).toEqual({ cid: "47812870000" });
    expect(isBuyerImSession({ cid: "1", sessionType: 23 })).toBe(false);
  });

  it("能解开 base64 MessagePack 推送里的 cid", () => {
    const packed = Buffer.from(encodeMsgpack({ 1: "60585751957@goofish", 2: 1 })).toString("base64");
    const decoded = decodeImPushData(packed);
    expect(extractImSessionHint(decoded!)).toEqual({ cid: "60585751957" });
    expect(extractImSessionHint({ 1: "13402391472503.PNM" })).toBeUndefined();
  });

  it("能从令牌响应里读出 accessToken", () => {
    expect(readAccessToken({ accessToken: "tok-1" })).toBe("tok-1");
    expect(readAccessToken({ data: { accessToken: "tok-2" } })).toBe("tok-2");
    expect(readAccessToken({})).toBeUndefined();
  });
});

describe("LiveXianyuAdapter", () => {
  it("擦亮 / 改价 / 下架 / 发货老实说还没接到", async () => {
    const adapter = new LiveXianyuAdapter();
    const state = createSeedState(NOW);
    const listingId = state.listings.find((item) => item.status === "on_sale")!.id;

    expect((await adapter.refreshListing(state, listingId, NOW)).message).toContain("还没接到");
    const listing = state.listings.find((item) => item.id === listingId)!;
    expect(
      (await adapter.updatePrice(state, listingId, listing.priceCents, NOW)).message,
    ).toContain("还没接到");
    expect((await adapter.delistListing(state, listingId, NOW)).message).toContain("还没接到");
    expect((await adapter.shipOrder(state, "O20240001", "顺丰", "SF1", NOW)).message).toContain(
      "还没接到",
    );
  });

  it("没有对方 id 时不发", async () => {
    const adapter = new LiveXianyuAdapter(async () => {
      throw new Error("不该连上闲鱼");
    });
    const state = createSeedState(NOW);
    const result = await adapter.sendMessage(state, "C001", "在的", NOW);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("对方的闲鱼 id");
  });

  it("发送成功后把回复写进本地会话", async () => {
    const sent: Array<{ cid: string; toid: string; text: string }> = [];
    const adapter = new LiveXianyuAdapter(async (input) => {
      sent.push({ cid: input.cid, toid: input.toid, text: input.text });
      return { ok: true, message: "已发到闲鱼。" };
    });
    const state = createSeedState(NOW);
    const conversation = state.conversations.find((item) => item.id === "C001")!;
    conversation.buyerId = "2222";

    const result = await adapter.sendMessage(state, "C001", "可以的", NOW);
    expect(result.ok).toBe(true);
    expect(sent).toEqual([{ cid: "C001", toid: "2222", text: "可以的" }]);
    expect(conversation.status).toBe("awaiting_buyer");
    expect(conversation.messages.at(-1)).toMatchObject({
      author: "seller",
      text: "可以的",
      viaAgent: true,
    });
  });

  it("真实写入模式走 live 通道", () => {
    const state = createSeedState(NOW);
    state.channel.write = "live";
    expect(writeChannelFor(state).id).toContain("live");
    state.channel.write = "mock";
    expect(writeChannelFor(state).id).toContain("mock");
  });
});
