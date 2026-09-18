import { beforeEach, describe, expect, it } from "vitest";
import {
  GuardedAdapter,
  checkWriteBudget,
  pauseWrites,
  resumeWrites,
} from "@/lib/adapters/guard";
import { mockAdapter } from "@/lib/adapters/mock";
import type { AdapterResult, XianyuAdapter } from "@/lib/adapters/types";
import { runTick } from "@/lib/agent/engine";
import { createSeedState } from "@/lib/domain/seed";
import type { AppState } from "@/lib/domain/types";

const NOW = Date.parse("2026-01-10T12:00:00.000Z");

/** 固定返回某个结果的写通道，用来构造风控 / 连续失败场景。 */
function stubAdapter(result: AdapterResult): XianyuAdapter {
  const op = () => result;
  return {
    id: "stub",
    label: "测试通道",
    isMock: true,
    refreshListing: op,
    updatePrice: op,
    delistListing: op,
    sendMessage: op,
    shipOrder: op,
  };
}

function firstOnSale(state: AppState): string {
  return state.listings.find((l) => l.status === "on_sale")!.id;
}

describe("急停", () => {
  let state: AppState;

  beforeEach(() => {
    state = createSeedState(NOW);
  });

  it("急停之后所有写操作都被拒绝", async () => {
    const guarded = new GuardedAdapter(mockAdapter);
    pauseWrites(state, "我按的", "human", NOW);

    const before = state.listings.find((l) => l.id === firstOnSale(state))!.lastRefreshedAt;
    const result = await guarded.refreshListing(state, firstOnSale(state), NOW);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("已急停");
    // 真的没动过
    expect(state.listings.find((l) => l.id === firstOnSale(state))!.lastRefreshedAt).toBe(
      before,
    );
  });

  it("解除急停后恢复，并清掉连续失败计数", () => {
    state.safety.consecutiveFailures = 2;
    pauseWrites(state, "test", "failures", NOW);
    resumeWrites(state);

    expect(state.safety.paused).toBe(false);
    expect(state.safety.pausedReason).toBeUndefined();
    expect(state.safety.consecutiveFailures).toBe(0);
    expect(checkWriteBudget(state, NOW).ok).toBe(true);
  });

  it("巡检遇到急停就整轮跳过，不会把动作塞进失败队列", async () => {
    pauseWrites(state, "我按的", "human", NOW);
    const result = await runTick(state, new GuardedAdapter(mockAdapter), NOW);

    expect(result.applied).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect(result.skipped).toBeGreaterThan(0);
    expect(result.skipReason).toContain("已急停");
    // 需要审批的建议照常产生 —— 急停拦的是写操作，不是思考
    expect(result.queued.length).toBeGreaterThan(0);
  });
});

describe("演练模式", () => {
  let state: AppState;

  beforeEach(() => {
    state = createSeedState(NOW);
    state.channel.write = "dry_run";
  });

  it("只记录不执行", async () => {
    const guarded = new GuardedAdapter(mockAdapter);
    const listingId = firstOnSale(state);
    const before = state.listings.find((l) => l.id === listingId)!.lastRefreshedAt;

    const result = await guarded.refreshListing(state, listingId, NOW);

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.message).toContain("演练");
    expect(state.listings.find((l) => l.id === listingId)!.lastRefreshedAt).toBe(before);
  });

  it("演练执行的动作会被标记出来", async () => {
    state.channel.minWriteIntervalMs = 0;
    const result = await runTick(state, new GuardedAdapter(mockAdapter), NOW);

    expect(result.applied.length).toBeGreaterThan(0);
    expect(result.applied.every((a) => a.dryRun === true)).toBe(true);
    // 零库存的 Kindle 本该被下架，演练模式下状态不能变
    expect(state.listings.find((l) => l.id === "L008")!.status).toBe("on_sale");
  });

  it("真实写入不再被预算拦下，会走到内层通道", async () => {
    state.channel.write = "live";
    state.channel.minWriteIntervalMs = 0;
    expect(checkWriteBudget(state, NOW).ok).toBe(true);
    const result = await new GuardedAdapter(mockAdapter).refreshListing(state, "L001", NOW);
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBeUndefined();
  });
});

