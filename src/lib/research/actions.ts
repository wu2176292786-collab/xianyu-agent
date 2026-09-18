"use server";

import type { ActionResponse } from "@/lib/action-kit";
import { revalidateAll } from "@/lib/action-kit";
import { runResearchAsk } from "@/lib/agent/pi/research-ask";
import {
  analyzeCompetition,
  draftTaskRules,
  llmStatus,
  polishListingCopy,
  type TaskRuleDraft,
} from "@/lib/agent/llm";
import { ALIGNMENT_LABEL, type Alignment, type ResearchTask } from "@/lib/domain/types";
import { endpointConfig } from "@/lib/adapters/live/reader";
import { callMtop } from "@/lib/adapters/live/mtop-client";
import { findingsFor } from "@/lib/research/analysis";
import { competitionBrief } from "@/lib/research/brief";
import { browseSearchPages } from "@/lib/research/browse-search";
import { newCollectorToken } from "@/lib/research/collector";
import { rivalPolishDraft } from "@/lib/research/copy";
import { needsHeatFill } from "@/lib/research/heat";
import { runMissingHeatPull } from "@/lib/research/pull";
import {
  describeRecord,
  realignAutoRivals,
  recordObservations,
} from "@/lib/research/record";
import { pruneHiddenRivals } from "@/lib/research/screen";
import { screenAndPruneRivals } from "@/lib/research/screen-run";
import {
  SCOUT_HEAT_LIMIT,
  SEARCH_PAGE_GAP_MS,
  ensureListingResearchTask,
  filterOwnFromParse,
  filterRelatedFromParse,
  mergeSearchParses,
  searchItemsReq,
  searchKeywordFromListing,
  specWordsFromListing,
} from "@/lib/research/scout";
import {
  clampSearchPages,
  MAX_SEARCH_PAGES,
  MIN_SEARCH_PAGES,
} from "@/lib/research/search-pager";
import { parsePageSnapshot } from "@/lib/research/snapshot";
import { insertKeywordTask, removeResearchTaskFromState } from "@/lib/research/task-write";
import { getState, logActivity, mutateState } from "@/lib/store";

function splitKeywords(raw: string): string[] {
  return raw
    .split(/[,，、\s]+/)
    .map((word) => word.trim())
    .filter(Boolean);
}

export async function updateSearchPages(pages: number): Promise<ActionResponse> {
  const raw = Number(pages);
  if (!Number.isFinite(raw) || raw < MIN_SEARCH_PAGES || raw > MAX_SEARCH_PAGES) {
    return {
      ok: false,
      message: `搜索页数请填 ${MIN_SEARCH_PAGES}～${MAX_SEARCH_PAGES} 之间的整数。`,
    };
  }
  const searchPages = clampSearchPages(raw);
  const response = await mutateState((state) => {
    state.research.searchPages = searchPages;
    return { ok: true, message: `之后一次会连翻 ${searchPages} 页。` };
  });
  revalidateAll();
  return response;
}

/** 全局监控节奏：只影响你明确标为「监控」的同行。 */
export async function createResearchTask(input: {
  name: string;
  keyword: string;
  mustInclude: string;
  mustExclude: string;
  linkedListingId?: string;
  revisitHours: string;
}): Promise<ActionResponse> {
  const name = input.name.trim();
  if (!name) return { ok: false, message: "给这个研究任务起个名字。" };

  const hours = Number(input.revisitHours);
  if (!Number.isFinite(hours) || hours < 1 || hours > 720) {
    return { ok: false, message: "回访间隔请填 1~720 小时。" };
  }

  const now = Date.now();
  const response = await mutateState((state) => {
    const created = insertKeywordTask(
      state,
      { name, keyword: input.keyword, revisitHours: hours },
      now,
    );
    if (!created.ok) return created;
    const task = state.research.tasks.find((item) => item.id === created.taskId);
    if (task) {
      task.mustInclude = splitKeywords(input.mustInclude);
      task.mustExclude = splitKeywords(input.mustExclude);
      task.linkedListingId = input.linkedListingId || undefined;
    }
    return created;
  });

  revalidateAll();
  return response;
}

