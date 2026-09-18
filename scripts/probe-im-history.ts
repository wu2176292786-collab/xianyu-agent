/**
 * 用 IM WebSocket 拉一个会话的历史。不打印 cookie / 正文。
 */
import { listImHistories } from "../src/lib/adapters/live/im";
import { describeShape } from "../src/lib/adapters/live/paths";
import { mapMessages } from "../src/lib/adapters/live/mapping";
import { selfUserId } from "../src/lib/adapters/live/reader";
import { loadLoginState } from "../src/lib/adapters/live/login-state";
import { getState } from "../src/lib/store";

async function main() {
  const login = await loadLoginState();
  const state = await getState();
  const id = process.argv[2] ?? state.conversations[0]?.id;
  if (!id || !login) {
    console.log("no session or login");
    process.exit(1);
  }

  const result = await listImHistories([id], { loginState: login, timeoutMs: 25_000 });
  const payload = result.payloads.get(id);
  const mapped = payload
    ? mapMessages(payload, Date.now(), selfUserId(login.cookie), [], {
        peerId: state.conversations.find((conversation) => conversation.id === id)?.buyerId,
      })
    : { items: [], skipped: 0 };
  const authors = mapped.items.reduce(
    (acc, message) => {
      acc[message.author] += 1;
      return acc;
    },
    { buyer: 0, seller: 0 },
  );

  console.log(
    JSON.stringify({
      ok: result.ok,
      message: result.message,
      errors: result.errors,
      hasPayload: Boolean(payload),
      mapped: mapped.items.length,
      skipped: mapped.skipped,
      authors,
      shape: payload ? describeShape(payload).slice(0, 30) : [],
    }),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
