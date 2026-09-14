import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function StatCard({
  label,
  value,
  hint,
  delta,
  icon,
}: {
  label: string;
  value: string;
  hint?: string;
  /** 环比变化，正数向上 */
  delta?: number;
  icon: string;
}) {
  return (
    <Card className="gap-0 py-4">
      <CardContent className="px-4">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm text-muted-foreground">{label}</p>
          <span aria-hidden className="text-base leading-none">
            {icon}
          </span>
        </div>
        <p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
        <div className="mt-1 flex items-center gap-2 text-xs">
          {typeof delta === "number" && Number.isFinite(delta) ? (
            <span
              className={cn(
                "font-medium tabular-nums",
                delta >= 0 ? "text-emerald-600" : "text-rose-600",
              )}
            >
              {delta >= 0 ? "▲" : "▼"} {Math.abs(delta * 100).toFixed(1)}%
            </span>
          ) : null}
          {hint ? <span className="text-muted-foreground">{hint}</span> : null}
        </div>
      </CardContent>
    </Card>
  );
}