export async function draftResearchTaskRules(input: {
  prompt: string;
  linkedListingId?: string;
}): Promise<ActionResponse & { draft?: TaskRuleDraft }> {
  const prompt = input.prompt.trim();
  if (!prompt) return { ok: false, message: "先用一句话说你想找什么。" };
  if (!llmStatus().configured) {
    return { ok: false, message: "还没配置模型，请手填。" };
  }

  const state = await getState();
  const listing = input.linkedListingId
    ? state.listings.find((item) => item.id === input.linkedListingId)
    : undefined;
  const result = await draftTaskRules(
    prompt,
    listing ? { title: listing.title, copy: listing.copy } : undefined,
  );
  if (!result.draft) {
    return { ok: false, message: result.fallback ?? "模型没给出可用的规则，请手填。" };
  }
  return { ok: true, message: "这是草稿，确认后再创建。", draft: result.draft };
}

export async function askResearchQuestion(input: {
  question: string;
  taskId?: string;
}): Promise<ActionResponse & { answer?: string; tools?: string[] }> {
  const question = input.question.trim();
  if (!question) return { ok: false, message: "先问一句。" };
  const state = await getState();
  return runResearchAsk(state, question, Date.now(), {
    currentTaskId: input.taskId,
  });
}

export async function deleteResearchTask(taskId: string): Promise<ActionResponse> {
  const response = await mutateState((state) =>
    removeResearchTaskFromState(state, taskId, Date.now()),
  );
  revalidateAll();
  return response;
}

export async function updateResearchTask(
  taskId: string,
  input: {
    mustInclude?: string;
    mustExclude?: string;
    linkedListingId?: string;
    revisitHours?: string;
  },
): Promise<ActionResponse> {
  if (input.revisitHours !== undefined) {
    const hours = Number(input.revisitHours);
    if (!Number.isFinite(hours) || hours < 1 || hours > 720) {
      return { ok: false, message: "回访间隔请填 1~720 小时。" };
    }
  }

  const response = await mutateState((state) => {
    const task = state.research.tasks.find((t) => t.id === taskId);
    if (!task) return { ok: false, message: "找不到这个研究任务。" };

    if (input.mustInclude !== undefined) task.mustInclude = splitKeywords(input.mustInclude);
    if (input.mustExclude !== undefined) task.mustExclude = splitKeywords(input.mustExclude);
    if (input.linkedListingId !== undefined) {
      const nextId = input.linkedListingId || undefined;
      if (nextId !== task.linkedListingId) {
        task.llmAnalysis = undefined;
        task.llmAnalysisAt = undefined;
      }
      task.linkedListingId = nextId;
    }
    if (input.revisitHours !== undefined) task.revisitHours = Number(input.revisitHours);

    const realigned = realignAutoRivals(state, task);
    const pruned = pruneHiddenRivals(state, task.id);

    return {
      ok: true,
      message:
        pruned.dropped > 0
          ? `已保存，移出 ${pruned.dropped} 件不同款/存疑。`
          : realigned > 0
            ? `已保存，${realigned} 件同行的对齐结论变了。`
            : "已保存。",
    };
  });

  revalidateAll();
  return response;
}

/**
 * 导入一份页面快照。
 *
 * 这是同行数据的入口：你在正常浏览时采集，本机解析入库。
 * 搜索页只有卡片；导入后会按商品链接去商详补想要和浏览，撞风控立刻停。
 */
export async function importPageSnapshot(
  taskId: string,
  raw: string,
): Promise<ActionResponse> {
  if (!raw.trim()) return { ok: false, message: "先粘贴一份页面快照。" };

  const now = Date.now();
  const parsed = parsePageSnapshot(raw, now);
  if (parsed.items.length === 0) {
    return { ok: false, message: parsed.warnings[0] ?? "这份快照里没认出任何商品。" };
  }

  const response = await mutateState((state) => {
    const task = state.research.tasks.find((t) => t.id === taskId);
    if (!task) return { ok: false, message: "找不到这个研究任务。" };

    const summary = recordObservations(state, taskId, parsed, now);
    const text = describeRecord(summary);
    logActivity(state, "human", `选品研究「${task.name}」：${text}。`, now);
    return {
      ok: true,
      message: [text, ...parsed.warnings].join("；"),
    };
  });

  if (response.ok) {
    const screened = await screenAndPruneRivals(taskId);
    void runMissingHeatPull({ taskId });
    revalidateAll();
    return {
      ...response,
      message: [response.message, screened.message].filter(Boolean).join(" "),
    };
  }
  revalidateAll();
  return response;
}

