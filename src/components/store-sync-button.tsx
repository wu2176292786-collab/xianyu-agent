"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { syncFromPlatform } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { relativeTime } from "@/lib/format";

/**
 * 手动刷新店铺的真实读通道。
 *
 * 它和「运行 Agent」刻意分开：这里拉平台的商品、曝光和会话；Agent 只消费
 * 已同步的本地数据来生成运营建议。
 */
export function StoreSyncButton({
  lastSyncAt,
}: {
  lastSyncAt?: string;
}) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <p className="text-xs text-muted-foreground">
        {lastSyncAt ? `上次刷新 ${relativeTime(lastSyncAt)}` : "店铺数据尚未刷新"}
      </p>
      <Button
        variant="outline"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await syncFromPlatform();
            toast[result.ok ? "success" : "error"](result.message);
            router.refresh();
          })
        }
      >
        {pending ? "刷新中…" : "刷新店铺数据"}
      </Button>
    </div>
  );
}
