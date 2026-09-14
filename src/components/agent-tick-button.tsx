"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { runAgentTick } from "@/app/actions";
import { Button } from "@/components/ui/button";

export function AgentTickButton({
  className,
  size = "default",
}: {
  className?: string;
  size?: "default" | "sm" | "lg";
}) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <Button
      size={size}
      className={className}
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await runAgentTick();
          toast[result.ok ? "success" : "error"](result.message);
          router.refresh();
        })
      }
    >
      {pending ? "Agent 正在巡检…" : "运行 Agent"}
    </Button>
  );
}
