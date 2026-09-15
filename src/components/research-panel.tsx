"use client";

import { useRouter } from "next/navigation";
import { Fragment, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  importPageSnapshot,
  removeRival,
  setRivalAlignment,
  updateResearchTask,
} from "@/app/actions";
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
import { wantsTrend } from "@/lib/research/analysis";
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
}: {
  task: ResearchTask;
  rivals: RivalListing[];
  listings: Listing[];
  now: number;
}) {
  const [pending, startTransition] = useTransition();
  const [importing, setImporting] = useState(false);
  const [snapshot, setSnapshot] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [spec, setSpec] = useState({
    mustInclude: task.mustInclude.join(" "),
    mustExclude: task.mustExclude.join(" "),
    revisitHours: String(task.revisitHours),
  });
  const router = useRouter();

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
              规格改了会重算对齐结论，但你亲自标过的那几件不会被覆盖 ——
              人看过的比关键词可靠。
            </CardDescription>
          </div>
          <Button
            size="sm"
            disabled={pending}
            onClick={() => setImporting(true)}
          >
            导入页面快照
          </Button>
        </CardHeader>

        <CardContent className="space-y-4">
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

          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-64">同行商品</TableHead>
                  <TableHead>规格对齐</TableHead>
                  <TableHead className="text-right">最新想要</TableHead>
                  <TableHead className="text-right">变化</TableHead>
                  <TableHead className="text-right">最近价格</TableHead>
                  <TableHead>上次观察</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rivals.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="py-10 text-center text-sm text-muted-foreground"
                    >
                      还没有同行商品。在闲鱼正常浏览时采集一份页面快照导进来。
                    </TableCell>
                  </TableRow>
                ) : null}

                {rivals.map((rival) => {
                  const trend = wantsTrend(rival);
                  const latest = rival.observations.at(-1);
                  const priced = [...rival.observations]
                    .filter((o) => o.priceCents !== undefined)
                    .at(-1);
                  const open = expanded === rival.id;

                  return (
                    <Fragment key={rival.id}>
                      <TableRow>
                        <TableCell>
                          <a
                            href={rival.url}
                            target="_blank"
                            rel="noreferrer"
                            className="line-clamp-2 text-sm font-medium underline-offset-2 hover:underline"
                          >
                            {rival.title}
                          </a>
                          <p className="mt-1 font-mono text-xs text-muted-foreground">
                            {rival.itemId}
                            {rival.sellerName ? ` · ${rival.sellerName}` : ""}
                          </p>
                        </TableCell>
                        <TableCell>
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
                        <TableCell className="text-right tabular-nums">
                          {trend.latest ?? "—"}
                          {trend.latest !== undefined && latest?.wantsFrom ? (
                            <p className="text-xs text-muted-foreground">
                              {LAYER_LABEL[latest.wantsFrom]}
                            </p>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {trend.delta === undefined ? (
                            <span className="text-xs text-muted-foreground">
                              {trend.note ? "待回访" : "—"}
                            </span>
                          ) : (
                            <>
                              <span
                                className={cn(
                                  "font-medium",
                                  trend.delta > 0
                                    ? "text-emerald-600"
                                    : trend.delta < 0
                                      ? "text-rose-600"
                                      : "",
                                )}
                              >
                                {trend.delta > 0
                                  ? `+${trend.delta}`
                                  : trend.delta}
                              </span>
                              <p className="text-xs text-muted-foreground">
                                {trend.hours!.toFixed(0)} 小时
                                {trend.perDay
                                  ? ` · ${trend.perDay.toFixed(1)}/天`
                                  : ""}
                              </p>
                            </>
                          )}
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
                        <TableCell className="text-sm text-muted-foreground">
                          {latest ? relativeTime(latest.at, now) : "—"}
                          <p className="text-xs">
                            {rival.observations.length} 次观察
                          </p>
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                setExpanded(open ? null : rival.id)
                              }
                            >
                              {open ? "收起" : "时间线"}
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
                          <TableCell colSpan={7} className="py-3">
                            <div className="space-y-1.5">
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
                            </div>
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
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
