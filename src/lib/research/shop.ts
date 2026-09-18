import type { AppState, ParsedShopOrigin, ResearchTask, RivalListing } from "@/lib/domain/types";

/**
 * 店铺任务：盯一家店在卖什么。
 *
 * 和关键词选品的区别在于口径 —— 关键词任务只留「和我这件可比」的，
 * 店铺任务要的是全貌，所以不按规格筛、也不跑自动清理。
 */

export function shopTaskName(sellerName: string | undefined, sellerId: string): string {
  const nick = sellerName?.trim();
  return nick ? `店铺 · ${nick.slice(0, 18)}` : `店铺 · ${sellerId}`;
}

export function findShopTask(
  tasks: ResearchTask[],
  sellerId: string,
): ResearchTask | undefined {
  return tasks.find(
    (task) => task.kind === "shop" && task.sellerId === sellerId && task.status === "active",
  );
}

/** 同一家店复用同一个任务，不每采一页新建一个。 */
export function ensureShopTask(
  state: AppState,
  origin: ParsedShopOrigin,
  now: number,
): ResearchTask {
  const existing = findShopTask(state.research.tasks, origin.sellerId);
  if (existing) {
    // 昵称改了跟着改，任务身份仍然是 sellerId
    if (origin.sellerName) existing.name = shopTaskName(origin.sellerName, origin.sellerId);
    return existing;
  }

  const task: ResearchTask = {
    id: `RT${now.toString(36).toUpperCase()}S`,
    name: shopTaskName(origin.sellerName, origin.sellerId),
    // 店铺任务不靠关键词找货，这里留空只是为了满足结构
    keyword: "",
    kind: "shop",
    sellerId: origin.sellerId,
    mustInclude: [],
    mustExclude: [],
    revisitHours: 24,
    status: "active",
    createdAt: new Date(now).toISOString(),
  };
  state.research.tasks.unshift(task);
  return task;
}

/** 这家店在库里的货。看板按 sellerId 过滤即可，不用单独一张表。 */
export function rivalsOfShop(
  rivals: RivalListing[],
  task: ResearchTask,
): RivalListing[] {
  return rivals.filter((rival) => rival.taskId === task.id);
}

/**
 * 从某件同行商品进这家店。
 *
 * 返回普通链接给 `<a>` 用 —— 点它是你自己的浏览器在走，不经过本机自动化。
 * 还没抽到 sellerId 就返回空，界面上按钮置灰，先用采集端开一次商详把身份留下。
 */
export function shopEntryUrl(rival: RivalListing): string | undefined {
  if (rival.shopUrl) return rival.shopUrl;
  return rival.sellerId
    ? `https://www.goofish.com/personal?userId=${rival.sellerId}`
    : undefined;
}