/**
 * 按商品链接去商详补还缺的想要 / 浏览。
 * 搜索结果页本身没有浏览，点进商品页才有。
 */
export async function fillMissingRivalHeat(taskId: string): Promise<ActionResponse> {
  const state = await getState();
  const task = state.research.tasks.find((item) => item.id === taskId);
  if (!task) return { ok: false, message: "找不到这个研究任务。" };
  if (state.channel.read !== "live") {
    return { ok: false, message: "读通道不是 live，没法去商品页补浏览。" };
  }

  const missing = state.research.rivals.filter(
    (rival) =>
      rival.taskId === taskId &&
      rival.alignment === "comparable" &&
      needsHeatFill(rival),
  ).length;
  if (missing === 0) {
    return { ok: true, message: "这些商品都已经打开过商品页了。" };
  }

  const result = await runMissingHeatPull({ taskId });
  revalidateAll();
  return {
    ok: result.ok,
    message: result.message,
  };
}

/** 人工改对齐结论。改过之后不会再被关键词判定覆盖 —— 人看过的比关键词可靠。 */
export async function setRivalAlignment(
  rivalId: string,
  alignment: Alignment,
): Promise<ActionResponse> {
  const response = await mutateState((state) => {
    const rival = state.research.rivals.find((r) => r.id === rivalId);
    if (!rival) return { ok: false, message: "找不到这件同行商品。" };
    rival.alignment = alignment;
    rival.alignmentBy = "human";
    if (alignment !== "comparable") {
      const index = state.research.rivals.findIndex((row) => row.id === rivalId);
      if (index >= 0) state.research.rivals.splice(index, 1);
      return { ok: true, message: "已移出同行列表。" };
    }
    return { ok: true, message: `已标记为「${ALIGNMENT_LABEL[alignment]}」。` };
  });

  revalidateAll();
  return response;
}

/**
 * 换一把采集密钥。
 *
 * 密钥泄露了、或者你不想让某个装过扩展的浏览器再投数据，就换一把 ——
 * 换完所有采集端都得重新填。
 */
export async function regenerateCollectorToken(): Promise<ActionResponse> {
  const now = Date.now();
  const response = await mutateState((state) => {
    state.research.collectorToken = newCollectorToken();
    logActivity(state, "human", "重新生成了采集密钥，采集端需要重新填。", now);
    return { ok: true, message: "已换一把新密钥，记得更新扩展里的设置。" };
  });

  revalidateAll();
  return response;
}

export async function removeRival(rivalId: string): Promise<ActionResponse> {
  const response = await mutateState((state) => {
    const index = state.research.rivals.findIndex((r) => r.id === rivalId);
    if (index < 0) return { ok: false, message: "找不到这件同行商品。" };
    const [removed] = state.research.rivals.splice(index, 1);
    return { ok: true, message: `已移出研究：${removed.title.slice(0, 20)}。` };
  });

  revalidateAll();
  return response;
}

/**
 * 用模型对照本店货和同行观察。材料里没有的数字不能出现。
 * 只写在研究台上，不进行动队列。
 */
