"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { nextDueTaskId } from "@/lib/research/analysis";
import { cn } from "@/lib/utils";

export interface NavItem {
  href: string;
  label: string;
  icon: string;
  badge?: number;
  /** 有值时角标单独可点，按这个顺序一个一个跳到对应任务。 */
  badgeStops?: string[];
  /** 只高亮自己，不把子路径算进来（「自动化」不要把「账号登录」也点亮） */
  exact?: boolean;
}

function currentResearchTaskId(pathname: string): string | undefined {
  if (pathname !== "/research" || typeof window === "undefined") return undefined;
  return new URLSearchParams(window.location.search).get("task") ?? undefined;
}

function researchTaskHref(taskId: string): string {
  return `/research?task=${encodeURIComponent(taskId)}`;
}

export function NavLinks({
  items,
  onNavigate,
}: {
  items: NavItem[];
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <nav className="flex flex-col gap-1">
      {items.map((item) => {
        const active = item.exact || item.href === "/"
          ? pathname === item.href
          : pathname === item.href || pathname.startsWith(`${item.href}/`);
        const stops = item.badgeStops?.filter(Boolean) ?? [];
        const firstStop = stops[0];
        const rowClass = cn(
          "group flex items-center rounded-lg text-sm transition-colors",
          active
            ? "bg-primary/20 font-medium text-foreground"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        );
        const badgeClass = cn(
          "min-w-5 rounded-full px-1.5 py-0.5 text-center text-xs font-medium tabular-nums",
          active
            ? "bg-foreground text-background"
            : "bg-muted text-muted-foreground group-hover:bg-background",
        );

        if (item.badge && firstStop) {
          return (
            <div key={item.href} className={rowClass}>
              <Link
                href={item.href}
                onClick={onNavigate}
                className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2"
              >
                <span aria-hidden className="text-base leading-none">
                  {item.icon}
                </span>
                <span className="flex-1">{item.label}</span>
              </Link>
              <Link
                href={researchTaskHref(firstStop)}
                title={
                  stops.length > 1
                    ? `有 ${item.badge} 件该回访，点一下跳到下一个任务`
                    : `有 ${item.badge} 件该回访，点一下跳到这个任务`
                }
                aria-label={
                  stops.length > 1
                    ? `待回访 ${item.badge}，跳到下一个任务`
                    : `待回访 ${item.badge}，跳到这个任务`
                }
                onClick={(event) => {
                  const next = nextDueTaskId(
                    stops,
                    currentResearchTaskId(pathname),
                  );
                  const target = next ? researchTaskHref(next) : item.href;
                  onNavigate?.();
                  if (target === researchTaskHref(firstStop)) return;
                  event.preventDefault();
                  router.push(target);
                }}
                className={cn(badgeClass, "mr-2")}
              >
                {item.badge}
              </Link>
            </div>
          );
        }

        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={cn(rowClass, "gap-3 px-3 py-2")}
          >
            <span aria-hidden className="text-base leading-none">
              {item.icon}
            </span>
            <span className="flex-1">{item.label}</span>
            {item.badge ? <span className={badgeClass}>{item.badge}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}
