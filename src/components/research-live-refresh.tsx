"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

const INTERVAL_MS = 1500;

/**
 * 采集端在闲鱼标签页里投数据，研究页收不到那次 POST。
 * 可见时轮询短戳，变了才 refresh，避免把展开的文案折回去。
 */
export function ResearchLiveRefresh({ taskId }: { taskId?: string }) {
  const router = useRouter();
  const stamp = useRef<string | null>(null);

  useEffect(() => {
    if (!taskId) return;
    document.getElementById(`research-task-${taskId}`)?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  }, [taskId]);

  useEffect(() => {
    let cancelled = false;

    const pull = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const response = await fetch("/api/research/pulse", { cache: "no-store" });
        const data = (await response.json()) as { ok?: boolean; stamp?: string };
        if (cancelled || !data.ok || !data.stamp) return;
        if (stamp.current === null) {
          stamp.current = data.stamp;
          return;
        }
        if (data.stamp !== stamp.current) {
          stamp.current = data.stamp;
          router.refresh();
        }
      } catch {
        // 开发服务器重启时下一轮再问
      }
    };

    const timer = setInterval(() => {
      void pull();
    }, INTERVAL_MS);
    document.addEventListener("visibilitychange", pull);
    window.addEventListener("focus", pull);
    void pull();

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", pull);
      window.removeEventListener("focus", pull);
    };
  }, [router]);

  return null;
}