export async function analyzeListingCompetition(
  taskId: string,
): Promise<ActionResponse> {
  const prepared = await mutateState((next) => {
    const task = next.research.tasks.find((item) => item.id === taskId);
    if (!task) return { ok: false as const, message: "找不到这个研究任务。" };
    const listing = next.listings.find((item) => item.id === task.linkedListingId);
    if (!listing) {
      return { ok: false as const, message: "先在「对标本店商品」里选一件本店货。" };
    }
    realignAutoRivals(next, task);
    pruneHiddenRivals(next, task.id);
    return {
      ok: true as const,
      task,
      listing,
      rivals: next.research.rivals.filter((rival) => rival.taskId === taskId),
    };
  });
  if (!prepared.ok) return prepared;

  if (!llmStatus().configured) {
    return {
      ok: false,
      message: "还没配置 OPENAI_API_KEY，没法做智能分析。在 .env.local 里配好再试。",
    };
  }

  const now = Date.now();
  const { task, listing, rivals } = prepared;
  const brief = competitionBrief({
    task,
    listing,
    rivals,
    now,
    findings: findingsFor(task, rivals, listing, now),
  });
  const analyzed = await analyzeCompetition(brief);

  if (!analyzed.text) {
    return {
      ok: false,
      message: analyzed.fallback ?? "分析没通过校验，规则结论还在，模型这段没用。",
    };
  }

  const response = await mutateState((next) => {
    const target = next.research.tasks.find((item) => item.id === taskId);
    if (!target) return { ok: false, message: "找不到这个研究任务。" };
    target.llmAnalysis = analyzed.text ?? undefined;
    target.llmAnalysisAt = new Date(now).toISOString();
    logActivity(next, "agent", `对照「${listing.title.slice(0, 18)}」写了智能分析。`, now);
    return { ok: true, message: "已写出对照分析。" };
  });

  revalidateAll();
  return response;
}

/**
 * 用模型润色一件同行的商品文案。
 *
 * 原文不动，润色稿单独存。数字守卫和回复润色同一套：模型不能编价格。
 */
export async function polishRivalCopy(rivalId: string): Promise<ActionResponse> {
  const state = await getState();
  const rival = state.research.rivals.find((item) => item.id === rivalId);
  if (!rival) return { ok: false, message: "找不到这件同行商品。" };

  if (!llmStatus().configured) {
    return {
      ok: false,
      message: "还没配置 OPENAI_API_KEY，没法润色。在 .env.local 里配好再试。",
    };
  }

  const draft = rivalPolishDraft(rival);
  const polished = await polishListingCopy(
    draft,
    "把下面的同行商品改写成你自己能发布的闲鱼文案，不要写成研究笔记。",
  );

  if (!polished.text) {
    return {
      ok: false,
      message: polished.fallback ?? "润色没通过校验，原文未改。",
    };
  }

  const response = await mutateState((next) => {
    const target = next.research.rivals.find((item) => item.id === rivalId);
    if (!target) return { ok: false, message: "找不到这件同行商品。" };
    target.polishedCopy = polished.text ?? undefined;
    return { ok: true, message: "已润色，可以一键复制。" };
  });

  revalidateAll();
  return response;
}

/**
 * 读本店标题和文案，先在浏览器里点 3 页搜索，点不动再走接口翻页，
 * 记下价格，再补最多 6 件商详热度。只在你点「看对手」时跑。
 */
