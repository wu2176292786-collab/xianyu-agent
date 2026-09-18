/**
 * 排查：某个会话的 message.sync 到底回了哪些发送者。
 * 不打印 cookie / token / 完整正文。
 */
import { describeShape } from "../src/lib/adapters/live/paths";
import { messageSyncReq, mapMessages } from "../src/lib/adapters/live/mapping";
import { callMtop, selfUserId } from "../src/lib/adapters/live/reader";
import { loadLoginState } from "../src/lib/adapters/live/login-state";

const sessionId = process.argv[2] ?? "65289538993";
const type = Number(process.argv[3] ?? "1");

function leaf(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const key of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

async function main() {
  const login = await loadLoginState();
  if (!login?.cookie) {
    console.log("no login");
    process.exit(1);
  }
  const me = selfUserId(login.cookie);
  const payload = {
    req: JSON.stringify({ sessionId, start: 0, fetchs: 20, type }),
  };
  const outcome = await callMtop({
    api: "mtop.taobao.idlemessage.pc.message.sync",
    version: "1.0",
    payload,
    loginState: login,
  });
  console.log(
    JSON.stringify({
      kind: outcome.kind,
      ret: outcome.ret,
      sessionId,
      type,
      mePresent: Boolean(me),
    }),
  );
  if (outcome.kind !== "ok") return;

  const data = outcome.data;
  console.log("shape", describeShape(data).slice(0, 80).join("\n"));

  const list =
    (Array.isArray((data as { messages?: unknown[] })?.messages) &&
      (data as { messages: unknown[] }).messages) ||
    [];
  console.log("rawCount", list.length);

  for (const [i, record] of list.entries()) {
    const rec = record as Record<string, unknown>;
    const sender = rec.senderInfo as Record<string, unknown> | undefined;
    const content = rec.content as Record<string, unknown> | undefined;
    const text =
      (leaf(record, "content.text.text") as string | undefined) ??
      (leaf(record, "content.text") as string | undefined) ??
      (typeof rec.summary === "string" ? rec.summary : undefined);
    console.log(
      JSON.stringify({
        i,
        keys: Object.keys(rec),
        senderKeys: sender ? Object.keys(sender) : [],
        senderId: sender?.userId,
        senderNick: sender?.nick,
        senderFish: sender?.fishNick,
        contentKeys: content ? Object.keys(content) : [],
        contentType: content?.contentType,
        arg1: rec.arg1,
        hasCustom: Boolean(content && "custom" in content),
        text: typeof text === "string" ? text.slice(0, 20) : typeof text,
        id: rec.messageUuid ?? rec.id,
      }),
    );
  }

  const mapped = mapMessages(data, Date.now(), me, []);
  console.log(
    "mapped",
    mapped.items.length,
    "skipped",
    mapped.skipped,
    mapped.items.map((m) => m.author),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
