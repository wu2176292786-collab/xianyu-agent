import type { DailyMetric } from "@/lib/domain/types";
import { yuan } from "@/lib/format";

const W = 720;
const H = 200;
const PAD_X = 8;
const PAD_TOP = 16;
const PAD_BOTTOM = 28;

function buildPath(values: number[], max: number) {
  const stepX = (W - PAD_X * 2) / Math.max(1, values.length - 1);
  const usable = H - PAD_TOP - PAD_BOTTOM;
  return values.map((value, index) => {
    const x = PAD_X + index * stepX;
    const y = PAD_TOP + usable * (1 - value / max);
    return { x, y };
  });
}

function smooth(points: Array<{ x: number; y: number }>) {
  if (points.length === 0) return "";
  return points
    .map((p, i) => {
      if (i === 0) return `M ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
      const prev = points[i - 1];
      const cx = (prev.x + p.x) / 2;
      return `C ${cx.toFixed(1)} ${prev.y.toFixed(1)}, ${cx.toFixed(1)} ${p.y.toFixed(1)}, ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
    })
    .join(" ");
}

/** 14 天曝光趋势 + 每日成交额柱状图，纯 SVG，服务端直接渲染。 */
export function TrendChart({ metrics }: { metrics: DailyMetric[] }) {
  if (metrics.length === 0) {
    return <p className="text-sm text-muted-foreground">暂时还没有数据。</p>;
  }

  const views = metrics.map((m) => m.views);
  const maxViews = Math.max(...views, 1) * 1.15;
  const points = buildPath(views, maxViews);
  const line = smooth(points);
  const area = `${line} L ${points.at(-1)!.x.toFixed(1)} ${H - PAD_BOTTOM} L ${points[0].x.toFixed(1)} ${H - PAD_BOTTOM} Z`;

  const maxGmv = Math.max(...metrics.map((m) => m.gmvCents), 1);
  const barWidth = (W - PAD_X * 2) / metrics.length - 6;

  return (
    <div className="space-y-4">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label="近 14 天曝光趋势"
      >
        <defs>
          <linearGradient id="viewsFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-1)" stopOpacity="0.45" />
            <stop offset="100%" stopColor="var(--chart-1)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75, 1].map((ratio) => (
          <line
            key={ratio}
            x1={PAD_X}
            x2={W - PAD_X}
            y1={PAD_TOP + (H - PAD_TOP - PAD_BOTTOM) * (1 - ratio)}
            y2={PAD_TOP + (H - PAD_TOP - PAD_BOTTOM) * (1 - ratio)}
            stroke="var(--border)"
            strokeDasharray="3 5"
          />
        ))}
        <path d={area} fill="url(#viewsFill)" />
        <path d={line} fill="none" stroke="var(--chart-2)" strokeWidth={2.5} />
        {points.map((p, i) => (
          <circle
            key={metrics[i].date}
            cx={p.x}
            cy={p.y}
            r={i === points.length - 1 ? 4 : 2}
            fill="var(--chart-2)"
          />
        ))}
        {metrics.map((m, i) => {
          if (i % 3 !== 0 && i !== metrics.length - 1) return null;
          return (
            <text
              key={m.date}
              x={points[i].x}
              y={H - 8}
              textAnchor={i === 0 ? "start" : i === metrics.length - 1 ? "end" : "middle"}
              fontSize="11"
              fill="var(--muted-foreground)"
            >
              {m.date.slice(5)}
            </text>
          );
        })}
      </svg>

      <div>
        <p className="mb-2 text-xs text-muted-foreground">每日成交额</p>
        <div className="flex h-16 items-end gap-1.5">
          {metrics.map((m) => (
            <div
              key={m.date}
              className="group relative flex-1 rounded-t bg-primary/70 transition-colors hover:bg-primary"
              style={{
                height: `${Math.max(4, (m.gmvCents / maxGmv) * 100)}%`,
                minWidth: `${Math.max(4, barWidth / 12)}px`,
              }}
              title={`${m.date}：${yuan(m.gmvCents)}（${m.orders} 单）`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
