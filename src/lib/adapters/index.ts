import type { AppState } from "@/lib/domain/types";
import { GuardedAdapter } from "./guard";
import { mockAdapter } from "./mock";
import { liveXianyuReader } from "./live/reader";
import { mockReader } from "./mock-reader";
import type { XianyuReader } from "./types";

/**
 * 应用里所有写操作都必须走这个通道。
 *
 * 外面套了一层护栏：急停、写模式（模拟 / 演练 / 真实）、限流、
 * 风控自动暂停。底下现在接的是模拟通道，换成真实实现时只改这一行。
 */
export const writeChannel = new GuardedAdapter(mockAdapter);

export function readerFor(state: AppState): XianyuReader {
  // 没导入登录态时，LiveXianyuReader 自己会抛出明确的「未配置」错误
  return state.channel.read === "live" ? liveXianyuReader : mockReader;
}
