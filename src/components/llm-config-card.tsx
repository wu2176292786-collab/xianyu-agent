"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  clearImportedLlmConfig,
  importLlmConfig,
  listLlmModels,
  verifyLlmConfig,
} from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { LlmConfigView } from "@/lib/agent/llm-config";
import { relativeTime } from "@/lib/format";

/** 常见的 OpenAI 兼容服务商。填错 baseUrl 是最常见的坑，给几个现成的。 */
const PRESETS: Array<{ label: string; baseUrl: string; model: string }> = [
  { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  {
    label: "阿里百炼",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
  },
  { label: "月之暗面", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
  { label: "智谱", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
];

function statusLabel(view: LlmConfigView): { text: string; tone: "ok" | "warn" | "off" } {
  if (!view.configured) return { text: "未配置", tone: "off" };
  if (view.origin === "env") return { text: "环境变量", tone: "ok" };
  if (view.origin === "mixed") return { text: "本机配置 + 环境变量密钥", tone: "ok" };
  return { text: "本机配置", tone: "ok" };
}

export function LlmConfigCard({ view }: { view: LlmConfigView }) {
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(view.baseUrl);
  const [model, setModel] = useState(view.model);
  const [visionModel, setVisionModel] = useState(view.visionModel ?? "");
  const [hints, setHints] = useState(view.sendThinkingHints);
  const [models, setModels] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const status = statusLabel(view);

  const run = (fn: () => Promise<{ ok: boolean; message: string }>, clearKey = false) =>
    startTransition(async () => {
      const result = await fn();
      toast[result.ok ? "success" : "error"](result.message);
      if (result.ok && clearKey) setApiKey("");
      router.refresh();
    });

  const fetchModels = () =>
    startTransition(async () => {
      const result = await listLlmModels();
      setModels(result.models);
      toast[result.ok ? "success" : "error"](result.message);
    });

  const draft = {
    apiKey: apiKey.trim() || undefined,
    baseUrl: baseUrl.trim(),
    model: model.trim(),
    visionModel: visionModel.trim() || undefined,
  };

  // 改完没保存就点验证是常事，所以验证按钮验的是屏幕上这份，
  // 但得让人看见「这份还没存」，不然会以为已经生效了。
  const dirty =
    apiKey.trim().length > 0 ||
    baseUrl.trim() !== view.baseUrl ||
    model.trim() !== view.model ||
    (visionModel.trim() || undefined) !== view.visionModel ||
    hints !== view.sendThinkingHints;

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            模型接入
            <Badge variant={status.tone === "ok" ? "secondary" : "outline"}>
              {status.text}
            </Badge>
            {dirty ? (
              <Badge variant="outline" className="border-amber-300 text-amber-800">
                有改动没保存
              </Badge>
            ) : null}
          </CardTitle>
          <CardDescription>
            任何 OpenAI 兼容的服务都能用。密钥只写本机，页面不会回显原文。
          </CardDescription>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">填个现成的：</span>
          {PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              disabled={pending}
              onClick={() => {
                setBaseUrl(preset.baseUrl);
                setModel(preset.model);
              }}
              className="rounded-md border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              {preset.label}
            </button>
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="llm-key">API Key</Label>
            <Input
              id="llm-key"
              type="password"
              value={apiKey}
              disabled={pending}
              spellCheck={false}
              autoComplete="off"
              placeholder={view.maskedKey ? `已保存 ${view.maskedKey}，要换就填新的` : "sk-…"}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </div>

          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="llm-base">接口地址</Label>
            <Input
              id="llm-base"
              value={baseUrl}
              disabled={pending}
              spellCheck={false}
              placeholder="https://api.openai.com/v1"
              onChange={(event) => setBaseUrl(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              要带到 `/v1` 这一层，我们会在后面拼 `/chat/completions`。
            </p>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="llm-model">文本模型</Label>
              <button
                type="button"
                disabled={pending || !view.configured}
                onClick={fetchModels}
                className="text-xs text-muted-foreground underline underline-offset-2 disabled:opacity-50"
              >
                {models.length > 0 ? `已列出 ${models.length} 个` : "拉取可用模型"}
              </button>
            </div>
            <Input
              id="llm-model"
              value={model}
              disabled={pending}
              spellCheck={false}
              list="llm-model-options"
              placeholder="gpt-4o-mini"
              onChange={(event) => setModel(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              回复润色、文案润色、对照分析、选品问答都用它。
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="llm-vision">看图模型（可选）</Label>
            <Input
              id="llm-vision"
              value={visionModel}
              disabled={pending}
              spellCheck={false}
              list="llm-model-options"
              placeholder="留空就不看图"
              onChange={(event) => setVisionModel(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              配了之后同行筛选会看封面判断同款。没配就只看标题和正文。
            </p>
          </div>
        </div>

        {/* 两个模型框共用同一份候选。拉不到列表也不影响手填。 */}
        <datalist id="llm-model-options">
          {models.map((id) => (
            <option key={id} value={id} />
          ))}
        </datalist>

        <label className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={hints}
            disabled={pending}
            onChange={(event) => setHints(event.target.checked)}
          />
          <span className="text-muted-foreground">
            带上关闭推理过程的字段（`thinking` / `reasoning_split`）。MiniMax、DeepSeek
            这类推理模型靠它少输出思考过程；如果你的网关报「未知参数」之类的 400，就把它关掉。
          </span>
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              run(() => importLlmConfig({ ...draft, sendThinkingHints: hints }), true)
            }
          >
            {pending ? "处理中…" : dirty ? "保存改动" : "保存"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !(view.configured || apiKey.trim().length > 0)}
            onClick={() => run(() => verifyLlmConfig(draft))}
          >
            {dirty ? "验证这份改动" : "验证是否可用"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending || view.origin === "env" || view.origin === "none"}
            onClick={() => {
              const back = view.hasEnv ? "退回环境变量那份" : "之后模型功能会停用";
              if (!window.confirm(`确定清除本机模型配置？${back}。`)) return;
              run(() => clearImportedLlmConfig());
            }}
          >
            清除
          </Button>
        </div>

        {view.hasEnv ? (
          <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            `.env.local` 里配了 OPENAI_API_KEY。这里保存的配置会盖在它上面，
            密钥留空就继续用它那份 —— 所以换模型不用重贴密钥。点「清除」就退回环境变量。
          </p>
        ) : null}

        <div className="space-y-1 rounded-md border bg-muted/40 px-3 py-2 text-xs">
          <p className={view.configured ? "" : "text-amber-700"}>{view.detail}</p>
          {view.configured ? (
            <p className="text-muted-foreground">
              {view.baseUrl}
              {view.maskedKey ? ` · 密钥 ${view.maskedKey}` : ""}
              {view.origin === "file" || view.origin === "mixed"
                ? " · 本机 .secrets/llm-config.json"
                : ""}
              {view.savedAt ? ` · 保存于 ${relativeTime(view.savedAt)}` : ""}
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
