import type { ResearchTask, RivalListing } from "@/lib/domain/types";
import { yuan } from "@/lib/format";

/** 最近一次抽到的价格。搜索和商详都能用，导出文案时给人看。 */
export function latestPriceCents(rival: RivalListing): number | undefined {
  return [...rival.observations]
    .reverse()
    .find((observation) => observation.priceCents !== undefined)?.priceCents;
}

/**
 * 一件同行的可复制文案：标题、价格、正文、回链。
 *
 * 图不写进文本 —— 复制到闲鱼发布框里用的是字，图另外下。
 */
export function rivalCopyText(rival: RivalListing): string {
  const lines = [rival.title];
  const price = latestPriceCents(rival);
  if (price !== undefined) lines.push(`价格 ${yuan(price)}`);
  if (rival.copy) {
    lines.push("");
    lines.push(rival.copy);
  }
  lines.push("");
  lines.push(rival.url);
  return lines.join("\n");
}

/**
 * 送给模型的草稿：只要标题、价格、正文。
 * 回链留给导出，塞进草稿会让模型把商品 ID 当文案抄出来。
 */
export function rivalPolishDraft(rival: RivalListing): string {
  const lines = [`标题：${rival.title}`];
  const price = latestPriceCents(rival);
  if (price !== undefined) lines.push(`价格：${yuan(price)}`);
  lines.push("");
  lines.push("原文：");
  lines.push(rival.copy?.trim() || "（只有标题，没有商详正文）");
  return lines.join("\n");
}

/** 当前该复制哪份：有润色稿就用润色稿，否则用原文。 */
export function rivalExportText(rival: RivalListing): string {
  return rival.polishedCopy?.trim() || rivalCopyText(rival);
}

export function exportTaskCopy(task: ResearchTask, rivals: RivalListing[]): string {
  const header = [`# ${task.name}`, `关键词 ${task.keyword || "（未填）"}`, ""].join("\n");
  if (rivals.length === 0) return `${header}还没有同行商品。\n`;
  return (
    header +
    rivals
      .map((rival, index) => `【${index + 1}】\n${rivalExportText(rival)}`)
      .join("\n\n---\n\n") +
    "\n"
  );
}

export function safeExportName(name: string): string {
  const cleaned =
    name
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "")
      .trim() || "选品研究";
  return `${cleaned}-文案.txt`;
}
