import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_ACTIVITY } from "@/lib/domain/limits";
import { pruneState } from "@/lib/domain/prune";
import { createSeedState } from "@/lib/domain/seed";
import type { ActivityEntry, ActivityKind, AppState } from "@/lib/domain/types";

/**
 * v1 用一个 JSON 文件当数据库：零依赖、零凭证，`npm run dev` 就能跑起来。
 *
 * 热数据常驻内存；磁盘只在变更后写回。外部进程改了文件（e2e 还原、
 * 脚本直写）时，靠 mtime 把缓存作废。
 *
 * 以后换本机 SQLite 时，只替换本文件的读写实现，
 * 业务继续走 getState / mutateState。
 */
const SCHEMA_VERSION = 4;

interface StoredFile {
  version: number;
  state: AppState;
}

function dataFile(): string {
  return (
    process.env.XIANYU_STATE_FILE ??
    path.join(process.cwd(), ".data", "state.json")
  );
}

/** 同一进程内串行化读写，避免并发操作互相覆盖。 */
let queue: Promise<unknown> = Promise.resolve();
let cached: AppState | null = null;
let cachedMtimeMs = 0;
let dirty = false;

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function fileMtime(file: string): Promise<number> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return 0;
  }
}

async function persist(state: AppState): Promise<void> {
  pruneState(state);
  const file = dataFile();
  const payload: StoredFile = { version: SCHEMA_VERSION, state };
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
  await rename(tmp, file);
  cached = state;
  cachedMtimeMs = await fileMtime(file);
  dirty = false;
}

async function readFromDisk(): Promise<AppState | null> {
  try {
    const raw = await readFile(dataFile(), "utf8");
    const parsed = JSON.parse(raw) as StoredFile;
    if (parsed.version === SCHEMA_VERSION && parsed.state) {
      pruneState(parsed.state);
      return parsed.state;
    }
  } catch {
    // 文件不存在或已损坏 —— 调用方去播种。
  }
  return null;
}

async function load(): Promise<AppState> {
  const file = dataFile();
  if (cached) {
    if (dirty) return cached;
    const mtime = await fileMtime(file);
    if (mtime > 0 && mtime === cachedMtimeMs) return cached;
  }

  const fromDisk = await readFromDisk();
  if (fromDisk) {
    cached = fromDisk;
    cachedMtimeMs = await fileMtime(file);
    dirty = false;
    return fromDisk;
  }

  const seeded = createSeedState();
  dirty = true;
  await persist(seeded);
  return seeded;
}

export function getState(): Promise<AppState> {
  return enqueue(load);
}

/** 改内存 → 标脏 → 落盘。读路径不再碰磁盘。 */
export function mutateState<T>(fn: (state: AppState) => T | Promise<T>): Promise<T> {
  return enqueue(async () => {
    const state = await load();
    const result = await fn(state);
    cached = state;
    dirty = true;
    await persist(state);
    return result;
  });
}

export function resetState(): Promise<AppState> {
  return enqueue(async () => {
    const seeded = createSeedState();
    cached = seeded;
    dirty = true;
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
  state.activity = state.activity.slice(0, MAX_ACTIVITY);
  return entry;
}
