import type { AppState } from "@/lib/domain/types";
import { GuardedAdapter } from "./guard";
import { mockAdapter } from "./mock";
import { liveXianyuReader } from "./live/reader";
import { liveXianyuAdapter } from "./live/writer";
import { mockReader } from "./mock-reader";
import type { XianyuAdapter, XianyuReader } from "./types";

/**
 * 应用里所有写操作都必须走护栏。
 *
 * mock / 演练底下是本地模拟；真实写入底下是闲鱼 IM（目前只能发私信）。
 */
export const writeChannel = new GuardedAdapter(mockAdapter);
const liveWriteChannel = new GuardedAdapter(liveXianyuAdapter);

export function writeChannelFor(state: AppState): XianyuAdapter {
  return state.channel.write === "live" ? liveWriteChannel : writeChannel;
}

export function readerFor(state: AppState): XianyuReader {
  // 没导入登录态时，LiveXianyuReader 自己会抛出明确的「未配置」错误
  return state.channel.read === "live" ? liveXianyuReader : mockReader;
}
