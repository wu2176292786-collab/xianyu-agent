import type { AppState } from "@/lib/domain/types";
import type { AdapterResult, XianyuAdapter } from "./types";

const MINUTE = 60_000;

export const WRITE_MODE_LABEL: Record<AppState["channel"]["write"], string> = {
  mock: "本地模拟",
  dry_run: "演练（只记录不执行）",
  live: "真实写入（未接入）",
};

export const READ_CHANNEL_LABEL: Record<AppState["channel"]["read"], string> = {
  mock: "本地模拟数据",
  live: "真实闲鱼账号（未接入）",
};

export interface WriteBudget {
  ok: boolean;
  /** 不允许写的时候，给人看的原因 */
  reason?: string;
  /** 还要等多久才能再写（毫秒） */
  retryAfterMs?: number;
}

/**
 * 限流只在非 mock 模式生效。
 *
 * mock 模式下没有任何真实账号需要保护，限流只会让本地演示变卡。
 */
function rateLimited(state: AppState): boolean {
  return state.channel.write !== "mock";
}

/** 纯函数：现在还能不能再发一次写请求。 */
export function checkWriteBudget(state: AppState, now: number): WriteBudget {
  if (state.safety.paused) {
    return { ok: false, reason: `已急停：${state.safety.pausedReason ?? "未说明原因"}` };
  }
  if (state.channel.write === "live") {
    return { ok: false, reason: "真实写入通道还没实现，请先用演练模式。" };
  }
  if (!rateLimited(state)) return { ok: true };

  const { maxWritesPerMinute, minWriteIntervalMs } = state.channel;
  const recent = state.safety.recentWrites.filter((at) => now - at < MINUTE);

  if (recent.length >= maxWritesPerMinute) {
    const oldest = Math.min(...recent);
    return {
      ok: false,
      reason: `限流：这一分钟已经写了 ${recent.length} 次，上限 ${maxWritesPerMinute} 次。`,
      retryAfterMs: MINUTE - (now - oldest),
    };
  }

  const last = recent.length > 0 ? Math.max(...recent) : undefined;
  if (last !== undefined && now - last < minWriteIntervalMs) {
    return {
      ok: false,
      reason: `限流：两次写操作至少隔 ${minWriteIntervalMs}ms。`,
      retryAfterMs: minWriteIntervalMs - (now - last),
    };
  }

  return { ok: true };
}

function recordWrite(state: AppState, now: number): void {
  if (!rateLimited(state)) return;
  state.safety.recentWrites = [
    ...state.safety.recentWrites.filter((at) => now - at < MINUTE),
    now,
  ].slice(-200);
}

/** 按下急停。人工、连续失败、疑似风控都走这里。 */
export function pauseWrites(
  state: AppState,
  reason: string,
  by: NonNullable<AppState["safety"]["pausedBy"]>,
  now: number,
): void {
  state.safety.paused = true;
  state.safety.pausedReason = reason;
  state.safety.pausedBy = by;
  state.safety.pausedAt = new Date(now).toISOString();
}

export function resumeWrites(state: AppState): void {
  state.safety.paused = false;
  state.safety.pausedReason = undefined;
  state.safety.pausedBy = undefined;
  state.safety.pausedAt = undefined;
  state.safety.consecutiveFailures = 0;
}

/**
 * 给写通道套上的安全外壳。
 *
 * 每一次写操作都要过这几关：急停 → 写模式 → 限流 → 真正执行 → 记账。
 * 执行结果里带风控标记，或者连续失败次数到阈值，都会自动按下急停。
 */
export class GuardedAdapter implements XianyuAdapter {
  readonly id: string;
  readonly label: string;
  readonly isMock: boolean;

  constructor(private readonly inner: XianyuAdapter) {
    this.id = `guarded:${inner.id}`;
    this.label = inner.label;
    this.isMock = inner.isMock;
  }

  refreshListing(state: AppState, listingId: string, now: number): AdapterResult {
    return this.run(state, now, `擦亮商品 ${listingId}`, () =>
      this.inner.refreshListing(state, listingId, now),
    );
  }

  updatePrice(
    state: AppState,
    listingId: string,
    toCents: number,
    now: number,
  ): AdapterResult {
    return this.run(
      state,
      now,
      `把商品 ${listingId} 的价格改成 ¥${(toCents / 100).toFixed(2)}`,
      () => this.inner.updatePrice(state, listingId, toCents, now),
    );
  }

  delistListing(state: AppState, listingId: string, now: number): AdapterResult {
    return this.run(state, now, `下架商品 ${listingId}`, () =>
      this.inner.delistListing(state, listingId, now),
    );
  }

  sendMessage(
    state: AppState,
    conversationId: string,
    text: string,
    now: number,
  ): AdapterResult {
    return this.run(state, now, `给会话 ${conversationId} 发一条回复`, () =>
      this.inner.sendMessage(state, conversationId, text, now),
    );
  }

  shipOrder(
    state: AppState,
    orderId: string,
    carrier: string,
    trackingNo: string,
    now: number,
  ): AdapterResult {
    return this.run(state, now, `发货订单 ${orderId}（${carrier} ${trackingNo}）`, () =>
      this.inner.shipOrder(state, orderId, carrier, trackingNo, now),
    );
  }

  private run(
    state: AppState,
    now: number,
    label: string,
    execute: () => AdapterResult,
  ): AdapterResult {
    const budget = checkWriteBudget(state, now);
    if (!budget.ok) {
      return { ok: false, message: budget.reason ?? "写操作被拒绝。" };
    }

    if (state.channel.write === "dry_run") {
      recordWrite(state, now);
      state.safety.consecutiveFailures = 0;
      return { ok: true, message: `[演练] ${label}（实际未执行）`, dryRun: true };
    }

    const result = execute();
    recordWrite(state, now);

    if (result.riskControl) {
      pauseWrites(state, `疑似触发平台风控：${result.message}`, "risk_control", now);
      return result;
    }

    if (result.ok) {
      state.safety.consecutiveFailures = 0;
      return result;
    }

    state.safety.consecutiveFailures += 1;
    if (state.safety.consecutiveFailures >= state.channel.autoPauseAfterFailures) {
      pauseWrites(
        state,
        `连续 ${state.safety.consecutiveFailures} 次写操作失败，最后一次：${result.message}`,
        "failures",
        now,
      );
    }
    return result;
  }
}
