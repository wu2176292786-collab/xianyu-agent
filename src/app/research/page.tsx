import Link from "next/link";
import { CollectorCard } from "@/components/collector-card";
import { ListingCompareCard } from "@/components/listing-compare-card";
import { ResearchAskCard } from "@/components/research-ask-card";
import { ResearchLiveRefresh } from "@/components/research-live-refresh";
import { ResearchPanel } from "@/components/research-panel";
import { ResearchWatchBoard } from "@/components/research-watch-board";
import { ResearchTaskDialog } from "@/components/research-task-dialog";
import { StatCard } from "@/components/stat-card";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { loginStateStamp } from "@/lib/adapters/live/login-state";
import { llmStatus } from "@/lib/agent/llm";
import { nowMs, yuan } from "@/lib/format";
import { findingsFor, priceBand, watchBoard } from "@/lib/research/analysis";
import { clampWatchIntervalHours, heatPauseHolds } from "@/lib/research/heat";
import { ensureCollectorToken } from "@/lib/research/collector";
import { clampSearchPages } from "@/lib/research/search-pager";
import { pruneHiddenRivals, visibleRivals } from "@/lib/research/screen";
import { getState, mutateState } from "@/lib/store";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";
/** 补热度要打开几件商详，文案润色也要等模型，默认 10 秒会被掐掉。 */
export const maxDuration = 180;

export default async function ResearchPage({
  searchParams,
}: PageProps<"/research">) {
  let state = await getState();
  const now = nowMs();
  const requested = (await searchParams).task;

  // v1.4 之前的状态里没有这个字段，补一次就行，不用每次进页面都写盘
  const collectorToken =
    state.research.collectorToken ?? (await mutateState(ensureCollectorToken));

  const heatPaused = heatPauseHolds(
    state.research.heatPull,
    now,
    await loginStateStamp(),
  );

  const tasks = state.research.tasks;
  const task =
    tasks.find(
      (t) => t.id === (typeof requested === "string" ? requested : ""),
    ) ?? tasks[0];

  if (!task) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">选品研究</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            看同行热度的办法是盯商品主页的「想要」：同一件商品多次回访，差值才有意义。
          </p>
        </div>
        <Card>
          <CardContent className="space-y-3 px-6 py-12 text-center">
            <p className="text-sm font-medium">还没有研究任务</p>
            <p className="text-sm text-muted-foreground">
              新建一个任务，然后在闲鱼正常浏览时采集页面快照导进来。
            </p>
            <div className="flex justify-center pt-1">
              <ResearchTaskDialog
                listings={state.listings}
                llmConfigured={llmStatus().configured}
              />
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (
    state.research.rivals.some(
      (rival) => rival.taskId === task.id && rival.alignment !== "comparable",
    )
  ) {
    await mutateState((next) => {
      pruneHiddenRivals(next, task.id);
    });
    state = await getState();
  }

  const rivals = visibleRivals(
    state.research.rivals.filter((r) => r.taskId === task.id),
  );
  const comparable = rivals;
  const band = priceBand(rivals);
  const watchIntervalHours = clampWatchIntervalHours(state.research.watchIntervalHours);
  const watching = watchBoard(task, rivals, now, watchIntervalHours);
  const due = watching.filter((item) => item.due);
  const listing = state.listings.find((l) => l.id === task.linkedListingId);
  const searchPages = clampSearchPages(state.research.searchPages);
  const findings = findingsFor(task, rivals, listing, now, searchPages);
  const observations = rivals.reduce(
    (acc, r) => acc + r.observations.length,
    0,
  );

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <ResearchLiveRefresh taskId={task.id} />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">选品研究</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            搜索页导入只记下卡片；浏览和想要在商品详情页。后台会用本机浏览器一件一件补，一轮最多 6 件，中间留间隔；监控中的商品会按你设定的节奏采集。撞风控会自动停手 6 小时。
          </p>
          {heatPaused && state.research.heatPull?.pauseUntil ? (
            <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {state.research.heatPull.lastMessage ?? "热度采集撞过风控。"}
              自动补数暂停到{" "}
              {new Date(state.research.heatPull.pauseUntil).toLocaleString("zh-CN", {
                hour12: false,
              })}
              。重新导一份登录态可以提前解除。
            </p>
          ) : null}
        </div>
        <ResearchTaskDialog
          listings={state.listings}
          llmConfigured={llmStatus().configured}
        />
      </div>

      {tasks.length > 1 ? (
        <div className="flex flex-wrap gap-2">
          {tasks.map((item) => (
            <Link
              key={item.id}
              id={`research-task-${item.id}`}
              href={`/research?task=${item.id}`}
              className={cn(
                "rounded-md border px-3 py-1.5 text-sm transition-colors",
                item.id === task.id
                  ? "border-primary bg-primary/10"
                  : "hover:bg-muted/60",
              )}
            >
              {item.name}
            </Link>
          ))}
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon="🎯"
          label="规格可比的同行"
          value={String(comparable.length)}
          hint="不同款和存疑不进这张表，由模型筛选"
        />
        <StatCard
          icon="💰"
          label="可比同行中位价"
          value={band.count >= 1 ? yuan(band.medianCents) : "—"}
          hint={
            band.count >= 1
              ? `${yuan(band.minCents)} ~ ${yuan(band.maxCents)}，共 ${band.count} 件`
              : "还没有可比同行抽到价格"
          }
        />
        <StatCard
          icon="👀"
          label="观察点总数"
          value={String(observations)}
          hint="只追加，不覆盖"
        />
        <StatCard
          icon="📌"
          label="热度监控"
          value={String(watching.length)}
          hint={
            due.length > 0
              ? `${due.length} 件今天还没采到或还缺数字`
              : watching.length > 0
                ? `每 ${watchIntervalHours} 小时采一次`
                : "在表格里点「监控」开始盯"
          }
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">观察结论</CardTitle>
            <CardDescription>
              左边这些是规则从观察点算出来的，每条都能点回证据。右边的智能分析走模型，
              编数字会弃用。都不会自动改你的商品。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {findings.map((finding) => (
              <div
                key={finding.id}
                className={cn(
                  "rounded-md border px-3 py-2.5 text-sm",
                  finding.severity === "attention"
                    ? "border-amber-200 bg-amber-50 text-amber-900"
                    : "bg-muted/40",
                )}
              >
                <p>{finding.text}</p>
                {finding.evidence.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {finding.evidence.map((evidence, index) => (
                      <a
                        key={`${finding.id}-${evidence.url}-${index}`}
                        href={evidence.url}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded border bg-background px-1.5 py-0.5 text-xs underline-offset-2 hover:underline"
                      >
                        {evidence.label}
                      </a>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>

        <ListingCompareCard
          task={task}
          listing={listing}
          band={band}
          llmConfigured={llmStatus().configured}
          llmModel={llmStatus().model}
          now={now}
        />
      </div>

      <ResearchWatchBoard
        task={task}
        rivals={rivals}
        now={now}
        intervalHours={watchIntervalHours}
        watchedCount={state.research.rivals.filter((rival) => rival.watched).length}
      />

      <ResearchAskCard
        taskId={task.id}
        llmConfigured={llmStatus().configured}
      />

      <ResearchPanel
        task={task}
        rivals={rivals}
        listings={state.listings}
        now={now}
        llmConfigured={llmStatus().configured}
        llmModel={llmStatus().model}
        searchPages={searchPages}
      />

      <CollectorCard token={collectorToken} searchPages={searchPages} />
    </div>
  );
}
