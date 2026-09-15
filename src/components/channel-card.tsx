"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  type LiveChannelStatus,
  setWritesPaused,
  syncFromPlatform,
  updateChannel,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { READ_CHANNEL_LABEL, WRITE_MODE_LABEL } from "@/lib/adapters/guard";
import type {
  ChannelConfig,
  ReadChannel,
  SafetyState,
  WriteMode,
} from "@/lib/domain/types";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const WRITE_MODES: Array<{ value: WriteMode; hint: string }> = [
  { value: "mock", hint: "改本地数据，模拟平台反应。演示和开发用。" },
  { value: "dry_run", hint: "只记录「本来要干什么」，什么都不改。接真实账号前先跑这个。" },
  { value: "live", hint: "真实写入。通道还没实现，选了会被拒绝。" },
];

const READ_CHANNELS: Array<{ value: ReadChannel; hint: string }> = [
  { value: "mock", hint: "用本地示例数据，每次同步会造一点平台侧的变化。" },
  {
    value: "live",
    hint: "拉你真实店铺的商品和会话。先跑 npm run xianyu:login 导入登录态。",
  },
];

export function ChannelCard({
  channel,
  safety,
  live,
  lastSyncAt,
}: {
  channel: ChannelConfig;
  safety: SafetyState;
  /** 真实通道的配置情况，只含「有没有配」，不含凭证本身 */
  live: LiveChannelStatus;
  lastSyncAt?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [limits, setLimits] = useState({
    maxWritesPerMinute: String(channel.maxWritesPerMinute),
    minWriteIntervalMs: String(channel.minWriteIntervalMs),
    autoPauseAfterFailures: String(channel.autoPauseAfterFailures),
  });
  const router = useRouter();

  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    startTransition(async () => {
      const result = await fn();
      toast[result.ok ? "success" : "error"](result.message);
      router.refresh();
    });

  const commitLimit = (key: keyof typeof limits) => {
    if (limits[key] === String(channel[key])) return;
    run(() => updateChannel({ [key]: limits[key] }));
  };

  return (
    <Card className={cn(safety.paused && "border-rose-300")}>
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            通道与安全
            <Badge variant={safety.paused ? "outline" : "secondary"}>
              {safety.paused ? "已急停" : WRITE_MODE_LABEL[channel.write]}
            </Badge>
          </CardTitle>
          <CardDescription>
            读和写是两条独立的通道，可以「读真实数据 + 写模拟」，在真实店铺上验证规则而一个字都不往平台写。
          </CardDescription>
        </div>
        <Button
          variant={safety.paused ? "default" : "destructive"}
          size="sm"
          disabled={pending}
          onClick={() => run(() => setWritesPaused(!safety.paused))}
        >
          {safety.paused ? "解除急停" : "急停"}
        </Button>
      </CardHeader>

      <CardContent className="space-y-4">
        {safety.paused ? (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            <p className="font-medium">所有写操作已停止</p>
            <p className="mt-0.5">
              {safety.pausedReason ?? "未说明原因"}
              {safety.pausedAt ? `（${relativeTime(safety.pausedAt)}）` : ""}
            </p>
          </div>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">写模式</Label>
            <div className="space-y-1.5">
              {WRITE_MODES.map((mode) => (
                <button
                  key={mode.value}
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => updateChannel({ write: mode.value }))}
                  className={cn(
                    "w-full rounded-md border px-3 py-2 text-left text-sm transition-colors",
                    channel.write === mode.value
                      ? "border-primary bg-primary/10"
                      : "hover:bg-muted/60",
                  )}
                >
                  <span className="font-medium">{WRITE_MODE_LABEL[mode.value]}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {mode.hint}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">读通道</Label>
            <div className="space-y-1.5">
              {READ_CHANNELS.map((source) => (
                <button
                  key={source.value}
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => updateChannel({ read: source.value }))}
                  className={cn(
                    "w-full rounded-md border px-3 py-2 text-left text-sm transition-colors",
                    channel.read === source.value
                      ? "border-primary bg-primary/10"
                      : "hover:bg-muted/60",
                  )}
                >
                  <span className="font-medium">{READ_CHANNEL_LABEL[source.value]}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {source.hint}
                  </span>
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => run(() => syncFromPlatform())}
              >
                {pending ? "同步中…" : "从平台同步"}
              </Button>
              <span className="text-xs text-muted-foreground">
                上次同步：{lastSyncAt ? relativeTime(lastSyncAt) : "还没同步过"}
              </span>
            </div>

            {channel.read === "live" ? (
              <div className="space-y-1 rounded-md border bg-muted/40 px-3 py-2 text-xs">
                <p className={live.credentials.configured ? "" : "text-amber-700"}>
                  凭证：{live.credentials.detail}
                </p>
                <p className="text-muted-foreground">
                  商品接口：{live.endpoints.listings ?? "未配置"}
                </p>
                <p className="text-muted-foreground">
                  订单接口：{live.endpoints.orders ?? "未配置（同步时会保留本地订单）"}
                </p>
                <p className="text-muted-foreground">
                  消息接口：{live.endpoints.conversations ?? "未配置（同步时会保留本地会话）"}
                </p>
                <p className="text-muted-foreground">
                  用 <code className="font-mono">npm run xianyu:probe</code> 验证接口名和登录态。
                </p>
              </div>
            ) : null}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          {(
            [
              ["maxWritesPerMinute", "每分钟最多写"],
              ["minWriteIntervalMs", "最小间隔（毫秒）"],
              ["autoPauseAfterFailures", "连续失败几次急停"],
            ] as const
          ).map(([key, label]) => (
            <div key={key} className="space-y-1.5">
              <Label htmlFor={key} className="text-xs text-muted-foreground">
                {label}
              </Label>
              <Input
                id={key}
                className="h-8"
                inputMode="numeric"
                value={limits[key]}
                disabled={pending}
                onChange={(event) =>
                  setLimits((prev) => ({ ...prev, [key]: event.target.value }))
                }
                onBlur={() => commitLimit(key)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            </div>
          ))}
        </div>

        <p className="text-xs text-muted-foreground">
          限流只在演练和真实模式下生效 —— 本地模拟没有账号需要保护，限流只会让演示变卡。
          当前窗口内已写 {safety.recentWrites.length} 次，连续失败 {safety.consecutiveFailures} 次。
        </p>
      </CardContent>
    </Card>
  );
}
