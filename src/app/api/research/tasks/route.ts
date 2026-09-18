import { NextResponse } from "next/server";
import { researchDueCount } from "@/lib/research/analysis";
import { clampWatchIntervalHours } from "@/lib/research/heat";
import { ensureCollectorToken, verifyCollectorToken } from "@/lib/research/collector";
import { clampSearchPages } from "@/lib/research/search-pager";
import {
  insertKeywordTask,
  parseCreateTaskBody,
  parseDeleteTaskBody,
  removeResearchTaskFromState,
} from "@/lib/research/task-write";
import { getState, mutateState } from "@/lib/store";

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
      due: researchDueCount(
        task,
        state.research.rivals,
        now,
        clampWatchIntervalHours(state.research.watchIntervalHours),
      ),
    }));

  return NextResponse.json({
    ok: true,
    tasks,
    searchPages: clampSearchPages(state.research.searchPages),
  });
}

async function readJson(request: Request): Promise<
  { ok: true; body: unknown } | { ok: false; response: NextResponse }
> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ ok: false, message: "请求体不是合法 JSON。" }, { status: 400 }),
    };
  }
}

/**
 * 采集端新建一个关键词研究任务。只要名字，规格之后在应用里改。
 */
export async function POST(request: Request) {
  const raw = await readJson(request);
  if (!raw.ok) return raw.response;

  const parsed = parseCreateTaskBody(raw.body);
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, message: parsed.message }, { status: 400 });
  }

  const result = await mutateState((state) => {
    if (!verifyCollectorToken(ensureCollectorToken(state), parsed.token)) {
      return { status: 401, ok: false, message: "采集密钥不对。" };
    }
    const created = insertKeywordTask(state, { name: parsed.name }, Date.now());
    return { status: created.ok ? 200 : 400, ...created };
  });

  return NextResponse.json(
    {
      ok: result.ok,
      message: result.message,
      taskId: "taskId" in result ? result.taskId : undefined,
    },
    { status: result.status },
  );
}

/** 采集端删除一个研究任务，连同它下面的同行一起移出。 */
export async function DELETE(request: Request) {
  const raw = await readJson(request);
  if (!raw.ok) return raw.response;

  const parsed = parseDeleteTaskBody(raw.body);
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, message: parsed.message }, { status: 400 });
  }

  const result = await mutateState((state) => {
    if (!verifyCollectorToken(ensureCollectorToken(state), parsed.token)) {
      return { status: 401, ok: false, message: "采集密钥不对。" };
    }
    const removed = removeResearchTaskFromState(state, parsed.taskId, Date.now());
    return { status: removed.ok ? 200 : 404, ...removed };
  });

  return NextResponse.json({ ok: result.ok, message: result.message }, { status: result.status });
}
