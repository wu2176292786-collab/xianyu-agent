/**
 * 试 message.sync 的几种入参。不打印 cookie / 正文。
 */
import { loadLoginState } from "../src/lib/adapters/live/login-state";
import { describeShape } from "../src/lib/adapters/live/paths";
import { mapMessages } from "../src/lib/adapters/live/mapping";
import { callMtop, selfUserId } from "../src/lib/adapters/live/reader";
import { getState } from "../src/lib/store";

const sessionId = process.argv[2];

async function tryOnce(
  id: string,
  req: Record<string, unknown>,
  me: string | undefined,
) {
  const outcome = await callMtop({
    api: "mtop.taobao.idlemessage.pc.message.sync",
    version: "1.0",
    payload: { req: JSON.stringify(req) },
    loginState: await loadLoginState(),
    maxAttempts: 1,
  });
  const mapped =
    outcome.kind === "ok"
      ? mapMessages(outcome.data, Date.now(), me, [])
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
      req,
      kind: outcome.kind,
      ret: outcome.ret,
      mapped: mapped.items.length,
      skipped: mapped.skipped,
      authors,
      shapeHead: outcome.kind === "ok" ? describeShape(outcome.data).slice(0, 12) : [],
    }),
  );
}

async function main() {
  const login = await loadLoginState();
  if (!login) {
    console.log("no login");
    process.exit(1);
  }
  const me = selfUserId(login.cookie);
  const state = await getState();
  const id = sessionId ?? state.conversations[0]?.id;
  if (!id) {
    console.log("no session");
    process.exit(1);
  }
  console.log(JSON.stringify({ sessionId: id, mePresent: Boolean(me) }));

  const variants: Record<string, unknown>[] = [
    { sessionId: id, start: 0, fetchs: 20, type: 1 },
    { sessionId: id, start: 0, fetchs: 20, type: 0 },
    { sessionId: Number(id), start: 0, fetchs: 20, type: 1 },
    { sessionId: id, start: 0, fetchNum: 20, type: 1 },
    { sessionId: id, start: 0, fetchs: 50, type: 1 },
  ];

  for (const req of variants) {
    await tryOnce(id, req, me);
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
