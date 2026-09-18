"use client";

import { useRouter } from "next/navigation";
import { Fragment, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  fillMissingRivalHeat,
  importPageSnapshot,
  removeRival,
  setRivalAlignment,
  setRivalWatched,
  updateResearchTask,
} from "@/app/actions";
import {
  RivalCopyPanel,
  RivalCover,
  copyText,
  downloadText,
} from "@/components/rival-copy-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  ALIGNMENT_LABEL,
  DELIVERY_LABEL,
  type Alignment,
  type ExtractionLayer,
  type Listing,
  type ResearchTask,
  type RivalListing,
} from "@/lib/domain/types";
import { clockTime, relativeTime, yuan } from "@/lib/format";
import {
  heatGap,
  latestHeat,
  overlappingSpecWords,
  viewsTrend,
  wantsTrend,
} from "@/lib/research/analysis";
import { shopEntryUrl } from "@/lib/research/shop";
import { exportTaskCopy, safeExportName } from "@/lib/research/copy";
import { needsHeatFill } from "@/lib/research/heat";
import { displayImageUrls } from "@/lib/research/snapshot";
import { cn } from "@/lib/utils";

const ALIGNMENTS: Alignment[] = ["comparable", "uncertain", "different"];

const LAYER_LABEL: Record<ExtractionLayer, string> = {
  api: "页面接口",
  hydration: "内嵌 JSON",
  dom: "可见文字",
};

const SNAPSHOT_EXAMPLE = `{
  "capturedAt": "2026-09-15T04:00:00.000Z",
  "pageUrl": "https://www.goofish.com/item?id=812345001",
  "pageType": "detail",
  "visibleText": "95人想要 · 包邮 · 九成新"
}`;

function AlignmentBadge({ rival }: { rival: RivalListing }) {
  return (
    <Badge
      variant={
        rival.alignment === "comparable"
          ? "default"
          : rival.alignment === "different"
            ? "outline"
            : "secondary"
      }
    >
      {ALIGNMENT_LABEL[rival.alignment]}
      {rival.alignmentBy === "human" ? " ·人工" : ""}
    </Badge>
  );
}

