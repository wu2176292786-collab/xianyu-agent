"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { setRuleApproval, setRuleEnabled, updateRuleParam } from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { AutomationRule } from "@/lib/domain/types";

const PARAM_LABEL: Record<string, string> = {
  minHoursSinceRefresh: "擦亮间隔（小时）",
  maxPerRun: "每轮最多处理",
  staleDays: "滞销判定（天）",
  maxViews7d: "7 天浏览低于",
  stepPercent: "每次降价（%）",
  graceHours: "超时阈值（小时）",
};

function ParamInput({
  rule,
  paramKey,
  value,
  onSaved,
}: {
  rule: AutomationRule;
  paramKey: string;
  value: number;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [pending, startTransition] = useTransition();

  const commit = () => {
    if (draft === String(value)) return;
    startTransition(async () => {
      const result = await updateRuleParam(rule.id, paramKey, draft);
      if (!result.ok) {
        toast.error(result.message);
        setDraft(String(value));
        return;
      }
      onSaved();
    });
  };

  return (
    <div className="space-y-1.5">
      <Label htmlFor={`${rule.id}-${paramKey}`} className="text-xs text-muted-foreground">
        {PARAM_LABEL[paramKey] ?? paramKey}
      </Label>
      <Input
        id={`${rule.id}-${paramKey}`}
        className="h-8"
        inputMode="numeric"
        value={draft}
        disabled={pending}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
    </div>
  );
}

export function RuleCard({ rule }: { rule: AutomationRule }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const toggle = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    startTransition(async () => {
      const result = await fn();
      toast[result.ok ? "success" : "error"](result.message);
      router.refresh();
    });

  const paramKeys = Object.keys(rule.params);

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            {rule.name}
            <Badge variant={rule.requiresApproval ? "outline" : "secondary"}>
              {rule.requiresApproval ? "人工审批" : "自动执行"}
            </Badge>
          </CardTitle>
          <p className="text-sm text-muted-foreground">{rule.description}</p>
        </div>
        <Switch
          checked={rule.enabled}
          disabled={pending}
          aria-label={`开关 ${rule.name}`}
          onCheckedChange={(checked) => toggle(() => setRuleEnabled(rule.id, checked))}
        />
      </CardHeader>
      <CardContent className="space-y-4">
        {paramKeys.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {paramKeys.map((key) => (
              <ParamInput
                key={key}
                rule={rule}
                paramKey={key}
                value={rule.params[key]}
                onSaved={() => router.refresh()}
              />
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">这条规则没有可调参数。</p>
        )}

        <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2">
          <div>
            <p className="text-sm">执行前需要我确认</p>
            <p className="text-xs text-muted-foreground">
              关掉之后，这条规则命中的动作会在巡检时直接执行。
            </p>
          </div>
          <Switch
            checked={rule.requiresApproval}
            disabled={pending || !rule.enabled}
            aria-label={`${rule.name} 是否需要审批`}
            onCheckedChange={(checked) => toggle(() => setRuleApproval(rule.id, checked))}
          />
        </div>
      </CardContent>
    </Card>
  );
}