describe("限流", () => {
  let state: AppState;

  beforeEach(() => {
    state = createSeedState(NOW);
    state.channel.write = "dry_run";
    state.channel.maxWritesPerMinute = 3;
    state.channel.minWriteIntervalMs = 0;
  });

  it("本地模拟模式不限流 —— 没有账号需要保护", async () => {
    state.channel.write = "mock";
    state.channel.maxWritesPerMinute = 1;
    const guarded = new GuardedAdapter(mockAdapter);
    for (let i = 0; i < 5; i += 1) {
      expect((await guarded.refreshListing(state, firstOnSale(state), NOW + i)).ok).toBe(true);
    }
  });

  it("一分钟内超过上限就拒绝", async () => {
    const guarded = new GuardedAdapter(mockAdapter);
    for (let i = 0; i < 3; i += 1) {
      expect((await guarded.refreshListing(state, "L001", NOW + i)).ok).toBe(true);
    }
    const blocked = await guarded.refreshListing(state, "L001", NOW + 4);
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toContain("限流");
  });

  it("窗口滑过去之后自动恢复", async () => {
    const guarded = new GuardedAdapter(mockAdapter);
    for (let i = 0; i < 3; i += 1) await guarded.refreshListing(state, "L001", NOW + i);
    expect((await guarded.refreshListing(state, "L001", NOW + 4)).ok).toBe(false);
    expect((await guarded.refreshListing(state, "L001", NOW + 61_000)).ok).toBe(true);
  });

  it("两次写操作之间的最小间隔也管用", async () => {
    state.channel.maxWritesPerMinute = 100;
    state.channel.minWriteIntervalMs = 1000;
    const guarded = new GuardedAdapter(mockAdapter);

    expect((await guarded.refreshListing(state, "L001", NOW)).ok).toBe(true);
    const tooSoon = await guarded.refreshListing(state, "L001", NOW + 200);
    expect(tooSoon.ok).toBe(false);
    expect(tooSoon.message).toContain("至少隔");
    expect((await guarded.refreshListing(state, "L001", NOW + 1200)).ok).toBe(true);
  });

  it("被限流的动作不会变成失败，下一轮会重新提出来", async () => {
    state.channel.maxWritesPerMinute = 1;
    const guarded = new GuardedAdapter(mockAdapter);

    const first = await runTick(state, guarded, NOW);
    expect(first.applied).toHaveLength(1);
    expect(first.skipped).toBeGreaterThan(0);
    expect(first.failed).toHaveLength(0);

    // 一分钟后额度回来了，上一轮没做的事还在
    const second = await runTick(state, guarded, NOW + 61_000);
    expect(second.applied.length).toBeGreaterThan(0);
  });
});

describe("风控与连续失败", () => {
  let state: AppState;

  beforeEach(() => {
    state = createSeedState(NOW);
    state.channel.write = "dry_run";
    state.channel.minWriteIntervalMs = 0;
  });

  it("通道报风控就立刻急停", async () => {
    state.channel.write = "mock";
    const guarded = new GuardedAdapter(
      stubAdapter({ ok: false, message: "出现滑块验证", riskControl: true }),
    );

    const result = await guarded.sendMessage(state, "C001", "你好", NOW);
    expect(result.ok).toBe(false);
    expect(state.safety.paused).toBe(true);
    expect(state.safety.pausedBy).toBe("risk_control");
    expect(state.safety.pausedReason).toContain("滑块");
  });

  it("连续失败到阈值自动急停，成功一次就清零", async () => {
    state.channel.write = "mock";
    state.channel.autoPauseAfterFailures = 3;
    const failing = new GuardedAdapter(stubAdapter({ ok: false, message: "网络超时" }));

    await failing.refreshListing(state, "L001", NOW);
    await failing.refreshListing(state, "L001", NOW + 1);
    expect(state.safety.paused).toBe(false);
    expect(state.safety.consecutiveFailures).toBe(2);

    await failing.refreshListing(state, "L001", NOW + 2);
    expect(state.safety.paused).toBe(true);
    expect(state.safety.pausedBy).toBe("failures");
    expect(state.safety.pausedReason).toContain("连续 3 次");

    resumeWrites(state);
    await new GuardedAdapter(mockAdapter).refreshListing(state, firstOnSale(state), NOW + 3);
    expect(state.safety.consecutiveFailures).toBe(0);
  });
});