export function ResearchPanel({
  task,
  rivals,
  listings,
  now,
  llmConfigured,
  llmModel,
  searchPages,
}: {
  task: ResearchTask;
  rivals: RivalListing[];
  listings: Listing[];
  now: number;
  llmConfigured: boolean;
  llmModel: string;
  searchPages: number;
}) {
  const [pending, startTransition] = useTransition();
  const [importing, setImporting] = useState(false);
  const [snapshot, setSnapshot] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [onlyWatched, setOnlyWatched] = useState(false);
  const [spec, setSpec] = useState({
    mustInclude: task.mustInclude.join(" "),
    mustExclude: task.mustExclude.join(" "),
    revisitHours: String(task.revisitHours),
  });
  const router = useRouter();
  const specClash = overlappingSpecWords(task);
  const watchedCount = rivals.filter((rival) => rival.watched).length;
  const missingHeat = rivals.filter(needsHeatFill).length;
  const rows = onlyWatched ? rivals.filter((rival) => rival.watched) : rivals;

  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    startTransition(async () => {
      const result = await fn();
      toast[result.ok ? "success" : "error"](result.message);
      router.refresh();
    });

  const commitSpec = (key: keyof typeof spec, original: string) => {
    if (spec[key] === original) return;
    run(() => updateResearchTask(task.id, { [key]: spec[key] }));
  };

  return (
    <>
      <Card>
        <CardHeader className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-base">统一规格与采集</CardTitle>
            <CardDescription>
              浏览量在商品详情页，搜索结果卡上没有。导入后模型先筛同类，不同款和存疑
              不会进这张表。热度由后台开本机浏览器按批补，撞风控会自动停手。盯住的货才会按天对比。
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={onlyWatched ? "default" : "outline"}
              disabled={watchedCount === 0}
              onClick={() => setOnlyWatched((open) => !open)}
            >
              {onlyWatched ? "只看监控中" : `监控中 ${watchedCount}`}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={rivals.length === 0}
              onClick={() =>
                copyText(exportTaskCopy(task, rivals), "全部文案")
              }
            >
              复制全部文案
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={rivals.length === 0}
              onClick={() => {
                downloadText(
                  safeExportName(task.name),
                  exportTaskCopy(task, rivals),
                );
                toast.success("已开始下载文案。");
              }}
            >
              导出全部文案
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending || missingHeat === 0}
              onClick={() => run(() => fillMissingRivalHeat(task.id))}
            >
              {missingHeat > 0 ? `补热度 ${missingHeat}` : "热度已补齐"}
            </Button>
            <Button
              size="sm"
              disabled={pending}
              onClick={() => setImporting(true)}
            >
              导入页面快照
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {specClash.length > 0 ? (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              「必须含」和「必须不含」都写了
              {specClash.map((word) => `「${word}」`).join("、")}
              。标题一命中就会被判成不同款，价格带会一直是空的。把「必须不含」清掉，或只留真正不要的词（例如「日版」「配件」）。
            </p>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5">
              <Label
                htmlFor="spec-include"
                className="text-xs text-muted-foreground"
              >
                必须含
              </Label>
              <Input
                id="spec-include"
                className="h-8"
                value={spec.mustInclude}
                disabled={pending}
                onChange={(event) =>
                  setSpec((prev) => ({
                    ...prev,
                    mustInclude: event.target.value,
                  }))
                }
                onBlur={() =>
                  commitSpec("mustInclude", task.mustInclude.join(" "))
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label
                htmlFor="spec-exclude"
                className="text-xs text-muted-foreground"
              >
                必须不含
              </Label>
              <Input
                id="spec-exclude"
                className="h-8"
                value={spec.mustExclude}
                disabled={pending}
                onChange={(event) =>
                  setSpec((prev) => ({
                    ...prev,
                    mustExclude: event.target.value,
                  }))
                }
                onBlur={() =>
                  commitSpec("mustExclude", task.mustExclude.join(" "))
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label
                htmlFor="spec-listing"
                className="text-xs text-muted-foreground"
              >
                对标本店商品
              </Label>
              <select
                id="spec-listing"
                className="h-8 w-full rounded-md border bg-transparent px-2 text-sm"
                value={task.linkedListingId ?? ""}
                disabled={pending}
                onChange={(event) =>
                  run(() =>
                    updateResearchTask(task.id, {
                      linkedListingId: event.target.value,
                    }),
                  )
                }
              >
                <option value="">暂不绑定</option>
                {listings.map((listing) => (
                  <option key={listing.id} value={listing.id}>
                    {listing.title.slice(0, 20)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label
                htmlFor="spec-revisit"
                className="text-xs text-muted-foreground"
              >
                回访间隔（小时）
              </Label>
              <Input
                id="spec-revisit"
                className="h-8"
                inputMode="numeric"
                value={spec.revisitHours}
                disabled={pending}
                onChange={(event) =>
                  setSpec((prev) => ({
                    ...prev,
                    revisitHours: event.target.value,
                  }))
                }
                onBlur={() =>
                  commitSpec("revisitHours", String(task.revisitHours))
                }
              />
            </div>
          </div>

          <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[34%]">同行商品</TableHead>
                  <TableHead className="w-[14%]">规格对齐</TableHead>
                  <TableHead className="w-[16%] text-right">想要 / 浏览</TableHead>
                  <TableHead className="w-[10%] text-right">最近价格</TableHead>
                  <TableHead className="w-[10%]">上次观察</TableHead>
                  <TableHead className="sticky right-0 z-10 w-[12%] bg-card text-right shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.12)]">
                    操作
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="whitespace-normal py-10 text-center text-sm text-muted-foreground"
                    >
                      {onlyWatched
                        ? "还没有盯住的商品。在表格里点「监控」，想要和浏览会出现在上方的热度监控里。"
                        : task.kind === "shop"
                          ? "这家店还没采到货。从任意一件同行商品上点「进店铺」，在闲鱼的「在售」里正常翻页，再点扩展「加入研究」。整店都会进来，不按可比筛。"
                          : `还没有同类同行。建任务不会自动搜闲鱼：先装页面底部的采集端，再打开闲鱼搜「${task.keyword || task.name}」或进商品详情，点扩展「加入研究」。搜索页会连翻 ${searchPages} 页。模型会把不同款和存疑挡在表外。`}
                    </TableCell>
                  </TableRow>
                ) : null}

                {rows.map((rival) => {
                  const trend = wantsTrend(rival);
                  const views = viewsTrend(rival);
                  const heat = latestHeat(rival);
                  const gap = heatGap(rival);
                  const images = displayImageUrls(rival.imageUrls);
                  const latest = rival.observations.at(-1);
                  const priced = [...rival.observations]
                    .filter((o) => o.priceCents !== undefined)
                    .at(-1);
                  const open = expanded === rival.id;

                  return (
                    <Fragment key={rival.id}>
                      <TableRow className={rival.watched ? "bg-amber-50/40" : undefined}>
                        <TableCell className="max-w-0 whitespace-normal">
                          <div className="flex items-start gap-3">
                            <RivalCover rival={rival} />
                            <div className="min-w-0 flex-1">
                              <a
                                href={rival.url}
                                target="_blank"
                                rel="noreferrer"
                                className="line-clamp-2 break-words text-sm font-medium underline-offset-2 hover:underline"
                              >
                                {rival.watched ? "📌 " : ""}
                                {rival.title}
                              </a>
                              <p className="mt-1 font-mono text-xs text-muted-foreground">
                                {rival.itemId}
                                {rival.sellerName
                                  ? ` · ${rival.sellerName}`
                                  : ""}
                                {images.length > 1 ? ` · ${images.length} 图` : ""}
                              </p>
                              {shopEntryUrl(rival) ? (
                                // 普通链接，用你自己的浏览器打开，不经过本机自动化
                                <a
                                  href={shopEntryUrl(rival)}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="mt-1 inline-block text-xs text-muted-foreground underline underline-offset-2"
                                >
                                  进店铺
                                </a>
                              ) : (
                                <span
                                  className="mt-1 inline-block text-xs text-muted-foreground/60"
                                  title="还没抽到卖家 id。用采集端进这件商详采一次，身份就留下了。"
                                >
                                  进店铺（缺卖家 id）
                                </span>
                              )}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="whitespace-normal">
                          <div className="flex flex-col items-start gap-1">
                            <AlignmentBadge rival={rival} />
                            <div className="flex gap-1">
                              {ALIGNMENTS.filter(
                                (value) => value !== rival.alignment,
                              ).map((value) => (
                                <button
                                  key={value}
                                  type="button"
                                  disabled={pending}
                                  onClick={() =>
                                    run(() =>
                                      setRivalAlignment(rival.id, value),
                                    )
                                  }
                                  className="text-xs text-muted-foreground underline underline-offset-2"
                                >
                                  {ALIGNMENT_LABEL[value]}
                                </button>
                              ))}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="whitespace-normal text-right tabular-nums">
                          <p title={heat.wants === undefined ? gap.wants : undefined}>
                            {heat.wants?.toLocaleString("zh-CN") ?? "—"}
                            {trend.delta !== undefined ? (
                              <span
                                className={cn(
                                  "ml-1 text-xs font-medium",
                                  trend.delta > 0
                                    ? "text-emerald-600"
                                    : trend.delta < 0
                                      ? "text-rose-600"
                                      : "text-muted-foreground",
                                )}
                              >
                                {trend.delta > 0 ? `+${trend.delta}` : trend.delta}
                              </span>
                            ) : null}
                          </p>
                          <p
                            className="text-xs text-muted-foreground"
                            title={heat.views === undefined ? gap.views : undefined}
                          >
                            {heat.views !== undefined
                              ? `${heat.views.toLocaleString("zh-CN")} 浏览`
                              : gap.views}
                            {views.delta !== undefined ? (
                              <span
                                className={cn(
                                  "ml-1 font-medium",
                                  views.delta > 0
                                    ? "text-emerald-600"
                                    : views.delta < 0
                                      ? "text-rose-600"
                                      : "",
                                )}
                              >
                                {views.delta > 0 ? `+${views.delta}` : views.delta}
                              </span>
                            ) : null}
                          </p>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {priced?.priceCents !== undefined ? (
                            <>
                              {yuan(priced.priceCents)}
                              <p className="text-xs text-muted-foreground">
                                {DELIVERY_LABEL[priced.delivery]}
                              </p>
                            </>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              没抽到
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-normal text-sm text-muted-foreground">
                          {latest ? relativeTime(latest.at, now) : "—"}
                          <p className="text-xs">
                            {rival.observations.length} 次观察
                          </p>
                        </TableCell>
                        <TableCell className="sticky right-0 z-10 bg-card shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.12)]">
                          <div className="flex justify-end gap-1">
                            <Button
                              size="sm"
                              variant={rival.watched ? "default" : "ghost"}
                              disabled={pending}
                              onClick={() =>
                                run(() =>
                                  setRivalWatched(rival.id, !rival.watched),
                                )
                              }
                            >
                              {rival.watched ? "已监控" : "监控"}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                setExpanded(open ? null : rival.id)
                              }
                            >
                              {open ? "收起" : "文案"}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={pending}
                              onClick={() => run(() => removeRival(rival.id))}
                            >
                              移出
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>

                      {open ? (
                        <TableRow className="bg-muted/30">
                          <TableCell
                            colSpan={6}
                            className="max-w-0 whitespace-normal py-3"
                          >
                            <div className="max-w-full space-y-3 overflow-hidden">
                              <div className="flex items-center justify-between gap-2">
                                <p className="text-xs font-medium text-muted-foreground">
                                  商品文案
                                </p>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => setExpanded(null)}
                                >
                                  收起
                                </Button>
                              </div>
                              <RivalCopyPanel
                                rival={rival}
                                llmConfigured={llmConfigured}
                                llmModel={llmModel}
                                onDone={() => router.refresh()}
                                onCollapse={() => setExpanded(null)}
                              />
                              <p className="text-xs font-medium text-muted-foreground">
                                观察时间线
                              </p>
                              {rival.observations.map((observation) => (
                                <div
                                  key={observation.id}
                                  className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
                                >
                                  <span className="font-mono">
                                    {clockTime(observation.at)}
                                  </span>
                                  <Badge variant="outline">
                                    {observation.source === "detail"
                                      ? "商详"
                                      : observation.source === "shop"
                                        ? "店铺"
                                        : "搜索"}
                                  </Badge>
                                  <span>
                                    想要{" "}
                                    {observation.wants ?? (
                                      <span className="text-amber-700">
                                        未抽到
                                      </span>
                                    )}
                                    {observation.wantsFrom
                                      ? `（${LAYER_LABEL[observation.wantsFrom]}）`
                                      : ""}
                                  </span>
                                  <span>
                                    浏览{" "}
                                    {observation.views ?? (
                                      <span className="text-amber-700">
                                        未抽到
                                      </span>
                                    )}
                                  </span>
                                  <span>
                                    {observation.priceCents !== undefined
                                      ? yuan(observation.priceCents)
                                      : "价格未抽到"}
                                  </span>
                                  <span className="text-muted-foreground">
                                    {DELIVERY_LABEL[observation.delivery]}
                                  </span>
                                  {observation.excerpt ? (
                                    <span className="text-muted-foreground">
                                      原文「{observation.excerpt}」
                                    </span>
                                  ) : null}
                                  <a
                                    href={observation.pageUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="underline underline-offset-2"
                                  >
                                    证据
                                  </a>
                                </div>
                              ))}
                              <p className="pt-1 text-xs text-muted-foreground">
                                只比较商详对商详 ——
                                搜索卡片的「想要」口径不一样，混算会造出假涨跌。
                              </p>
                              <div className="flex justify-end">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => setExpanded(null)}
                                >
                                  收起
                                </Button>
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
        </CardContent>
      </Card>

      <Dialog open={importing} onOpenChange={setImporting}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>导入页面快照</DialogTitle>
            <DialogDescription>
              在闲鱼商详或搜索结果页采集，粘贴进来。同一件商品再导一次是追加观察，
              不会覆盖旧证据 —— 这一版的价值全在历史差值上。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="snapshot">快照 JSON</Label>
            <Textarea
              id="snapshot"
              rows={10}
              className="font-mono text-xs"
              placeholder={SNAPSHOT_EXAMPLE}
              value={snapshot}
              onChange={(event) => setSnapshot(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              抽取按「页面接口 → 内嵌 JSON →
              可见文字」三层依次尝试，抽不到就如实记成缺失， 绝不写成 0。10
              分钟内的重复观察会合并成一条。
            </p>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setImporting(false)}
              disabled={pending}
            >
              取消
            </Button>
            <Button
              disabled={pending || !snapshot.trim()}
              onClick={() =>
                startTransition(async () => {
                  const result = await importPageSnapshot(task.id, snapshot);
                  toast[result.ok ? "success" : "error"](result.message);
                  if (result.ok) {
                    setSnapshot("");
                    setImporting(false);
                  }
                  router.refresh();
                })
              }
            >
              导入
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
