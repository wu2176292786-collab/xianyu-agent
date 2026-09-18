"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { regenerateCollectorToken } from "@/app/actions";
import { SearchPagesControl } from "@/components/search-pages-control";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * 浏览器采集端的配对信息。
 *
 * 密钥只是为了挡住「随便一个网页也能往 localhost 投数据」——
 * 它既不能登录闲鱼，也动不了你的商品，所以可以放心贴进扩展里。
 */
export function CollectorCard({
  token,
  searchPages,
}: {
  token: string;
  searchPages: number;
}) {
  const [shown, setShown] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`已复制${label}。`);
    } catch {
      toast.error("浏览器不让复制，手动选中吧。");
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <CardTitle className="text-base">浏览器采集端</CardTitle>
          <CardDescription>
            装上 <code className="font-mono">tools/xianyu-collector</code> 这个扩展，
            在闲鱼搜索页点一下会按下面设定的页数连翻投进研究里，商详只采当前页，不用再手动粘贴快照。
          </CardDescription>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await regenerateCollectorToken();
              toast[result.ok ? "success" : "error"](result.message);
              setShown(false);
              router.refresh();
            })
          }
        >
          换一把密钥
        </Button>
      </CardHeader>

      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-16 shrink-0 text-xs text-muted-foreground">地址</span>
          <code className="rounded border bg-muted/40 px-2 py-1 font-mono text-xs">
            http://localhost:43117
          </code>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => copy("http://localhost:43117", "地址")}
          >
            复制
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="w-16 shrink-0 text-xs text-muted-foreground">采集密钥</span>
          <code className="rounded border bg-muted/40 px-2 py-1 font-mono text-xs break-all">
            {shown ? token : "•".repeat(16)}
          </code>
          <Button size="sm" variant="ghost" onClick={() => setShown(!shown)}>
            {shown ? "隐藏" : "显示"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => copy(token, "采集密钥")}>
            复制
          </Button>
        </div>

        <SearchPagesControl value={searchPages} />

        <p className="text-xs text-muted-foreground">
          搜索页会在你已经打开的闲鱼标签里点「下一页」，连采 {searchPages}{" "}
          页；扩展不自己发闲鱼接口。时间线的密度仍然等于你回访的密度。
        </p>
      </CardContent>
    </Card>
  );
}
