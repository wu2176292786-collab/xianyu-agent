"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { setAutoTick } from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { AgentRun, ShopSettings } from "@/lib/domain/types";
import { relativeTime } from "@/lib/format";

function runSummary(run: AgentRun): string {
  const parts: string[] = [];
  if (run.applied > 0) parts.push(`自动执行 ${run.applied}`);
  if (run.queued > 0) parts.push(`待审批 ${run.queued}`);
  if (run.failed > 0) parts.push(`失败 ${run.failed}`);
  return parts.length > 0 ? parts.join(" · ") : "无事可做";
}

export function AutoTickCard({
  settings,
  runs,
  nextTickLabel,
}: {
  settings: ShopSettings;
  runs: AgentRun[];
  /** 由服务端算好的「下次巡检」文案，避免客户端时间对不上 */
  nextTickLabel: string;
}) {
  const [minutes, setMinutes] = useState(String(settings.autoTickMinutes));
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    startTransition(async () => {
      const result = await fn();
      toast[result.ok ? "success" : "error"](result.message);
      router.refresh();
    });

  const commitMinutes = () => {
    if (minutes === String(settings.autoTickMinutes)) return;
    startTransition(async () => {
      const result = await setAutoTick(settings.autoTickEnabled, minutes);
      if (!result.ok) {
        toast.error(result.message);
        setMinutes(String(settings.autoTickMinutes));
        return;
      }
      toast.success(`巡检间隔已改为 ${minutes} 分钟。`);
      router.refresh();
    });
  };

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            自动巡检
            <Badge variant={settings.autoTickEnabled ? "secondary" : "outline"}>
              {settings.autoTickEnabled ? "运行中" : "已关闭"}
            </Badge>
          </CardTitle>
          <CardDescription>
            不点按钮也会按间隔跑。免审批的规则直接执行，其余照样进审批队列。
          </CardDescription>
        </div>
        <Switch
          checked={settings.autoTickEnabled}
          disabled={pending}
          aria-label="自动巡检开关"
          onCheckedChange={(checked) => run(() => setAutoTick(checked))}
        />
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="autoTickMinutes" className="text-xs text-muted-foreground">
              巡检间隔（分钟）
            </Label>
            <Input
              id="autoTickMinutes"
              className="h-8"
              inputMode="numeric"
              value={minutes}
              disabled={pending || !settings.autoTickEnabled}
              onChange={(event) => setMinutes(event.target.value)}
              onBlur={commitMinutes}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          </div>
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">下次巡检</p>
            <p className="flex h-8 items-center text-sm">{nextTickLabel}</p>
          </div>
        </div>

        <div>
          <p className="mb-2 text-xs text-muted-foreground">最近巡检</p>
          {runs.length === 0 ? (
            <p className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
              还没有巡检记录。
            </p>
          ) : (
            <div className="divide-y rounded-md border">
              {runs.slice(0, 6).map((entry) => (
                <div
                  key={entry.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
                >
                  <span className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[11px]">
                      {entry.trigger === "scheduled" ? "自动" : "手动"}
                    </Badge>
                    {runSummary(entry)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {relativeTime(entry.at)} · {entry.durationMs}ms
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
