import type { AppState, PlatformSnapshot } from "@/lib/domain/types";

export interface AdapterResult {
  ok: boolean;
  /** 写入活动日志的一句话 */
  message: string;
  /** 演练模式：动作被记录了，但实际什么都没发生 */
  dryRun?: boolean;
  /**
   * 疑似撞上平台风控（滑块、验证码、异常 403）。
   * 看到这个标记必须立刻急停，继续重试只会把事情搞得更糟。
   */
  riskControl?: boolean;
}

/**
 * 与闲鱼平台交互的抽象层。
 *
 * v1 只提供 {@link MockXianyuAdapter}：所有动作都作用在本地状态上，不会
 * 触碰真实账号。接入真实通道（开放平台 / 自动化脚本）时实现同一个接口即可，
 * 规则引擎和 UI 不需要改动。
 */
export interface XianyuAdapter {
  readonly id: string;
  readonly label: string;
  /** 是否是不会产生真实副作用的模拟通道 */
  readonly isMock: boolean;

  refreshListing(state: AppState, listingId: string, now: number): AdapterResult;
  updatePrice(
    state: AppState,
    listingId: string,
    toCents: number,
    now: number,
  ): AdapterResult;
  delistListing(state: AppState, listingId: string, now: number): AdapterResult;
  sendMessage(
    state: AppState,
    conversationId: string,
    text: string,
    now: number,
  ): AdapterResult;
  shipOrder(
    state: AppState,
    orderId: string,
    carrier: string,
    trackingNo: string,
    now: number,
  ): AdapterResult;
}

/**
 * 读通道：把平台上的商品、会话、订单拉回来。
 *
 * 和写通道分开，是为了支持「读真实数据 + 写模拟」这种混合模式 ——
 * 在真实店铺的数据上验证规则靠不靠谱，同时一个字都不往平台上写。
 */
export interface XianyuReader {
  readonly id: string;
  readonly label: string;
  readonly isMock: boolean;
  fetchSnapshot(state: AppState, now: number): Promise<PlatformSnapshot>;
}
