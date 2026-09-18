import { mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_RUNS } from "@/lib/domain/limits";
import { pruneState } from "@/lib/domain/prune";
import { createSeedState } from "@/lib/domain/seed";

async function openStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "xianyu-store-"));
  const file = path.join(dir, "state.json");
  vi.resetModules();
  process.env.XIANYU_STATE_FILE = file;
  const store = await import("@/lib/store");
  return { file, store };
}

afterEach(() => {
  delete process.env.XIANYU_STATE_FILE;
  vi.resetModules();
});

describe("内存缓存", () => {
  it("首次读取会播种，之后同一份热数据常驻", async () => {
    const { file, store } = await openStore();
    const first = await store.getState();
    const second = await store.getState();

    expect(first.settings.shopName).toBeTruthy();
    expect(second).toBe(first);
    const raw = JSON.parse(await readFile(file, "utf8")) as {
      version: number;
      state: { settings: { shopName: string } };
    };
    expect(raw.version).toBe(4);
    expect(raw.state.settings.shopName).toBe(first.settings.shopName);
  });

  it("变更后写回磁盘，读路径仍用同一份内存", async () => {
    const { file, store } = await openStore();
    await store.getState();
    const after = await store.mutateState((state) => {
      state.settings.shopName = "缓存店";
      return state.settings.shopName;
    });
    const again = await store.getState();

    expect(after).toBe("缓存店");
    expect(again.settings.shopName).toBe("缓存店");
    expect(again).toBe(await store.getState());
    const raw = JSON.parse(await readFile(file, "utf8")) as {
      state: { settings: { shopName: string } };
    };
    expect(raw.state.settings.shopName).toBe("缓存店");
  });

  it("外部改了文件会按 mtime 作废缓存", async () => {
    const { file, store } = await openStore();
    await store.getState();
    const raw = JSON.parse(await readFile(file, "utf8")) as {
      version: number;
      state: { settings: { shopName: string } };
    };
    raw.state.settings.shopName = "外部改过";
    await writeFile(file, JSON.stringify(raw, null, 2), "utf8");
    const later = new Date(Date.now() + 2000);
    await utimes(file, later, later);

    const next = await store.getState();
    expect(next.settings.shopName).toBe("外部改过");
  });
});

describe("落盘前裁剪", () => {
  it("巡检记录裁回上限", () => {
    const state = createSeedState(1_700_000_000_000);
    state.runs = Array.from({ length: MAX_RUNS + 10 }, (_, index) => ({
      id: `R${index}`,
      at: new Date(1_700_000_000_000 + index).toISOString(),
      trigger: "manual",
      queued: 0,
      applied: 0,
      failed: 0,
      skipped: 0,
      durationMs: 1,
    }));

    pruneState(state);
    expect(state.runs).toHaveLength(MAX_RUNS);
  });
});
