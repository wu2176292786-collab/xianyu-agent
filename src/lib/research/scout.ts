import type { AppState, Listing, ResearchTask } from "@/lib/domain/types";
import {
  categoryClash,
  isWeakSpecWord,
  mineTextForTask,
} from "./category";
import type { ParsedItem, ParseResult } from "./snapshot";

const TITLE_PUNCT = /[【】[\]（）()「」『』《》<>]/g;

/** 用标题当搜索词。开头是「一人公司」这种空词时，改用规格词去搜。 */
export function searchKeywordFromListing(listing: {
  title: string;
  copy?: string;
  tags?: string[];
}): string {
  const title = listing.title.replace(TITLE_PUNCT, " ").replace(/\s+/g, " ").trim();
  if (!title) return listing.copy?.slice(0, 16).trim() || "";
  const parts = title.split(/[\s,，、/|·\-—_]+/).filter(Boolean);
  const specs = specWordsFromListing(listing);
  if (parts.length >= 2 && isWeakSpecWord(parts[0]) && specs.length > 0) {
    return specs.join(" ").slice(0, 28);
  }
  return title.length <= 28 ? title : title.slice(0, 28);
}

/**
 * 规格对齐词。有标签用标签；没有就从标题拆两段。
 * 太严会把同类都判成存疑，太松会把无关货拉进价格带。
 */
export function specWordsFromListing(listing: {
  title: string;
  tags?: string[];
}): string[] {
  const tags = (listing.tags ?? [])
    .map((word) => word.trim())
    .filter((word) => word.length >= 2);
  if (tags.length > 0) return tags.slice(0, 3);

  const parts = listing.title
    .replace(TITLE_PUNCT, " ")
    .split(/[\s,，、/|·\-—_]+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2);
  const strong = parts.filter((word) => !isWeakSpecWord(word));
  const pool = strong.length > 0 ? strong : parts;

  if (pool.length >= 2) return pool.slice(0, 2);
  const only = pool[0];
  if (only) return [only.length > 6 ? only.slice(0, 4) : only];
  const fallback = listing.title.trim();
  return fallback ? [fallback.slice(0, 4)] : [];
}

export { DEFAULT_SEARCH_PAGES as SEARCH_PAGES } from "./search-pager";
export const SEARCH_PAGE_SIZE = 20;
export const SEARCH_PAGE_GAP_MS = 1500;

export function searchItemsReq(
  keyword: string,
  pageNumber = 1,
  rowsPerPage = SEARCH_PAGE_SIZE,
) {
  return {
    pageNumber,
    keyword,
    rowsPerPage,
    fromFilter: false,
    searchReqFromPage: "pcSearch",
  };
}

export function mergeSearchParses(results: ParseResult[]): ParseResult {
  const seen = new Set<string>();
  const items: ParsedItem[] = [];
  let skipped = 0;
  const warnings: string[] = [];
  for (const result of results) {
    skipped += result.skipped;
    warnings.push(...result.warnings);
    for (const item of result.items) {
      if (!item.itemId || seen.has(item.itemId)) continue;
      seen.add(item.itemId);
      items.push(item);
    }
  }
  return { items, skipped, warnings };
}

export function excludeOwnListing(
  items: ParsedItem[],
  listingId: string,
): ParsedItem[] {
  return items.filter((item) => item.itemId !== listingId);
}

export function filterOwnFromParse(
  parsed: ParseResult,
  listingId: string,
): ParseResult {
  return {
    ...parsed,
    items: excludeOwnListing(parsed.items, listingId),
  };
}

/** 标题对不上规格、或品类明显冲突（服务 vs 二手书）的，不入库。 */
export function keepRelatedSearchItems(
  items: ParsedItem[],
  task: Pick<ResearchTask, "name" | "keyword" | "mustInclude">,
): ParsedItem[] {
  const mine = mineTextForTask(task);
  const required = task.mustInclude.map((word) => word.trim()).filter(Boolean);
  return items.filter((item) => {
    const title = item.title?.trim();
    if (!title) return false;
    if (categoryClash(mine, title)) return false;
    if (required.length === 0) return true;
    const haystack = title.toLowerCase();
    return required.some((word) => haystack.includes(word.toLowerCase()));
  });
}

export function filterRelatedFromParse(
  parsed: ParseResult,
  task: Pick<ResearchTask, "name" | "keyword" | "mustInclude">,
): ParseResult {
  return {
    ...parsed,
    items: keepRelatedSearchItems(parsed.items, task),
  };
}

/** 同一件本店货复用进行中的研究任务，不每点一次新建一个。 */
export function ensureListingResearchTask(
  state: AppState,
  listing: Listing,
  now: number,
): ResearchTask {
  const existing = state.research.tasks.find(
    (task) => task.linkedListingId === listing.id && task.status === "active",
  );
  if (existing) {
    existing.keyword = searchKeywordFromListing(listing);
    if (
      existing.mustInclude.length === 0 ||
      existing.mustInclude.every((word) => isWeakSpecWord(word)) ||
      isWeakSpecWord(existing.mustInclude[0] ?? "")
    ) {
      existing.mustInclude = specWordsFromListing(listing);
    }
    return existing;
  }

  const task: ResearchTask = {
    id: `RT${now.toString(36).toUpperCase()}`,
    name: `对手 · ${listing.title.slice(0, 18)}`,
    keyword: searchKeywordFromListing(listing),
    mustInclude: specWordsFromListing(listing),
    mustExclude: [],
    linkedListingId: listing.id,
    revisitHours: 24,
    status: "active",
    createdAt: new Date(now).toISOString(),
  };
  state.research.tasks.unshift(task);
  return task;
}

export const SCOUT_HEAT_LIMIT = 6;
