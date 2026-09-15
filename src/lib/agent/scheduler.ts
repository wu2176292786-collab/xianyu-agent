import { mutateState } from "@/lib/store";
import { shouldRunScheduledTick } from "./engine";
import { performTick } from "./tick";

/** 多久检查一次「该不该巡检了」。真正的间隔由店铺设置决定。 */
const CHECK_INTERVAL_MS = 30_000;

declare global {
  var __xianyuAgentScheduler: NodeJS.Timeout | undefined;
}

async function tickIfDue(): Promise<void> {
  try {
    await mutateState((state) => {
      const now = Date.now();
      if (!shouldRunScheduledTick(state, now)) return;
      performTick(state, now, "scheduled");
    });
  } catch (error) {
    // 定时器里不能抛，否则整个进程会挂掉。
    console.error("[agent] 自动巡检出错：", error);
  }
}

/**
 * 启动后台巡检。
 *
 * 开发模式下 `register()` 可能被调用多次，用全局变量保证只有一个定时器；
 * `unref()` 让这个定时器不会拖住进程退出。
 */
export function startAgentScheduler(): void {
  if (globalThis.__xianyuAgentScheduler) return;

  const timer = setInterval(() => {
    void tickIfDue();
  }, CHECK_INTERVAL_MS);
  timer.unref?.();

  globalThis.__xianyuAgentScheduler = timer;
  console.log(`[agent] 后台巡检已启动，每 ${CHECK_INTERVAL_MS / 1000}s 检查一次是否到点。`);
}
