/**
 * 收 IM 会话激活，再拉历史。不打印 cookie / 正文 / 完整 id。
 */
import { listImHistories } from "../src/lib/adapters/live/im";
import { inferMessagePeer, mapMessages } from "../src/lib/adapters/live/mapping";
import { selfUserId } from "../src/lib/adapters/live/reader";
import { loadLoginState } from "../src/lib/adapters/live/login-state";

function maskId(value: string | undefined): string {
  if (!value) return "";
  return `${value.slice(0, 3)}…${value.slice(-3)}/${value.length}`;
}

async function main() {
  const login = await loadLoginState();
  if (!login) {
    console.log("no login");
    process.exit(1);
  }
  const me = selfUserId(login.cookie);
  const result = await listImHistories([], {
    loginState: login,
    collectMs: 6_000,
    timeoutMs: 35_000,
    maxConversations: 8,
  });
  const first = [...result.payloads.values()].find((payload) => {
    const list = (payload as { userMessageModels?: unknown[] })?.userMessageModels;
    return Array.isArray(list) && list.length > 0;
  }) as { userMessageModels?: unknown[] } | undefined;
  const sample = first?.userMessageModels?.[0] as Record<string, unknown> | undefined;
  const inner = (sample?.message ?? sample) as Record<string, unknown> | undefined;
  const content = inner?.content as Record<string, unknown> | undefined;
  console.log(
    JSON.stringify({
      step: "shape",
      payloadKeys: first ? Object.keys(first) : [],
      modelKeys: sample ? Object.keys(sample) : [],
      messageKeys: inner ? Object.keys(inner) : [],
      contentKeys: content ? Object.keys(content) : [],
      hasCustom: Boolean(content && "custom" in content),
      extensionKeys: inner?.extension && typeof inner.extension === "object"
        ? Object.keys(inner.extension as Record<string, unknown>)
        : [],
    }),
  );

  const inbox = [...result.payloads.entries()].map(([cid, payload]) => {
    const peer = inferMessagePeer(payload, me);
    const mapped = mapMessages(payload, Date.now(), me, [], peer);
    const authors = mapped.items.reduce(
      (acc, message) => {
        acc[message.author] += 1;
        return acc;
      },
      { buyer: 0, seller: 0 },
    );
    return {
      cid: maskId(cid),
      mapped: mapped.items.length,
      skipped: mapped.skipped,
      authors,
      peer: Boolean(peer.peerId),
    };
  });
  console.log(
    JSON.stringify({
      ok: result.ok,
      message: result.message,
      errors: result.errors,
      sessions: result.sessions.map((session) => ({
        cid: maskId(session.cid),
        type: session.sessionType,
        item: Boolean(session.itemId),
      })),
      payloads: result.payloads.size,
      inbox,
    }),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
