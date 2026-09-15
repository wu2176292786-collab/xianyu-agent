import { ActionCard } from "@/components/action-card";
import { AgentTickButton } from "@/components/agent-tick-button";
import { BatchDecideButtons } from "@/components/batch-decide-buttons";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { QueueTabs } from "@/components/queue-tabs";
import { TabsContent } from "@/components/ui/tabs";
import type { AgentAction } from "@/lib/domain/types";
import { relativeTime } from "@/lib/format";
import { getState } from "@/lib/store";

export const dynamic = "force-dynamic";

function HistoryRow({ action }: { action: AgentAction }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2 border-b px-4 py-3 last:border-b-0">
      <div className="min-w-0">
        <p className="text-sm">{action.title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{action.reason}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
        <Badge variant={action.status === "applied" ? "secondary" : "outline"}>
          {action.status === "applied"
            ? action.decidedBy === "agent"
              ? "Agent 自动执行"
              : "你已通过"
            : "已忽略"}
        </Badge>
        <span>{relativeTime(action.decidedAt ?? action.createdAt)}</span>
      </div>
    </div>
  );
}

export default async function QueuePage({ searchParams }: PageProps<"/queue">) {
  const state = await getState();
  const tab = (await searchParams).tab;
  const initialTab = typeof tab === "string" ? tab : "pending";
  const pending = state.actions.filter((a) => a.status === "pending");
  const failed = state.actions.filter((a) => a.status === "failed");
  const applied = state.actions.filter((a) => a.status === "applied");
  const rejected = state.actions.filter((a) => a.status === "rejected");

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">行动队列</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Agent 提出的每一个动作都带着理由，你可以直接通过、改完再通过，或者忽略。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <BatchDecideButtons disabled={pending.length === 0} />
          <AgentTickButton size="sm" />
        </div>
      </div>

      <QueueTabs
        initialTab={initialTab}
        tabs={[
          { value: "pending", label: `待审批（${pending.length}）` },
          { value: "failed", label: `执行失败（${failed.length}）` },
          { value: "applied", label: `已执行（${applied.length}）` },
          { value: "rejected", label: `已忽略（${rejected.length}）` },
        ]}
      >

        <TabsContent value="pending" className="mt-4">
          {pending.length === 0 ? (
            <Card>
              <CardContent className="px-6 py-12 text-center">
                <p className="text-sm font-medium">没有待审批的建议</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  点「运行 Agent」巡检一遍，需要你决定的事会排到这里。
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {pending.map((action) => (
                <ActionCard key={action.id} action={action} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="failed" className="mt-4">
          {failed.length === 0 ? (
            <Card>
              <CardContent className="px-6 py-12 text-center">
                <p className="text-sm font-medium">没有执行失败的动作</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  自动执行失败的动作会留在这里带着失败原因，可以改完再试。
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {failed.map((action) => (
                <ActionCard key={action.id} action={action} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="applied" className="mt-4">
          <Card className="py-0">
            <CardContent className="px-0">
              {applied.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-muted-foreground">
                  还没有执行过任何动作。
                </p>
              ) : (
                applied.map((action) => <HistoryRow key={action.id} action={action} />)
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="rejected" className="mt-4">
          <Card className="py-0">
            <CardContent className="px-0">
              {rejected.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-muted-foreground">
                  你还没有忽略过任何建议。
                </p>
              ) : (
                rejected.map((action) => <HistoryRow key={action.id} action={action} />)
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </QueueTabs>
    </div>
  );
}
