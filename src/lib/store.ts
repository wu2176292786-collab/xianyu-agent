import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createSeedState } from "@/lib/domain/seed";
import type { ActivityEntry, ActivityKind, AppState } from "@/lib/domain/types";

/**
 * v1 用一个 JSON 文件当数据库：零依赖、零凭证，`npm run dev` 就能跑起来。
 * 换成真实数据库时只需要替换本文件的读写实现。
 */
const SCHEMA_VERSION = 1;

interface StoredFile {
  version: number;
  state: AppState;
}

const DATA_FILE = path.join(process.cwd(), ".data", "state.json");

/** 同一进程内串行化写入，避免并发操作互相覆盖。 */
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function persist(state: AppState): Promise<void> {
  const payload: StoredFile = { version: SCHEMA_VERSION, state };
  await mkdir(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
  await rename(tmp, DATA_FILE);
}

async function load(): Promise<AppState> {
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw) as StoredFile;
    if (parsed.version === SCHEMA_VERSION && parsed.state) {
      return parsed.state;
    }
  } catch {
    // 文件不存在或已损坏 —— 重新播种。
  }
  const seeded = createSeedState();
  await persist(seeded);
  return seeded;
}

export function getState(): Promise<AppState> {
  return enqueue(load);
}

/** 读取 → 修改 → 落盘，整个过程串行执行。 */
export function mutateState<T>(fn: (state: AppState) => T | Promise<T>): Promise<T> {
  return enqueue(async () => {
    const state = await load();
    const result = await fn(state);
    await persist(state);
    return result;
  });
}

export function resetState(): Promise<AppState> {
  return enqueue(async () => {
    const seeded = createSeedState();
    await persist(seeded);
    return seeded;
  });
}

export function logActivity(
  state: AppState,
  kind: ActivityKind,
  text: string,
  now = Date.now(),
): ActivityEntry {
  const entry: ActivityEntry = {
    id: `A${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    at: new Date(now).toISOString(),
    kind,
    text,
  };
  state.activity.unshift(entry);
  state.activity = state.activity.slice(0, 200);
  return entry;
}
