import { AgentTickButton } from "@/components/agent-tick-button";
import { InboxView } from "@/components/inbox-view";
import { getState } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function InboxPage() {
  const state = await getState();
  const needsReply = state.conversations.filter((c) => c.status === "needs_reply").length;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">消息</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {needsReply > 0
              ? `${needsReply} 个买家在等你回复。Agent 可以按意图起草，发不发你说了算。`
              : "所有买家消息都回完了。"}
          </p>
        </div>
        <AgentTickButton size="sm" />
      </div>

      <InboxView conversations={state.conversations} listings={state.listings} />
    </div>
  );
}
