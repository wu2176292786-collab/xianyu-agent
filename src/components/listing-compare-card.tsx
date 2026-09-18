"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { analyzeListingCompetition } from "@/app/actions";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { Listing, ResearchTask } from "@/lib/domain/types";
import { relativeTime, yuan } from "@/lib/format";
import type { PriceBand } from "@/lib/research/analysis";

export function ListingCompareCard({
  task,
  listing,
  band,
  llmConfigured,
  llmModel,
  now,
}: {
  task: ResearchTask;
  listing: Listing | undefined;
  band: PriceBand;
  llmConfigured: boolean;
  llmModel: string;
  now: number;
}) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <Card className="max-h-[min(32rem,65vh)] min-h-0">
      <CardHeader className="shrink-0">
        <CardTitle className="text-base">对标本店商品</CardTitle>
        <CardDescription>
          {listing
            ? "价格带用规则算；点「智能分析」让模型根据观察点写对照，编数字会弃用。"
            : "还没有绑定本店商品。"}
        </CardDescription>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain text-sm">
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
                {listing.copy ? (
                  <p className="mt-2 line-clamp-3 text-xs text-muted-foreground">
                    {listing.copy}
                  </p>
                ) : null}
              </div>
            </div>
            {band.count >= 1 ? (
              <div className="space-y-1 rounded-md border bg-muted/40 px-3 py-2 text-xs">
                <p>可比同行最低 {yuan(band.minCents)}</p>
                <p>可比同行中位 {yuan(band.medianCents)}</p>
                <p>可比同行最高 {yuan(band.maxCents)}</p>
              </div>
            ) : null}

            {task.llmAnalysis ? (
              <div className="space-y-2 rounded-md border bg-muted/40 px-3 py-2">
                <p className="text-xs text-muted-foreground">
                  {llmModel} ·{" "}
                  {task.llmAnalysisAt
                    ? relativeTime(task.llmAnalysisAt, now)
                    : "刚刚"}
                </p>
                <p className="whitespace-pre-wrap text-sm leading-relaxed">
                  {task.llmAnalysis}
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {llmConfigured
                  ? "还没有智能分析。规则结论在左边，模型这段要你点一下才写。"
                  : "还没配置 OPENAI_API_KEY，智能分析不可用。"}
              </p>
            )}
          </>
        ) : (
          <p className="text-muted-foreground">
            在下面的「统一规格」里选一件本店商品，就能并排看价格带，再让模型写对照。
          </p>
        )}

        <div className="space-y-1 border-t pt-3 text-xs text-muted-foreground">
          <p>规格存疑排除 {band.excludedUncertain} 件</p>
          <p>判为不同款排除 {band.excludedDifferent} 件</p>
          <p>可比但没抽到价格 {band.missingPrice} 件</p>
        </div>
      </CardContent>
      {listing ? (
        <CardFooter className="shrink-0">
          <Button
            size="sm"
            variant="secondary"
            disabled={pending || !llmConfigured}
            onClick={() => {
              startTransition(async () => {
                const result = await analyzeListingCompetition(task.id);
                toast[result.ok ? "success" : "error"](result.message);
                if (result.ok) router.refresh();
              });
            }}
          >
            {pending ? "分析中…" : task.llmAnalysis ? "重新分析" : "智能分析"}
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}
