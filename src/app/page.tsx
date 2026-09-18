import Link from "next/link";
import { ActionCard } from "@/components/action-card";
import { AgentTickButton } from "@/components/agent-tick-button";
import { AutoRefresh } from "@/components/auto-refresh";
import { StatCard } from "@/components/stat-card";
import { StoreSyncButton } from "@/components/store-sync-button";
import { TrendChart } from "@/components/trend-chart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { nextScheduledTickAt } from "@/lib/agent/engine";
import { shopHeatFromListings } from "@/lib/agent/sync";
import type { ActivityKind, DailyMetric } from "@/lib/domain/types";
import { nowMs, relativeTime, shopDay, yuan } from "@/lib/format";
import { getState } from "@/lib/store";

export const dynamic = "force-dynamic";

const ACTIVITY_STYLE: Record<ActivityKind, { icon: string; label: string }> = {
  agent: { icon: "🤖", label: "Agent" },
  human: { icon: "🙋", label: "你" },
  system: { icon: "🔔", label: "系统" },
};

function sum(values: number[]) {
  return values.reduce((acc, v) => acc + v, 0);
}

function delta(current: number, previous: number) {
  if (previous === 0) return undefined;
  return (current - previous) / previous;
}

export default async function DashboardPage() {
  const state = await getState();

  const last7 = state.metrics.slice(-7);
  const prev7 = state.metrics.slice(-14, -7);
  const listingHeat = shopHeatFromListings(state.listings);
  const useListingHeat = listingHeat.known > 0;
  const views = useListingHeat ? listingHeat.views : sum(last7.map((m) => m.views));
  const weekAgo = state.metrics.find((row) => row.date === shopDay(nowMs() - 7 * 24 * 60 * 60 * 1000));
  const prevViews = useListingHeat ? weekAgo?.views : sum(prev7.map((m) => m.views));
  const gmv = sum(last7.map((m) => m.gmvCents));
  const prevGmv = sum(prev7.map((m) => m.gmvCents));
  const chartMetrics: DailyMetric[] =
    state.metrics.length > 0
      ? state.metrics
      : listingHeat.known > 0
        ? [
            {
              date: shopDay(nowMs()),
              views: listingHeat.views,
              inquiries: listingHeat.inquiries,
              orders: 0,
              gmvCents: 0,
            },
          ]
        : [];

  const onSale = state.listings.filter((l) => l.status === "on_sale");
  const needsReply = state.conversations.filter((c) => c.status === "needs_reply");
  const pendingActions = state.actions.filter((a) => a.status === "pending");
  const failedActions = state.actions.filter((a) => a.status === "failed");
  const nextTickAt = nextScheduledTickAt(state);
  const nextTickMinutes =
    nextTickAt === null ? null : Math.max(0, Math.round((nextTickAt - nowMs()) / 60_000));
  const recentActivity = [...state.activity].sort(
    (a, b) => Date.parse(b.at) - Date.parse(a.at),
  );

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <AutoRefresh />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">总览</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            刷新店铺数据会拉取最新商品、曝光和消息；运行 Agent 只会巡检已刷新数据，把该做的事整理成建议交给你确认。
            {nextTickMinutes === null
              ? "自动巡检已关闭，需要你手动跑。"
              : nextTickMinutes === 0
                ? "下一轮自动巡检马上就跑。"
                : `下一轮自动巡检约 ${nextTickMinutes} 分钟后。`}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <StoreSyncButton lastSyncAt={state.lastSyncAt} />
          <AgentTickButton />
        </div>
      </div>

      {failedActions.length > 0 ? (
        <Card className="border-rose-200 bg-rose-50/60">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-1">
            <div>
              <p className="text-sm font-medium text-rose-900">
                有 {failedActions.length} 条动作执行失败
              </p>
              <p className="mt-0.5 text-sm text-rose-800">
                {failedActions[0].title}：{failedActions[0].failureReason ?? "未知原因"}
              </p>
            </div>
            <Button
              render={<Link href="/queue?tab=failed" />}
              nativeButton={false}
              size="sm"
            >
              去处理
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon="👀"
          label="近 7 天曝光"
          value={views.toLocaleString("zh-CN")}
          delta={prevViews === undefined ? undefined : delta(views, prevViews)}
          hint={
            useListingHeat
              ? `在售 ${listingHeat.known} 件已同步浏览`
              : "较上周"
          }
        />
        <StatCard
          icon="💰"
          label="近 7 天成交额"
          value={yuan(gmv)}
          delta={delta(gmv, prevGmv)}
          hint="较上周"
        />
        <StatCard
          icon="💬"
          label="待回复消息"
          value={String(needsReply.length)}
          hint={needsReply.length > 0 ? "买家正在等你" : "都回完了"}
        />
        <StatCard
          icon="🏷️"
          label="在售商品"
          value={String(onSale.length)}
          hint="件"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>近 14 天流量与成交</CardTitle>
            <CardDescription>
              曝光是闲鱼最重要的杠杆，擦亮和降价都是在抢曝光。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TrendChart metrics={chartMetrics} />
          </CardContent>
        </Card>

        <Card className="max-h-[min(28rem,60vh)] min-h-0">
          <CardHeader className="shrink-0">
            <CardTitle>最近动态</CardTitle>
            <CardDescription>
              Agent 和你的每一次操作都会记录在这里。记录多了就在框里往下翻。
            </CardDescription>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain">
            {recentActivity.length === 0 ? (
              <p className="text-sm text-muted-foreground">还没有任何操作记录。</p>
            ) : (
              recentActivity.map((entry) => (
                <div key={entry.id} className="flex gap-3 text-sm">
                  <span aria-hidden className="mt-0.5 leading-none">
                    {ACTIVITY_STYLE[entry.kind].icon}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="leading-snug">{entry.text}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {ACTIVITY_STYLE[entry.kind].label} · {relativeTime(entry.at)}
                    </p>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              待你确认
              {pendingActions.length > 0 ? (
                <Badge variant="secondary">{pendingActions.length}</Badge>
              ) : null}
            </CardTitle>
            <CardDescription>
              高风险动作永远不会自动执行，必须你点头。
            </CardDescription>
          </div>
          {pendingActions.length > 0 ? (
            <Button
              render={<Link href="/queue" />}
              nativeButton={false}
              variant="outline"
              size="sm"
            >
              查看全部
            </Button>
          ) : null}
        </CardHeader>
        <CardContent>
          {pendingActions.length === 0 ? (
            <div className="rounded-lg border border-dashed px-6 py-10 text-center">
              <p className="text-sm font-medium">审批队列是空的</p>
              <p className="mt-1 text-sm text-muted-foreground">
                点「运行 Agent」让它巡检一遍店铺，有需要处理的事会出现在这里。
              </p>
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {pendingActions.slice(0, 4).map((action) => (
                <ActionCard key={action.id} action={action} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
