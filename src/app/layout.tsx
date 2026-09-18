import type { Metadata } from "next";
import Link from "next/link";
import { Geist_Mono, Noto_Sans_SC } from "next/font/google";
import { AgentTickButton } from "@/components/agent-tick-button";
import { MobileNav } from "@/components/mobile-nav";
import { NavLinks, type NavItem } from "@/components/nav-links";
import { Toaster } from "@/components/ui/sonner";
import { WRITE_MODE_LABEL } from "@/lib/adapters/guard";
import { credentialStatus } from "@/lib/adapters/live/credentials";
import { llmStatus } from "@/lib/agent/llm";
import { nowMs, relativeTime } from "@/lib/format";
import { researchDueCount, researchDueTaskIds } from "@/lib/research/analysis";
import { clampWatchIntervalHours } from "@/lib/research/heat";
import { getState } from "@/lib/store";
import "./globals.css";

const sans = Noto_Sans_SC({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
});

const mono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "闲鱼运营 Agent · Xianyu Ops Agent",
  description:
    "为闲鱼卖家做的运营助手：盯商品、盯消息，按规则给出可审批的操作建议。",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const state = await getState();
  const pending = state.actions.filter((a) => a.status === "pending").length;
  const failed = state.actions.filter((a) => a.status === "failed").length;
  const needsReply = state.conversations.filter((c) => c.status === "needs_reply").length;
  // 该回访的同行数。时间线的密度等于回访的密度，所以这个数值得放在导航上提醒。
  const now = nowMs();
  const watchIntervalHours = clampWatchIntervalHours(state.research.watchIntervalHours);
  const dueTaskIds = researchDueTaskIds(
    state.research.tasks,
    state.research.rivals,
    now,
    watchIntervalHours,
  );
  const revisitDue = state.research.tasks
    .filter((task) => task.status === "active")
    .reduce(
      (acc, task) =>
        acc + researchDueCount(task, state.research.rivals, now, watchIntervalHours),
      0,
    );

  const llm = llmStatus();
  const credentials = await credentialStatus();

  const navItems: NavItem[] = [
    { href: "/", label: "总览", icon: "📊" },
    { href: "/queue", label: "行动队列", icon: "✅", badge: pending + failed },
    { href: "/inbox", label: "消息", icon: "💬", badge: needsReply },
    { href: "/listings", label: "商品", icon: "🏷️" },
    {
      href: "/research",
      label: "选品研究",
      icon: "🔍",
      badge: revisitDue,
      badgeStops: dueTaskIds,
    },
    { href: "/automations", label: "自动化", icon: "⚙️", exact: true },
    {
      href: "/automations/login",
      label: "账号登录",
      icon: "🔑",
      badge: credentials.configured ? undefined : 1,
    },
  ];

  return (
    <html
      lang="zh-CN"
      className={`${sans.variable} ${mono.variable} h-full antialiased`}
      // 沉浸式翻译这类扩展会在 React 之前往 <html> 上挂属性，
      // 只压掉这一个标签的属性告警，组件里真正的 hydration 问题照样会报。
      suppressHydrationWarning
    >
      <body className="h-full overflow-hidden bg-muted/40">
        <div className="flex h-dvh overflow-hidden">
          <aside className="hidden h-full w-64 shrink-0 flex-col overflow-hidden border-r bg-background lg:flex">
            <div className="flex items-center gap-2 border-b px-5 py-4">
              <span aria-hidden className="text-xl">
                🐟
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{state.settings.shopName}</p>
                <p className="text-xs text-muted-foreground">闲鱼运营 Agent v1</p>
              </div>
            </div>
            <div className="space-y-1 border-b px-5 py-3 text-xs text-muted-foreground">
              <p>写通道：{WRITE_MODE_LABEL[state.channel.write]}</p>
              <p>回复模型：{llm.configured ? llm.model : "内置模板（未配置 LLM）"}</p>
              <p>
                自动巡检：
                {state.settings.autoTickEnabled
                  ? `每 ${state.settings.autoTickMinutes} 分钟`
                  : "已关闭"}
              </p>
              <p>
                上次巡检：
                {state.lastTickAt ? relativeTime(state.lastTickAt) : "还没跑过"}
              </p>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <NavLinks items={navItems} />
            </div>
          </aside>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <header className="z-20 flex items-center gap-3 border-b bg-background/85 px-4 py-3 backdrop-blur sm:px-6">
              <MobileNav items={navItems} shopName={state.settings.shopName} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {failed > 0
                    ? `有 ${failed} 条动作执行失败，需要你看一眼`
                    : pending > 0
                      ? `有 ${pending} 条建议等你确认`
                      : needsReply > 0
                        ? `有 ${needsReply} 条买家消息待回复`
                        : "当前没有待办，一切正常"}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {state.lastTickAt
                    ? `Agent 上次巡检于 ${relativeTime(state.lastTickAt)}`
                    : "Agent 还没跑过，点右边按钮开始"}
                </p>
              </div>
              <AgentTickButton size="sm" />
            </header>
            {state.safety.paused || state.channel.write !== "mock" ? (
              <div
                className={
                  state.safety.paused
                    ? "border-b border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-800 sm:px-6"
                    : state.channel.write === "live"
                      ? "border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 sm:px-6"
                      : "border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 sm:px-6"
                }
              >
                {state.safety.paused ? (
                  <>
                    <strong className="font-medium">已急停</strong> ——
                    所有写操作都被拦下。{state.safety.pausedReason ?? ""}
                  </>
                ) : state.channel.write === "live" ? (
                  <>
                    <strong className="font-medium">
                      {WRITE_MODE_LABEL[state.channel.write]}
                    </strong>{" "}
                    —— 回复会发到闲鱼。擦亮、改价、下架、发货还没接到真实接口。
                  </>
                ) : (
                  <>
                    <strong className="font-medium">
                      {WRITE_MODE_LABEL[state.channel.write]}
                    </strong>{" "}
                    —— 这个模式下「执行」不会真的改变任何东西。
                  </>
                )}{" "}
                <Link href="/automations" className="underline underline-offset-2">
                  去设置
                </Link>
              </div>
            ) : null}
            <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
              {children}
            </main>
          </div>
        </div>
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
