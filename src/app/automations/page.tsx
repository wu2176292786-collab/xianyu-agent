import { AgentTickButton } from "@/components/agent-tick-button";
import { RuleCard } from "@/components/rule-card";
import { SettingsForm } from "@/components/settings-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { llmStatus } from "@/lib/agent/llm";
import { getState } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function AutomationsPage() {
  const state = await getState();
  const llm = llmStatus();
  const enabled = state.rules.filter((r) => r.enabled).length;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">自动化</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {enabled} / {state.rules.length} 条规则已开启。每次巡检都会按这些规则产生建议。
          </p>
        </div>
        <AgentTickButton size="sm" />
      </div>

      <div className="space-y-4">
        {state.rules.map((rule) => (
          <RuleCard key={rule.id} rule={rule} />
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>店铺设置</CardTitle>
          <CardDescription>
            这些数值决定了 Agent 敢让多少价、什么时候提醒你发货。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SettingsForm settings={state.settings} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>运行环境</CardTitle>
          <CardDescription>v1 默认全部走本地模拟，不会碰你的真实账号。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            <span className="text-muted-foreground">平台通道：</span>
            本地模拟通道（MockXianyuAdapter）
          </p>
          <p>
            <span className="text-muted-foreground">回复生成：</span>
            {llm.configured
              ? `内置模板 + ${llm.model} 润色`
              : "内置模板（设置 OPENAI_API_KEY 后会自动启用 LLM 润色）"}
          </p>
          <p>
            <span className="text-muted-foreground">数据存储：</span>
            本地 JSON 文件 .data/state.json
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
