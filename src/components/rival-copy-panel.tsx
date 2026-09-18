"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { fetchRivalCopy, polishRivalCopy } from "@/app/actions";
import { Button } from "@/components/ui/button";
import type { ExtractionLayer, RivalListing } from "@/lib/domain/types";
import { rivalCopyText } from "@/lib/research/copy";
import { displayImageUrls } from "@/lib/research/snapshot";

const LAYER_LABEL: Record<ExtractionLayer, string> = {
  api: "页面接口",
  hydration: "内嵌 JSON",
  dom: "可见文字",
};

export async function copyText(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`已复制${label}。`);
  } catch {
    toast.error("浏览器不让复制，手动选中吧。");
  }
}

export function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function RivalCover({
  rival,
  className,
}: {
  rival: RivalListing;
  className?: string;
}) {
  const cover = displayImageUrls(rival.imageUrls)[0];
  if (!cover) {
    return (
      <div
        className={
          className ??
          "flex h-14 w-14 shrink-0 items-center justify-center rounded-md border bg-muted text-[10px] text-muted-foreground"
        }
      >
        无图
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={cover}
      alt=""
      referrerPolicy="no-referrer"
      className={
        className ??
        "h-14 w-14 shrink-0 rounded-md border object-cover"
      }
    />
  );
}

export function RivalCopyPanel({
  rival,
  llmConfigured,
  llmModel,
  onDone,
  onCollapse,
}: {
  rival: RivalListing;
  llmConfigured: boolean;
  llmModel?: string;
  onDone: () => void;
  onCollapse?: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const original = rivalCopyText(rival);
  const images = displayImageUrls(rival.imageUrls);

  // 展开面板不自动去开商详 —— 那会当场启动一个浏览器，还绕过了限速。
  // 正文和图交给后台那条限速队列补，急着要就点下面的按钮。

  return (
    <div className="space-y-3">
      {images.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {images.map((url) => (
            <a key={url} href={url} target="_blank" rel="noreferrer">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={url}
                alt=""
                referrerPolicy="no-referrer"
                className="h-16 w-16 rounded-md border object-cover"
              />
            </a>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          这件还没有图。后台那轮商详会补上，也可以用采集端进商品页点一次。
        </p>
      )}

      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">
          原文
          {rival.copyFrom ? ` · ${LAYER_LABEL[rival.copyFrom]}` : ""}
          {rival.copy ? "" : pending ? " · 正在去商详拉正文" : " · 只有标题"}
        </p>
        <pre className="max-h-56 max-w-full overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-md border bg-background px-3 py-2 text-xs">
          {original}
        </pre>
      </div>

      {rival.polishedCopy ? (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            AI 润色稿{llmModel ? ` · ${llmModel}` : ""}
          </p>
          <pre className="max-h-40 max-w-full overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-md border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-xs">
            {rival.polishedCopy}
          </pre>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-1">
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await fetchRivalCopy(rival.id);
              toast[result.ok ? "success" : "error"](result.message);
              if (result.ok) onDone();
            })
          }
        >
          {pending && !rival.copy ? "拉取正文中…" : "重新拉取正文"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => copyText(original, "原文")}>
          复制原文
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            images.length > 0
              ? // 图链已经在库里，复制它不碰闲鱼
                copyText(images.join("\n"), `${images.length} 条图链`)
              : toast.error("这件还没有图。后台那轮商详会补上，或者用采集端进商品页点一次。")
          }
        >
          复制图链
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!rival.polishedCopy}
          onClick={() =>
            rival.polishedCopy
              ? copyText(rival.polishedCopy, "润色稿")
              : undefined
          }
        >
          复制润色稿
        </Button>
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              if (!llmConfigured) {
                toast.error("还没配置 OPENAI_API_KEY，没法润色。");
                return;
              }
              const result = await polishRivalCopy(rival.id);
              toast[result.ok ? "success" : "error"](result.message);
              if (result.ok) onDone();
            })
          }
        >
          {pending ? "润色中…" : "AI 润色"}
        </Button>
        {onCollapse ? (
          <Button size="sm" variant="outline" onClick={onCollapse}>
            收起
          </Button>
        ) : null}
      </div>
    </div>
  );
}