export async function scoutListingCompetition(
  listingId: string,
): Promise<ActionResponse> {
  const now = Date.now();
  const state = await getState();
  const listing = state.listings.find((item) => item.id === listingId);
  if (!listing) return { ok: false, message: "找不到这件商品。" };

  let taskId = "";
  let scoutTask: ResearchTask | undefined;
  await mutateState((next) => {
    scoutTask = ensureListingResearchTask(next, listing, now);
    taskId = scoutTask.id;
    logActivity(next, "human", `为「${listing.title.slice(0, 18)}」找同类对手。`, now);
  });

  if (state.channel.read !== "live") {
    revalidateAll();
    return {
      ok: true,
      taskId,
      message:
        "已建研究任务。读通道不是真实账号，没法当场搜同行。到选品研究用采集端导入，或先导入登录态。",
    };
  }

  const endpoints = endpointConfig();
  if (!endpoints.search) {
    return { ok: false, taskId, message: "没有配置搜索接口。" };
  }

  let copy = listing.copy;
  if (endpoints.itemDetail) {
    try {
      const own = await callMtop({
        api: endpoints.itemDetail.api,
        version: endpoints.itemDetail.version,
        payload: { itemId: listing.id },
      });
      if (own.kind === "risk_control") {
        revalidateAll();
        return { ok: false, taskId, message: "撞上风控，已停手。过几小时再点看对手。" };
      }
      if (own.kind === "ok") {
        const parsed = parsePageSnapshot(
          {
            capturedAt: new Date().toISOString(),
            pageUrl: `https://www.goofish.com/item?id=${listing.id}`,
            pageType: "detail",
            api: own.data,
          },
          Date.now(),
        );
        copy = parsed.items[0]?.copy ?? copy;
        if (copy) {
          await mutateState((next) => {
            const row = next.listings.find((item) => item.id === listingId);
            if (row) row.copy = copy;
          });
        }
      }
    } catch {
      // 自己的商详拉不到也继续搜，标题够用
    }
  }

  const keyword = searchKeywordFromListing({ title: listing.title, copy });
  await mutateState((next) => {
    const task = next.research.tasks.find((item) => item.id === taskId);
    if (task) task.keyword = keyword;
  });

  const searchPages = clampSearchPages(state.research.searchPages);
  const pages: ReturnType<typeof parsePageSnapshot>[] = [];
  try {
    const browsed = await browseSearchPages(keyword, searchPages);
    if (browsed.ok && browsed.pages.length > 0) {
      pages.push(...browsed.pages);
    }
  } catch {
    // 浏览器点不动就走下面的接口翻页
  }
  try {
    for (let page = pages.length + 1; page <= searchPages; page += 1) {
      const searchOutcome = await callMtop({
        api: endpoints.search.api,
        version: endpoints.search.version,
        payload: searchItemsReq(keyword, page),
      });
      if (searchOutcome.kind === "risk_control") {
        if (pages.length === 0) {
          revalidateAll();
          return { ok: false, taskId, message: "撞上风控，已停手。过几小时再点看对手。" };
        }
        break;
      }
      if (searchOutcome.kind !== "ok") {
        if (pages.length === 0) {
          revalidateAll();
          return { ok: false, taskId, message: `搜索没成功：${searchOutcome.message}` };
        }
        break;
      }
      const parsed = parsePageSnapshot(
        {
          capturedAt: new Date().toISOString(),
          pageUrl: `https://www.goofish.com/search?q=${encodeURIComponent(keyword)}`,
          pageType: "search",
          api: searchOutcome.data,
        },
        Date.now(),
      );
      if (parsed.items.length === 0) break;
      pages.push(parsed);
      if (page < searchPages) {
        await new Promise((resolve) => {
          setTimeout(resolve, SEARCH_PAGE_GAP_MS);
        });
      }
    }
  } catch (error) {
    revalidateAll();
    return {
      ok: false,
      taskId,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const parsed = mergeSearchParses(pages);
  const filtered = filterRelatedFromParse(
    filterOwnFromParse(parsed, listing.id),
    scoutTask ?? {
      name: `对手 · ${listing.title.slice(0, 18)}`,
      keyword,
      mustInclude: specWordsFromListing(listing),
    },
  );

  if (filtered.items.length === 0) {
    revalidateAll();
    return {
      ok: true,
      taskId,
      message:
        parsed.warnings[0] ??
        `搜到了，但标题对不上「${(scoutTask?.mustInclude ?? specWordsFromListing(listing)).join(" / ") || keyword}」，没有入库。改一下必须含再看对手。`,
    };
  }

  const recorded = await mutateState((next) => {
    const summary = recordObservations(next, taskId, filtered, Date.now());
    const task = next.research.tasks.find((item) => item.id === taskId);
    if (task) realignAutoRivals(next, task);
    const text = describeRecord(summary);
    logActivity(
      next,
      "agent",
      `「${listing.title.slice(0, 18)}」搜同类：${text}。`,
      Date.now(),
    );
    return { ok: true as const, message: text };
  });

  const screened = await screenAndPruneRivals(taskId);
  const heat = await runMissingHeatPull({ taskId, limit: SCOUT_HEAT_LIMIT });
  revalidateAll();
  return {
    ok: true,
    taskId,
    message: [recorded.message, screened.message, heat.message].filter(Boolean).join(" "),
  };
}
