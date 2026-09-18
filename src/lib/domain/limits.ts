/**
 * 本地 JSON 库的硬上限。
 *
 * 热数据整份进内存，落盘也是整份写回。这些数字是为了拦住
 * 「只追加不覆盖」的时间线把整库拖肥。换 SQLite 之后，
 * 查询可以按需取，上限仍然有用 —— 界面也看不了无限长的历史。
 */

/** 巡检记录，最近的在前 */
export const MAX_RUNS = 50;

/** 操作动态 */
export const MAX_ACTIVITY = 200;

/** 行动队列历史 */
export const MAX_ACTIONS = 200;

/**
 * 每件同行最多留多少条观察。
 *
 * 涨跌只需要最近两次商详；多留是给人回看时间线。
 * 按每天回访一次，40 条大约一个多月。
 */
export const MAX_OBSERVATIONS_PER_RIVAL = 40;

/** 观察摘录上限。DOM 原文只用来核对，截断不影响数字。 */
export const MAX_OBSERVATION_EXCERPT = 240;

/**
 * 单个研究任务最多留多少件同行。
 *
 * 盯住的不丢；其余按最近观察淘汰。一次搜索最多 60 张卡，
 * 80 能装下一整页再留一点余量。
 */
export const MAX_RIVALS_PER_TASK = 80;

/**
 * 店铺任务的上限单独放宽。
 *
 * 关键词选品只留够比较的那些就行；盯一家店要的是全貌，
 * 80 件对整店偏紧，采几页就开始丢货了。
 */
export const MAX_RIVALS_PER_SHOP_TASK = 200;

export function rivalCapFor(kind: "keyword" | "shop" | undefined): number {
  return kind === "shop" ? MAX_RIVALS_PER_SHOP_TASK : MAX_RIVALS_PER_TASK;
}
