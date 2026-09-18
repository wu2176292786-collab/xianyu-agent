import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ItemHeat } from "@/lib/research/browse-item";

/**
 * 批量补热度的循环：一件一件来、撞风控当场停手、剩下的留到下一轮。
 *
 * 用假的浏览器会话驱动，不联网；间隔传 0，不用真等几秒。
 */
async function openWorld() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "xianyu-heat-"));
  process.env.XIANYU_STATE_FILE = path.join(dir, "state.json");
  vi.resetModules();
  const store = await import("@/lib/store");
  const pull = await import("@/lib/research/pull");

  await store.mutateState((state) => {
    state.channel.read = "live";
    state.research.tasks = [
      {
        id: "T1",
        name: "同类",
        keyword: "智能体",
        mustInclude: [],
        mustExclude: [],
        revisitHours: 24,
        status: "active",
        createdAt: new Date().toISOString(),
      },
    ];
    state.research.rivals = ["A", "B", "C", "D"].map((tag, index) => ({
      id: `R${tag}`,
      taskId: "T1",
      itemId: `90000${index}`,
      title: `同行 ${tag}`,
      url: `https://www.goofish.com/item?id=90000${index}`,
      addedAt: new Date().toISOString(),
      alignment: "comparable" as const,
      alignmentBy: "auto" as const,
      observations: [],
    }));
  });

  return { store, pull };
}

/** 按 itemId 给不同结果的假会话，并记下打开顺序。 */
function fakeBrowser(script: Record<string, ItemHeat | undefined>) {
  const opened: string[] = [];
  return {
    opened,
    session: {
      readItemHeat: async (itemId: string) => {
        opened.push(itemId);
        return script[itemId];
      },
      close: async () => undefined,
    },
  };
}

afterEach(() => {
  delete process.env.XIANYU_STATE_FILE;
  vi.resetModules();
});

describe("批量补热度", () => {
  it("一件一件读下来，读到的记账，没读到的也照样往下走", async () => {
    const { pull } = await openWorld();
    const browser = fakeBrowser({
      "900000": { wants: 10, views: 133 },
      "900001": undefined,
      "900002": { wants: 3, views: 40 },
    });

    const outcome = await pull.pullHeatSequence(
      browser.session,
      ["RA", "RB", "RC"],
      () => 0,
    );

    expect(outcome).toEqual({ filled: 2, missed: 1, risk: false });
    expect(browser.opened).toEqual(["900000", "900001", "900002"]);
  });

  it("撞风控当场停手，后面的不再打开", async () => {
    const { pull } = await openWorld();
    const browser = fakeBrowser({
      "900000": { wants: 10, views: 133 },
      "900001": { risk: true },
      "900002": { wants: 3, views: 40 },
    });

    const outcome = await pull.pullHeatSequence(
      browser.session,
      ["RA", "RB", "RC"],
      () => 0,
    );

    expect(outcome).toEqual({ filled: 1, missed: 0, risk: true });
    // 第三件根本没被打开
    expect(browser.opened).toEqual(["900000", "900001"]);
  });

  it("撞风控会记下暂停，并把已经补上的件数写进日志", async () => {
    const { store, pull } = await openWorld();
    const browser = fakeBrowser({
      "900000": { wants: 10, views: 133 },
      "900001": { risk: true },
    });

    await pull.pullHeatSequence(browser.session, ["RA", "RB"], () => 0);

    const state = await store.getState();
    expect(state.research.heatPull?.pauseUntil).toBeTruthy();
    expect(state.activity.some((line) => line.text.includes("已采 1 件"))).toBe(true);
  });

  it("「网络不见了」算没读到，不会停手也不会进暂停", async () => {
    const { store, pull } = await openWorld();
    const browser = fakeBrowser({
      "900000": { blank: true },
      "900001": { wants: 7, views: 88 },
    });

    const outcome = await pull.pullHeatSequence(browser.session, ["RA", "RB"], () => 0);

    expect(outcome).toEqual({ filled: 1, missed: 1, risk: false });
    const state = await store.getState();
    expect(state.research.heatPull?.pauseUntil).toBeUndefined();
  });

  it("读到的热度要真的落成商详观察", async () => {
    const { store, pull } = await openWorld();
    const browser = fakeBrowser({ "900000": { wants: 10, views: 133 } });

    await pull.pullHeatSequence(browser.session, ["RA"], () => 0);

    const state = await store.getState();
    const rival = state.research.rivals.find((item) => item.id === "RA");
    expect(rival?.observations).toHaveLength(1);
    expect(rival?.observations[0]).toMatchObject({
      source: "detail",
      wants: 10,
      views: 133,
    });
  });
});
