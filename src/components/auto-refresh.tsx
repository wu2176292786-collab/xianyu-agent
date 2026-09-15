"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * 后台巡检是在服务端悄悄跑的，页面不主动刷新就看不到变化。
 * 这里定期拉一次最新的服务端渲染结果，不打扰正在操作的人。
 */
export function AutoRefresh({ seconds = 30 }: { seconds?: number }) {
  const router = useRouter();

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => clearInterval(timer);
  }, [router, seconds]);

  return null;
}
