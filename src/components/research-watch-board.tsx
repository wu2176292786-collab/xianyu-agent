"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { fetchRivalCopy, setRivalWatched, updateWatchInterval } from "@/app/actions";
import { RivalCover } from "@/components/rival-copy-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ResearchTask } from "@/lib/domain/types";
import { relativeTime, shopDayLabel } from "@/lib/format";
import { watchBoard } from "@/lib/research/analysis";
import { type DailyCompare } from "@/lib/research/heat";
import { watchCapacity } from "@/lib/research/monitoring";
import { cn } from "@/lib/utils";

function Metric({
  label,
  daily,
}: {
  label: string;
  daily: DailyCompare;
}) {
  if (daily.today === undefined && daily.yesterday === undefined) {
    return (
      <div>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-sm text-amber-800">{daily.note ?? "还没抽到"}</p>
      </div>
    );
  }

  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="tabular-nums">
        <span className="text-base font-semibold">
          {(daily.today ?? daily.yesterday)?.toLocaleString("zh-CN")}
        </span>
        {daily.delta !== undefined ? (
          <span
            className={cn(
              "ml-1.5 text-xs font-medium",
              daily.delta > 0
                ? "text-emerald-600"
                : daily.delta < 0
                  ? "text-rose-600"
                  : "text-muted-foreground",
            )}
          >
            {daily.yesterday !== undefined
              ? `较昨天 ${daily.delta > 0 ? `+${daily.delta}` : daily.delta}`
              : `较上次 ${daily.delta > 0 ? `+${daily.delta}` : daily.delta}`}
          </span>
        ) : (
          <span className="ml-1.5 text-xs text-muted-foreground">
            {daily.note}
          </span>
        )}
      </p>
      {daily.today !== undefined && daily.yesterday !== undefined ? (
        <p className="text-xs text-muted-foreground">
          昨天 {daily.yesterday.toLocaleString("zh-CN")}
        </p>
      ) : daily.today !== undefined && daily.previous !== undefined && daily.previousDay ? (
        <p className="text-xs text-muted-foreground">
          {shopDayLabel(daily.previousDay)} {daily.previous.toLocaleString("zh-CN")}
          {daily.note ? ` · ${daily.note}` : ""}
        </p>
      ) : null}
    </div>
  );
}

function WatchIntervalControl({
  interval,
  intervalHours,
  minimumIntervalHours,
  pending,
  onChange,
  onSave,
}: {
  interval: string;
  intervalHours: number;
  minimumIntervalHours: number;
  pending: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-md border bg-muted/30 px-3 py-3">
      <div className="space-y-1">
        <Label htmlFor="watch-interval" className="text-xs">
          全局监控间隔（小时）
        </Label>
        <Input
          id="watch-interval"
          type="number"
          min={minimumIntervalHours}
          max={168}
          step={1}
          inputMode="numeric"
          className="h-8 w-28"
          value={interval}
          disabled={pending}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onSave}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      </div>
      <p className="pb-1 text-xs text-muted-foreground">
        目标间隔；范围 {minimumIntervalHours}–168，默认 24。风控暂停、浏览器不可用或安全预算会让本轮延后。
        当前设为每 {intervalHours} 小时。
      </p>
    </div>
  );
}

export function ResearchWatchBoard({
  task,
  rivals,
  now,
  intervalHours,
  watchedCount,
}: {
  task: ResearchTask;
  rivals: Parameters<typeof watchBoard>[1];
  now: number;
  intervalHours: number;
  watchedCount: number;
}) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const [interval, setInterval] = useState(String(intervalHours));
  const minimumIntervalHours = watchCapacity(watchedCount, intervalHours).minimumIntervalHours;
  const items = watchBoard(task, rivals, now, intervalHours);

  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    startTransition(async () => {
      const result = await fn();
      toast[result.ok ? "success" : "error"](result.message);
      router.refresh();
    });

  const saveInterval = () => {
    const hours = Number(interval);
    if (hours === intervalHours) return;
    run(() => updateWatchInterval(hours));
  };

  if (items.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">热度监控</CardTitle>
          <CardDescription>
            在下面表格里点「监控」，盯住的商品会出现在这里。应用开着时，每 {intervalHours} 小时自动采一次想要和浏览。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <WatchIntervalControl
            interval={interval}
            intervalHours={intervalHours}
            minimumIntervalHours={minimumIntervalHours}
            pending={pending}
            onChange={setInterval}
            onSave={saveInterval}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          热度监控
          <Badge variant="outline">{items.length}</Badge>
        </CardTitle>
        <CardDescription>
          只采你盯住的可比商品，最久没采的排前面；同一间隔内试过的不会重复开页，撞风控会停手 6 小时。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <WatchIntervalControl
          interval={interval}
          intervalHours={intervalHours}
          minimumIntervalHours={minimumIntervalHours}
          pending={pending}
          onChange={setInterval}
          onSave={saveInterval}
        />
        {items.map((item) => (
          <div
            key={item.rival.id}
            className={cn(
              "flex flex-wrap items-start gap-3 rounded-md border px-3 py-3",
              item.due ? "border-amber-200 bg-amber-50/70" : "bg-muted/30",
            )}
          >
            <RivalCover rival={item.rival} />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <a
                  href={item.rival.url}
                  target="_blank"
                  rel="noreferrer"
                  className="line-clamp-2 text-sm font-medium underline-offset-2 hover:underline"
                >
                  {item.rival.title}
                </a>
                {item.triedThisInterval ? (
                  <Badge variant="outline">本间隔内试过没采到</Badge>
                ) : item.due ? (
                  <Badge variant="outline">待采集</Badge>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {relativeTime(item.lastAt, now)}
                  </span>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Metric label="想要" daily={item.wantsDaily} />
                <Metric label="浏览" daily={item.viewsDaily} />
              </div>
              <div className="flex flex-wrap gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending || !item.due}
                  onClick={() => run(() => fetchRivalCopy(item.rival.id))}
                >
                  {item.triedThisInterval
                    ? `${intervalHours} 小时内已尝试`
                    : item.due
                      ? "采集热度"
                      : `${intervalHours} 小时内已采过`}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => run(() => setRivalWatched(item.rival.id, false))}
                >
                  取消监控
                </Button>
              </div>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
