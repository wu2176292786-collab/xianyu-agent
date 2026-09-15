import type { AppState } from "@/lib/domain/types";
import { GuardedAdapter } from "./guard";
import { mockAdapter } from "./mock";
import { credentialStatus } from "./live/credentials";
import { liveXianyuReader } from "./live/reader";
import { liveReader, mockReader } from "./mock-reader";
import type { XianyuReader } from "./types";

/**
 * 应用里所有写操作都必须走这个通道。
 *
 * 外面套了一层护栏：急停、写模式（模拟 / 演练 / 真实）、限流、
 * 风控自动暂停。底下现在接的是模拟通道，换成真实实现时只改这一行。
 */
export const writeChannel = new GuardedAdapter(mockAdapter);

export function readerFor(state: AppState): XianyuReader {
  if (state.channel.read !== "live") return mockReader;
  // 没配凭证时给出明确的「未接入」错误，而不是让请求在网关那边莫名其妙地失败
  return credentialStatus().configured ? liveXianyuReader : liveReader;
}
