/**
 * 验证登录态并同步一次。不打印 cookie / 正文。
 */
import { readerFor } from "../src/lib/adapters";
import { inspectLoginState } from "../src/lib/adapters/live/credentials";
import {
  describeLoginState,
  loadLoginState,
  loginStateOrigin,
} from "../src/lib/adapters/live/login-state";
import { describeShape } from "../src/lib/adapters/live/paths";
import { mapMessages, messageSyncReq } from "../src/lib/adapters/live/mapping";
import { VERIFIED_ENDPOINTS, callMtop, selfUserId } from "../src/lib/adapters/live/reader";
import { describeMerge, mergeSnapshot } from "../src/lib/agent/sync";
import { getState, logActivity, mutateState } from "../src/lib/store";

async function main() {
  const login = await loadLoginState();
  const credentials = inspectLoginState(login);
  const origin = await loginStateOrigin();
  console.log(
    JSON.stringify({
      step: "status",
      configured: credentials.configured,
      hasSession: credentials.hasSession,
      hasToken: credentials.hasToken,
      hasUserAgent: credentials.hasUserAgent,
      origin,
      detail: credentials.detail,
      description: describeLoginState(login),
    }),
  );

  if (!login) process.exit(1);

  const userId = selfUserId(login.cookie);
  const verify = await callMtop({
    api: VERIFIED_ENDPOINTS.userHead,
    payload: userId ? { userId, self: true } : { self: true },
    loginState: login,
    maxAttempts: 1,
  });
  console.log(JSON.stringify({ step: "verify", kind: verify.kind, ret: verify.ret }));
  if (verify.kind !== "ok") process.exit(1);

  const before = await getState();
  const target = before.conversations[0];
  if (target) {
    const history = await callMtop({
      api: VERIFIED_ENDPOINTS.messages,
      version: "1.0",
      payload: messageSyncReq(target.id),
      loginState: login,
      maxAttempts: 1,
    });
    const mapped =
      history.kind === "ok"
        ? mapMessages(history.data, Date.now(), userId, [], {
            peerId: target.buyerId,
            peerNicks: target.buyerName && target.buyerName !== "买家" ? [target.buyerName] : [],
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
        step: "probe",
        conversationId: target.id,
        kind: history.kind,
        ret: history.ret,
        mapped: mapped.items.length,
        skipped: mapped.skipped,
        authors,
        shape: history.kind === "ok" ? describeShape(history.data).slice(0, 40) : [],
      }),
    );
  }

  const now = Date.now();
  const reader = readerFor(before);
  try {
    const snapshot = await reader.fetchSnapshot(before, now);
    const summary = await mutateState((state) => {
      const merged = mergeSnapshot(state, snapshot, now);
      logActivity(state, "system", `已从${reader.label}同步：${describeMerge(merged)}。`, now);
      return merged;
    });
    console.log(JSON.stringify({ step: "sync", ok: true, message: describeMerge(summary) }));
  } catch (error) {
    console.log(
      JSON.stringify({
        step: "sync",
        ok: false,
        message: error instanceof Error ? error.message : "同步失败",
      }),
    );
    process.exit(1);
  }

  const after = await getState();
  const totals = after.conversations.reduce(
    (acc, conversation) => {
      acc.conversations += 1;
      for (const message of conversation.messages) {
        acc[message.author] += 1;
        if (message.id.endsWith("-last")) acc.summaryOnly += 1;
      }
      if (conversation.messages.some((message) => message.author === "buyer")) acc.withBuyer += 1;
      return acc;
    },
    { conversations: 0, buyer: 0, seller: 0, summaryOnly: 0, withBuyer: 0 },
  );
  console.log(JSON.stringify({ step: "inbox", ...totals }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
