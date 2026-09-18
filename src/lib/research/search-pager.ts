/** 没设定时的默认页数。采集端和「看对手」共用。 */
export const DEFAULT_SEARCH_PAGES = 3;
export const MIN_SEARCH_PAGES = 1;
export const MAX_SEARCH_PAGES = 20;

export function clampSearchPages(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SEARCH_PAGES;
  return Math.min(MAX_SEARCH_PAGES, Math.max(MIN_SEARCH_PAGES, Math.round(n)));
}

export function isNextPageLabel(text: string): boolean {
  const t = text.replace(/\s+/g, "");
  return (
    t === "下一页" ||
    t === "下一页>" ||
    t === "下一页›" ||
    t === ">" ||
    t === "›"
  );
}

export function pickNextPageControl<T>(
  candidates: Array<{
    item: T;
    text: string;
    ariaLabel?: string;
    disabled?: boolean;
  }>,
): T | undefined {
  const usable = candidates.filter((candidate) => !candidate.disabled);
  const labeled = usable.find(
    (candidate) =>
      candidate.ariaLabel === "下一页" ||
      isNextPageLabel(candidate.ariaLabel ?? ""),
  );
  if (labeled) return labeled.item;

  const matches = usable.filter((candidate) => isNextPageLabel(candidate.text));
  return matches.at(-1)?.item;
}

export function cookiesFromHeader(
  cookieHeader: string,
  domain = ".goofish.com",
): Array<{ name: string; value: string; domain: string; path: string }> {
  const cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
  }> = [];
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    if (!name) continue;
    cookies.push({
      name,
      value: trimmed.slice(eq + 1),
      domain,
      path: "/",
    });
  }
  return cookies;
}
