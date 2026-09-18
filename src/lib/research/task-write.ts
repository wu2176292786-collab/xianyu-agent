import type { AppState, ResearchTask } from "@/lib/domain/types";
import { logActivity } from "@/lib/store";

const MAX_TASK_NAME = 40;
const DEFAULT_REVISIT_HOURS = 48;

export function parseCreateTaskBody(
  body: unknown,
): { ok: true; token: string; name: string } | { ok: false; message: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, message: "请求体必须是 JSON 对象。" };
  }
  const record = body as Record<string, unknown>;
  if (typeof record.token !== "string" || !record.token) {
    return { ok: false, message: "缺少采集密钥。" };
  }
  if (typeof record.name !== "string") {
    return { ok: false, message: "给这个研究任务起个名字。" };
  }
  const name = record.name.trim();
  if (!name) return { ok: false, message: "给这个研究任务起个名字。" };
  if (name.length > MAX_TASK_NAME) {
    return { ok: false, message: `名字请控制在 ${MAX_TASK_NAME} 字以内。` };
  }
  return { ok: true, token: record.token, name };
}

export function parseDeleteTaskBody(
  body: unknown,
): { ok: true; token: string; taskId: string } | { ok: false; message: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, message: "请求体必须是 JSON 对象。" };
  }
  const record = body as Record<string, unknown>;
  if (typeof record.token !== "string" || !record.token) {
    return { ok: false, message: "缺少采集密钥。" };
  }
  if (typeof record.taskId !== "string" || !record.taskId) {
    return { ok: false, message: "缺少研究任务 id。" };
  }
  return { ok: true, token: record.token, taskId: record.taskId };
}

export function insertKeywordTask(
  state: AppState,
  input: { name: string; keyword?: string; revisitHours?: number },
  now: number,
): { ok: true; message: string; taskId: string } | { ok: false; message: string } {
  const name = input.name.trim();
  if (!name) return { ok: false, message: "给这个研究任务起个名字。" };
  if (name.length > MAX_TASK_NAME) {
    return { ok: false, message: `名字请控制在 ${MAX_TASK_NAME} 字以内。` };
  }
  const hours = input.revisitHours ?? DEFAULT_REVISIT_HOURS;
  if (!Number.isFinite(hours) || hours < 1 || hours > 720) {
    return { ok: false, message: "回访间隔请填 1~720 小时。" };
  }

  const task: ResearchTask = {
    id: `RT${now.toString(36).toUpperCase()}`,
    name,
    keyword: (input.keyword ?? "").trim(),
    kind: "keyword",
    mustInclude: [],
    mustExclude: [],
    revisitHours: hours,
    status: "active",
    createdAt: new Date(now).toISOString(),
  };
  state.research.tasks.unshift(task);
  logActivity(state, "human", `新建选品研究「${name}」。`, now);
  return { ok: true, message: `已新建研究任务「${name}」。`, taskId: task.id };
}

export function removeResearchTaskFromState(
  state: AppState,
  taskId: string,
  now: number,
): { ok: true; message: string } | { ok: false; message: string } {
  const index = state.research.tasks.findIndex((task) => task.id === taskId);
  if (index < 0) return { ok: false, message: "找不到这个研究任务。" };

  const [removed] = state.research.tasks.splice(index, 1);
  if (!removed) return { ok: false, message: "找不到这个研究任务。" };

  const before = state.research.rivals.length;
  state.research.rivals = state.research.rivals.filter((rival) => rival.taskId !== taskId);
  const dropped = before - state.research.rivals.length;
  logActivity(
    state,
    "human",
    dropped > 0
      ? `删除研究任务「${removed.name}」，一并移出 ${dropped} 件。`
      : `删除研究任务「${removed.name}」。`,
    now,
  );
  return {
    ok: true,
    message:
      dropped > 0
        ? `已删除「${removed.name}」，一并移出 ${dropped} 件。`
        : `已删除「${removed.name}」。`,
  };
}
