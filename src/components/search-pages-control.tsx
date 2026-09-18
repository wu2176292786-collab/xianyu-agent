"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { updateSearchPages } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  MAX_SEARCH_PAGES,
  MIN_SEARCH_PAGES,
} from "@/lib/research/search-pager";

export function SearchPagesControl({ value }: { value: number }) {
  return <SearchPagesControlForm key={value} value={value} />;
}

function SearchPagesControlForm({ value }: { value: number }) {
  const [pages, setPages] = useState(String(value));
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const save = () => {
    startTransition(async () => {
      const result = await updateSearchPages(Number(pages));
      toast[result.ok ? "success" : "error"](result.message);
      if (result.ok) router.refresh();
    });
  };

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="space-y-1">
        <Label htmlFor="search-pages" className="text-xs text-muted-foreground">
          每次搜索页数
        </Label>
        <Input
          id="search-pages"
          type="number"
          min={MIN_SEARCH_PAGES}
          max={MAX_SEARCH_PAGES}
          step={1}
          className="h-8 w-20"
          value={pages}
          disabled={pending}
          onChange={(event) => setPages(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              save();
            }
          }}
        />
      </div>
      <Button size="sm" variant="outline" disabled={pending} onClick={save}>
        保存
      </Button>
    </div>
  );
}
