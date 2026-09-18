/**
 * 从任意 JSON 里按路径取值的小工具。
 *
 * 真实接口的字段名我们只能从抓包看到，而且淘系接口改字段是常事，
 * 所以每个字段都给一组候选路径，命中哪个算哪个 —— 比写死一条路径耐造。
 */
export function getPath(source: unknown, path: string): unknown {
  if (!path) return undefined;
  let current: unknown = source;

  for (const rawSegment of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    const arrayMatch = rawSegment.match(/^(.*?)\[(\d*)\]$/);
    const key = arrayMatch ? arrayMatch[1] : rawSegment;

    if (key) {
      if (typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[key];
    }

    if (arrayMatch) {
      if (!Array.isArray(current)) return undefined;
      const index = arrayMatch[2] === "" ? 0 : Number(arrayMatch[2]);
      current = current[index];
    }
  }

  return current;
}

export function getList(source: unknown, path: string): unknown[] {
  const value = path ? getPath(source, path) : source;
  return Array.isArray(value) ? value : [];
}

/** 按候选路径依次尝试，返回第一个非空值。 */
export function pick(source: unknown, paths: string[]): unknown {
  for (const path of paths) {
    const value = getPath(source, path);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

export function pickString(source: unknown, paths: string[]): string | undefined {
  const value = pick(source, paths);
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

export function pickNumber(source: unknown, paths: string[]): number | undefined {
  const value = pick(source, paths);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/[^\d.-]/g, "");
    // Number("") 是 0，直接判 isFinite 会把一段纯文字变成价格 0
    if (!/\d/.test(cleaned)) return undefined;
    const parsed = Number(cleaned);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asPositiveCount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/[^\d.-]/g, "");
    if (!/\d/.test(cleaned)) return undefined;
    const parsed = Number(cleaned);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

/**
 * 字段搬家时按路径会落空。沿对象往下找第一个叫这个名字、且大于 0 的数。
 */
export function findNumberByKey(
  source: unknown,
  keyTest: RegExp,
  depth = 0,
): number | undefined {
  if (depth > 8 || source === null || typeof source !== "object") return undefined;
  if (Array.isArray(source)) {
    for (const item of source.slice(0, 24)) {
      const hit = findNumberByKey(item, keyTest, depth + 1);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (keyTest.test(key)) {
      const count = asPositiveCount(value);
      if (count !== undefined) return count;
    }
    const nested = findNumberByKey(value, keyTest, depth + 1);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/** 列出一个对象上所有的叶子路径，给抓包排查用。 */
export function describeShape(source: unknown, prefix = "", depth = 0): string[] {
  if (depth > 4 || source === null || typeof source !== "object") {
    return prefix ? [`${prefix} = ${JSON.stringify(source)?.slice(0, 60)}`] : [];
  }
  if (Array.isArray(source)) {
    if (source.length === 0) return [`${prefix}[] (空数组)`];
    return describeShape(source[0], `${prefix}[0]`, depth + 1);
  }
  return Object.entries(source as Record<string, unknown>).flatMap(([key, value]) =>
    describeShape(value, prefix ? `${prefix}.${key}` : key, depth + 1),
  );
}
