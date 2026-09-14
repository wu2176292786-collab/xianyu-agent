const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 分 → 「¥1,234.00」 */
export function yuan(cents: number): string {
  return `¥${(cents / 100).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** 分 → 「1234」，用于输入框回填 */
export function yuanPlain(cents: number): string {
  return (cents / 100).toFixed(2).replace(/\.00$/, "");
}

export function parseYuanToCents(input: string): number | null {
  const normalized = input.trim().replace(/[¥,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  return Math.round(Number(normalized) * 100);
}

/**
 * 统一的「当前时间」入口。页面在服务端取一次，再把 now 传给需要算时效的组件，
 * 避免同一次渲染里各处拿到不同的时间。
 */
export function nowMs(): number {
  return Date.now();
}

export function relativeTime(iso: string, now = nowMs()): string {
  const diff = now - new Date(iso).getTime();
  if (Number.isNaN(diff)) return "—";
  if (diff < 0) return "刚刚";
  if (diff < MINUTE) return "刚刚";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN");
}

export function hoursSince(iso: string, now: number): number {
  return (now - new Date(iso).getTime()) / HOUR;
}

export function daysSince(iso: string, now: number): number {
  return (now - new Date(iso).getTime()) / DAY;
}

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function percent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}
