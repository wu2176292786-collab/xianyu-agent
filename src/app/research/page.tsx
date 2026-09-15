import Link from "next/link";
import { ResearchPanel } from "@/components/research-panel";
import { ResearchTaskDialog } from "@/components/research-task-dialog";
import { StatCard } from "@/components/stat-card";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { nowMs, relativeTime, yuan } from "@/lib/format";
import { findingsFor, priceBand, revisitQueue } from "@/lib/research/analysis";
import { lastObservedAt } from "@/lib/research/record";
import { getState } from "@/lib/store";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function ResearchPage({
  searchParams,
}: PageProps<"/research">) {
  const state = await getState();
  const now = nowMs();
  const requested = (await searchParams).task;

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
              <ResearchTaskDialog listings={state.listings} />
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const rivals = state.research.rivals.filter((r) => r.taskId === task.id);
  const comparable = rivals.filter((r) => r.alignment === "comparable");
  const band = priceBand(rivals);
  const due = revisitQueue(task, rivals, now);
  const listing = state.listings.find((l) => l.id === task.linkedListingId);
  const findings = findingsFor(task, rivals, listing, now);
  const observations = rivals.reduce(
    (acc, r) => acc + r.observations.length,
    0,
  );

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">选品研究</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            数据只来自你正常浏览时采集的页面快照。服务器不会拿你的登录态去轮询别人的商详。
          </p>
        </div>
        <ResearchTaskDialog listings={state.listings} />
      </div>

      {tasks.length > 1 ? (
        <div className="flex flex-wrap gap-2">
          {tasks.map((item) => (
            <Link
              key={item.id}
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
          hint={`共 ${rivals.length} 件在研究里`}
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
          icon="🔁"
          label="该回访"
          value={String(due.length)}
          hint={`超过 ${task.revisitHours} 小时没看`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">观察结论</CardTitle>
            <CardDescription>
              全部由观察点算出来，每条都挂着可以点回去的证据。不会自动改你的商品
              —— 改标题、改价格都得你亲自决定。
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
                    {finding.evidence.map((evidence) => (
                      <a
                        key={`${finding.id}-${evidence.label}`}
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

        <Card>
          <CardHeader>
            <CardTitle className="text-base">对标本店商品</CardTitle>
            <CardDescription>
              {listing
                ? "价格带只用规格「可比」的同行算。"
                : "还没有绑定本店商品。"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {listing ? (
              <>
                <div className="flex items-start gap-2">
                  <span aria-hidden className="text-xl leading-none">
                    {listing.emoji}
                  </span>
                  <div className="min-w-0">
                    <p className="line-clamp-2 font-medium">{listing.title}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      挂牌 {yuan(listing.priceCents)} · 想要 {listing.wants} ·
                      近 7 天浏览 {listing.views7d.toLocaleString("zh-CN")}
                    </p>
                  </div>
                </div>
                {band.count >= 1 ? (
                  <div className="space-y-1 rounded-md border bg-muted/40 px-3 py-2 text-xs">
                    <p>可比同行最低 {yuan(band.minCents)}</p>
                    <p>可比同行中位 {yuan(band.medianCents)}</p>
                    <p>可比同行最高 {yuan(band.maxCents)}</p>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="text-muted-foreground">
                在下面的「统一规格」里选一件本店商品，就能并排看价格带。
              </p>
            )}

            <div className="space-y-1 border-t pt-3 text-xs text-muted-foreground">
              <p>规格存疑排除 {band.excludedUncertain} 件</p>
              <p>判为不同款排除 {band.excludedDifferent} 件</p>
              <p>可比但没抽到价格 {band.missingPrice} 件</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {due.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              回访清单
              <Badge variant="outline">{due.length}</Badge>
            </CardTitle>
            <CardDescription>
              这一版没有爬虫，所以「监测」就是回访：打开页面的动作由你做，Agent
              只负责 告诉你哪几件该去看一眼。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {due.map((item) => (
              <div
                key={item.rival.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
              >
                <a
                  href={item.rival.url}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate underline-offset-2 hover:underline"
                >
                  {item.rival.title}
                </a>
                <span className="shrink-0 text-xs text-muted-foreground">
                  上次观察 {relativeTime(lastObservedAt(item.rival), now)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <ResearchPanel
        task={task}
        rivals={rivals}
        listings={state.listings}
        now={now}
      />
    </div>
  );
}
