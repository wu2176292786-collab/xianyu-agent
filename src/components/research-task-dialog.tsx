"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { createResearchTask } from "@/app/actions";
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
import type { Listing } from "@/lib/domain/types";

const EMPTY = {
  name: "",
  keyword: "",
  mustInclude: "",
  mustExclude: "",
  linkedListingId: "",
  revisitHours: "48",
};

export function ResearchTaskDialog({ listings }: { listings: Listing[] }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

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

  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
      setForm((prev) => ({ ...prev, [key]: event.target.value })),
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
              「统一规格」决定谁能进价格带：命中任一「必须不含」判为不同款，
              命中全部「必须含」判为可比，其余一律存疑。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="rt-name">任务名称</Label>
              <Input
                id="rt-name"
                placeholder="Switch OLED 同款盯价"
                {...field("name")}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="rt-keyword">搜索关键词</Label>
              <Input
                id="rt-keyword"
                placeholder="switch oled 白色"
                {...field("keyword")}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="rt-include">必须含</Label>
                <Input
                  id="rt-include"
                  placeholder="OLED 白色"
                  {...field("mustInclude")}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rt-exclude">必须不含</Label>
                <Input
                  id="rt-exclude"
                  placeholder="续航版 破解"
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
              disabled={pending}
            >
              取消
            </Button>
            <Button onClick={submit} disabled={pending}>
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
