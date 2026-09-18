"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { askResearchQuestion } from "@/app/actions";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

export function ResearchAskCard({
  taskId,
  llmConfigured,
}: {
  taskId: string;
  llmConfigured: boolean;
}) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [notice, setNotice] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();

  const ask = () =>
    startTransition(async () => {
      const result = await askResearchQuestion({ question, taskId });
      if (!result.ok) {
        setAnswer("");
        setNotice("");
        setTools(result.tools ?? []);
        toast.error(result.message);
        return;
      }
      setAnswer(result.answer ?? "");
      setNotice(result.message);
      setTools(result.tools ?? []);
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">问观察</CardTitle>
        <CardDescription>
          只读已经入库的价格和热度，不会去打开闲鱼。数字对不上材料整段不显示。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Textarea
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="这家店最近在降价吗？"
          rows={3}
          disabled={pending || !llmConfigured}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={pending || !llmConfigured}
            onClick={ask}
          >
            {pending ? "正在看…" : "问一句"}
          </Button>
          <p className="text-xs text-muted-foreground">
            {llmConfigured ? "答案只根据库里的观察。" : "还没配置模型，没法问答。"}
          </p>
        </div>
        {notice ? (
          <p className="text-xs text-muted-foreground">{notice}</p>
        ) : null}
        {tools.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            调了 {tools.join("、")}
          </p>
        ) : null}
        {answer ? (
          <div className="whitespace-pre-wrap rounded-md border bg-muted/30 px-3 py-2 text-sm leading-6">
            {answer}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
