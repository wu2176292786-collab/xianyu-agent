"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { createResearchTask, draftResearchTaskRules } from "@/app/actions";
import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import type { Listing } from "@/lib/domain/types";

const EMPTY = {
  prompt: "",
  name: "",
  keyword: "",
  mustInclude: "",
  mustExclude: "",
  linkedListingId: "",
  revisitHours: "48",
};

export function ResearchTaskDialog({
  listings,
  llmConfigured = false,
}: {
  listings: Listing[];
  llmConfigured?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [pending, startTransition] = useTransition();
  const [drafting, startDraft] = useTransition();
  const router = useRouter();
  const busy = pending || drafting;

  const submit = () =>
    startTransition(async () => {
      const result = await createResearchTask(form);
      toast[result.ok ? "success" : "error"](result.message);
      if (result.ok) {
        setForm(EMPTY);
        setOpen(false);
        router.refresh();
      }
    });

  const fillFromModel = () =>
    startDraft(async () => {
      const result = await draftResearchTaskRules({
        prompt: form.prompt,
        linkedListingId: form.linkedListingId || undefined,
      });
      if (!result.ok || !result.draft) {
        toast.error(result.message);
        return;
      }
      const draft = result.draft;
      setForm((prev) => ({
        ...prev,
        name: draft.name,
        keyword: draft.keyword,
        mustInclude: draft.mustInclude.join(" "),
        mustExclude: draft.mustExclude.join(" "),
      }));
      toast.success(result.message);
    });

  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => setForm((prev) => ({ ...prev, [key]: event.target.value })),
  });

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        新建研究任务
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>新建选品研究</DialogTitle>
            <DialogDescription>
              创建任务只是开一个文件夹。同行要从闲鱼页面用采集端投进来，
              不会在后台自动搜索。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="rt-prompt">用一句话说你想找什么</Label>
              <Textarea
                id="rt-prompt"
                placeholder="我想找卖 AI 智能体课程的，不要卖教材和书的"
                rows={3}
                disabled={busy}
                {...field("prompt")}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy || !llmConfigured}
                  onClick={fillFromModel}
                >
                  {drafting ? "正在填…" : "让模型填"}
                </Button>
                <p className="text-xs text-muted-foreground">
                  {llmConfigured
                    ? "填进下面的格子，确认后再创建。"
                    : "还没配置模型，请手填。"}
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="rt-name">任务名称</Label>
              <Input
                id="rt-name"
                placeholder="Switch OLED 同款盯价"
                disabled={busy}
                {...field("name")}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="rt-keyword">你准备在闲鱼搜的词</Label>
              <Input
                id="rt-keyword"
                placeholder="switch oled 白色"
                disabled={busy}
                {...field("keyword")}
              />
              <p className="text-xs text-muted-foreground">
                只是提醒你去搜什么，应用不会替你搜。
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="rt-include">必须含</Label>
                <Input
                  id="rt-include"
                  placeholder="OLED 白色"
                  disabled={busy}
                  {...field("mustInclude")}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rt-exclude">必须不含</Label>
                <Input
                  id="rt-exclude"
                  placeholder="可选，如 日版 配件"
                  disabled={busy}
                  {...field("mustExclude")}
                />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="rt-listing">对标本店商品</Label>
                <select
                  id="rt-listing"
                  className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                  value={form.linkedListingId}
                  disabled={busy}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      linkedListingId: event.target.value,
                    }))
                  }
                >
                  <option value="">暂不绑定</option>
                  {listings.map((listing) => (
                    <option key={listing.id} value={listing.id}>
                      {listing.title.slice(0, 24)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rt-revisit">回访间隔（小时）</Label>
                <Input
                  id="rt-revisit"
                  inputMode="numeric"
                  disabled={busy}
                  {...field("revisitHours")}
                />
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              关键词用空格或逗号分隔。判定只看标题文字，不看图 ——
              拿不准就是存疑， 存疑的同行不进价格带。
            </p>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={busy}
            >
              取消
            </Button>
            <Button onClick={submit} disabled={busy}>
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
