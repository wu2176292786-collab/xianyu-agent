"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { decideAllPending } from "@/app/actions";
import { Button } from "@/components/ui/button";

export function BatchDecideButtons({ disabled }: { disabled?: boolean }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const run = (decision: "approve" | "reject") =>
    startTransition(async () => {
      const result = await decideAllPending(decision);
      toast[result.ok ? "success" : "error"](result.message);
      router.refresh();
    });

  return (
    <div className="flex gap-2">
      <Button size="sm" disabled={disabled || pending} onClick={() => run("approve")}>
        全部通过
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || pending}
        onClick={() => run("reject")}
      >
        全部忽略
      </Button>
    </div>
  );
}
