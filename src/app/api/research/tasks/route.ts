import { NextResponse } from "next/server";
import { revisitQueue } from "@/lib/research/analysis";
import { ensureCollectorToken, verifyCollectorToken } from "@/lib/research/collector";
import { getState } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * 给浏览器采集端列出可投的研究任务。
 *
 * 只回任务名和几个计数 —— 扩展需要知道往哪儿投，不需要知道店里的生意数据。
 */
export async function GET(request: Request) {
  const state = await getState();
  const token = new URL(request.url).searchParams.get("token");

  if (!verifyCollectorToken(ensureCollectorToken(state), token)) {
    return NextResponse.json({ ok: false, message: "采集密钥不对。" }, { status: 401 });
  }

  const now = Date.now();
  const tasks = state.research.tasks
    .filter((task) => task.status === "active")
    .map((task) => ({
      id: task.id,
      name: task.name,
      rivals: state.research.rivals.filter((r) => r.taskId === task.id).length,
      due: revisitQueue(task, state.research.rivals, now).length,
    }));

  return NextResponse.json({ ok: true, tasks });
}
