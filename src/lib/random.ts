/**
 * 固定种子的伪随机数。
 *
 * 示例数据和模拟同步都用它，保证同样的输入永远得到同样的结果 ——
 * 否则测试和截图每次都不一样。
 */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
