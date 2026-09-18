import type { Listing, ResearchTask, RivalListing } from "@/lib/domain/types";
import { yuan } from "@/lib/format";
import { findingsFor, latestHeat, type Finding } from "./analysis";
import { latestPriceCents } from "./copy";

const MAX_RIVALS = 8;
const COPY_SLICE = 240;

function clip(text: string | undefined, max = COPY_SLICE): string {
  const trimmed = text?.replace(/\s+/g, " ").trim();
  if (!trimmed) return "（没有正文）";
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

function rivalLine(rival: RivalListing, index: number): string {
  const heat = latestHeat(rival);
  const price = latestPriceCents(rival);
  const bits = [
    price !== undefined ? `价格 ${yuan(price)}` : "价格未抽到",
    heat.wants !== undefined ? `想要 ${heat.wants}` : "想要未抽到",
    heat.views !== undefined ? `浏览 ${heat.views}` : "浏览未抽到",
    `对齐 ${rival.alignment === "comparable" ? "可比" : rival.alignment === "different" ? "不同款" : "存疑"}`,
  ];
  return [
    `${index + 1}. ${rival.title}`,
    `   ${bits.join(" · ")}`,
    `   正文：${clip(rival.copy)}`,
    `   链接：${rival.url}`,
  ].join("\n");
}

/**
 * 送给模型的对照材料。
 *
 * 后面的数字守卫拿这份当「草稿」：模型输出里的每个数字都必须在这里出现过。
 * 所以这里只写已经采到的数，不写推断。
 */
export function competitionBrief(options: {
  task: ResearchTask;
  listing: Listing;
  rivals: RivalListing[];
  now: number;
  findings?: Finding[];
}): string {
  const { task, listing, rivals, now } = options;
  const mine = rivals.filter((rival) => rival.taskId === task.id);
  const comparable = mine.filter((rival) => rival.alignment === "comparable");
  const uncertain = mine.filter((rival) => rival.alignment === "uncertain");
  const different = mine.filter((rival) => rival.alignment === "different");
  const picked = comparable.slice(0, MAX_RIVALS);
  const findings = options.findings ?? findingsFor(task, rivals, listing, now);

  const lines = [
    `研究任务：${task.name}`,
    `搜索词：${task.keyword || "（未填）"}`,
    `本店品类提示：${listing.title}`,
    "",
    "【本店商品】",
    `标题：${listing.title}`,
    `挂牌价：${yuan(listing.priceCents)}`,
    listing.metricsUnknown
      ? "想要 / 浏览：平台这次没返回，不能当成 0"
      : `想要 ${listing.wants} · 近 7 天浏览 ${listing.views7d}`,
    listing.tags.length > 0 ? `标签：${listing.tags.join("、")}` : "标签：无",
    `正文：${clip(listing.copy, 400)}`,
    "",
    "【规则结论】",
    ...(findings.length > 0
      ? findings.map((finding) => `- ${finding.text}`)
      : ["- 还没有规则结论"]),
    "",
    `【规格可比同行 ${picked.length} 件（存疑 ${uncertain.length} / 不同款 ${different.length} / 研究里共 ${mine.length}，后两类不列入对照）】`,
  ];

  if (picked.length === 0) {
    lines.push(
      "没有规格可比的同行。不要分析存疑或不同款商品的卖点，哪怕它们在研究列表里。",
      `若搜到的是书、教材等和「${listing.title}」不是一类的货，直接说搜偏了，让人改「必须含」或重新看对手。`,
    );
  } else {
    lines.push(picked.map((rival, index) => rivalLine(rival, index)).join("\n"));
  }

  return lines.join("\n");
}
