/**
 * Next 在服务端启动时调用一次，用来把后台巡检跑起来。
 * 构建阶段和 Edge Runtime 下都不需要。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const { startAgentScheduler } = await import("@/lib/agent/scheduler");
  startAgentScheduler();
}
