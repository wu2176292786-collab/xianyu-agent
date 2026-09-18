/**
 * 品类对不上就不要拿来比。
 *
 * 搜索经常搜偏：陪跑服务旁边会出现二手书。规格词没命中时它们是「存疑」，
 * 但不能把存疑书的卖点送给模型当对照。
 */

const SERVICE_MARKERS = [
  "陪跑",
  "自动化",
  "客服",
  "agent",
  "获客",
  "智能体",
  "工作流",
  "部署",
  "代运营",
  "定制服务",
];

const BOOK_MARKERS = [
  "二手书",
  "正版书",
  "正版二手",
  "二手正版",
  "【二手】",
  "教材",
  "isbn",
  "出版社",
  "考研资料",
  "教辅",
  "图书",
];

const WEAK_SPEC = /^(一人公司|个人|工作室|全新|二手|包邮|闲鱼|咸鱼)$/i;

export function isWeakSpecWord(word: string): boolean {
  return WEAK_SPEC.test(word.trim());
}

function hay(text: string): string {
  return text.toLowerCase();
}

export function looksLikeService(text: string): boolean {
  const value = hay(text);
  return SERVICE_MARKERS.some((marker) => value.includes(marker.toLowerCase()));
}

export function looksLikeBook(text: string): boolean {
  const value = hay(text);
  if (BOOK_MARKERS.some((marker) => value.includes(marker.toLowerCase()))) {
    return true;
  }
  return /978\d{9,10}/.test(text.replace(/[-\s]/g, ""));
}

/** 本店是服务、对面是书：直接判不同款，不当存疑。 */
export function categoryClash(mine: string, rivalTitle: string): boolean {
  return looksLikeService(mine) && looksLikeBook(rivalTitle);
}

export function mineTextForTask(task: {
  name: string;
  keyword: string;
  mustInclude: string[];
}): string {
  return `${task.keyword} ${task.name} ${task.mustInclude.join(" ")}`;
}
