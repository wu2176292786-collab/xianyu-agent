"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  type LoginStateView,
  clearImportedLoginState,
  importLoginState,
  verifyImportedLoginState,
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
import { Textarea } from "@/components/ui/textarea";
import { relativeTime } from "@/lib/format";

const EXTRACTOR_URL =
  "https://chromewebstore.google.com/detail/xianyu-login-state-extrac/eidlpfjiodpigmfcahkmlenhppfklcoa";

function statusLabel(view: LoginStateView): { text: string; tone: "ok" | "warn" | "off" } {
  if (!view.credentials.configured) return { text: "未导入", tone: "off" };
  if (view.origin === "env") return { text: "环境变量覆盖中", tone: "warn" };
  if (!view.credentials.hasSession) return { text: "像游客态", tone: "warn" };
  return { text: "已导入", tone: "ok" };
}

export function LoginStateCard({ view }: { view: LoginStateView }) {
  const [draft, setDraft] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const status = statusLabel(view);

  const run = (fn: () => Promise<{ ok: boolean; message: string }>, clearDraft = false) =>
    startTransition(async () => {
      const result = await fn();
      toast[result.ok ? "success" : "error"](result.message);
      if (result.ok && clearDraft) setDraft("");
      router.refresh();
    });

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            闲鱼登录态
            <Badge variant={status.tone === "ok" ? "secondary" : "outline"}>{status.text}</Badge>
          </CardTitle>
          <CardDescription>
            在浏览器里登录闲鱼，用扩展导出后粘到这里。内容只写本机，页面不会回显 cookie。
          </CardDescription>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
          <li>
            打开{" "}
            <a
              href="https://www.goofish.com"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              www.goofish.com
            </a>{" "}
            并确认已经登录。
          </li>
          <li>
            用 Chrome 扩展{" "}
            <a
              href={EXTRACTOR_URL}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              Xianyu Login State Extractor
            </a>{" "}
            点「提取」，内容会进剪贴板。
          </li>
          <li>粘到下面，点导入，再点验证。通过后回消息页「从平台同步」。</li>
        </ol>

        <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          这是第三方扩展，用完建议停用。导出内容等于账号，不要发给任何人。
        </p>

        <Textarea
          rows={8}
          value={draft}
          disabled={pending}
          spellCheck={false}
          autoComplete="off"
          placeholder="把扩展导出的 JSON，或整条 cookie 串，粘到这里…"
          onChange={(event) => setDraft(event.target.value)}
        />

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={pending || draft.trim().length === 0}
            onClick={() => run(() => importLoginState(draft), true)}
          >
            {pending ? "处理中…" : "导入"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !view.credentials.configured}
            onClick={() => run(() => verifyImportedLoginState())}
          >
            验证是否有效
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending || view.origin === "none"}
            onClick={() => {
              if (!window.confirm("确定清除本机保存的登录态？")) return;
              run(() => clearImportedLoginState());
            }}
          >
            清除
          </Button>
        </div>

        <div className="space-y-1 rounded-md border bg-muted/40 px-3 py-2 text-xs">
          <p className={view.credentials.configured ? "" : "text-amber-700"}>
            {view.credentials.detail}
          </p>
          {view.credentials.configured ? (
            <>
              <p className="text-muted-foreground">{view.description}</p>
              <p className="text-muted-foreground">
                来源：
                {view.origin === "env"
                  ? "环境变量 XIANYU_COOKIE（优先于本机文件）"
                  : "本机 .secrets/xianyu-login-state.json"}
                {view.capturedAt ? ` · 导出 ${relativeTime(view.capturedAt)}` : ""}
              </p>
            </>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
