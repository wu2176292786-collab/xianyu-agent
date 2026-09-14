"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { approveActionWithEdits, decideAction } from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { AgentAction, RiskLevel } from "@/lib/domain/types";
import { relativeTime, yuanPlain } from "@/lib/format";
import { cn } from "@/lib/utils";

const RISK_LABEL: Record<RiskLevel, string> = {
  low: "低风险",
  medium: "涉及金额",
  high: "需谨慎",
};

const RISK_STYLE: Record<RiskLevel, string> = {
  low: "bg-emerald-50 text-emerald-700 border-emerald-200",
  medium: "bg-amber-50 text-amber-800 border-amber-200",
  high: "bg-rose-50 text-rose-700 border-rose-200",
};

function payloadPreview(action: AgentAction) {
  switch (action.payload.type) {
    case "send_reply":
      return action.payload.text;
    case "ship_order":
      return `${action.payload.carrier} · ${action.payload.trackingNo}`;
    case "adjust_price":
      return `¥${yuanPlain(action.payload.fromCents)} → ¥${yuanPlain(action.payload.toCents)}`;
    default:
      return null;
  }
}

export function ActionCard({ action }: { action: AgentAction }) {
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(
    action.payload.type === "send_reply" ? action.payload.text : "",
  );
  const [price, setPrice] = useState(
    action.payload.type === "adjust_price" ? yuanPlain(action.payload.toCents) : "",
  );
  const [carrier, setCarrier] = useState(
    action.payload.type === "ship_order" ? action.payload.carrier : "",
  );
  const [trackingNo, setTrackingNo] = useState(
    action.payload.type === "ship_order" ? action.payload.trackingNo : "",
  );
  const router = useRouter();

  const editable = action.payload.type !== "refresh_listing" && action.payload.type !== "delist_listing";
  const preview = payloadPreview(action);

  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    startTransition(async () => {
      const result = await fn();
      toast[result.ok ? "success" : "error"](result.message);
      if (result.ok) setEditing(false);
      router.refresh();
    });

  return (
    <Card className="gap-3 py-4">
      <CardContent className="space-y-3 px-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium">{action.title}</p>
            <p className="text-xs text-muted-foreground">{action.reason}</p>
          </div>
          <Badge variant="outline" className={cn("shrink-0", RISK_STYLE[action.risk])}>
            {RISK_LABEL[action.risk]}
          </Badge>
        </div>

        {preview ? (
          <div className="rounded-md border bg-muted/50 px-3 py-2 text-sm whitespace-pre-wrap">
            {preview}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={pending} onClick={() => run(() => decideAction(action.id, "approve"))}>
            通过并执行
          </Button>
          {editable ? (
            <Button size="sm" variant="outline" disabled={pending} onClick={() => setEditing(true)}>
              编辑后通过
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => run(() => decideAction(action.id, "reject"))}
          >
            忽略
          </Button>
          <span className="ml-auto text-xs text-muted-foreground">
            {relativeTime(action.createdAt)}
          </span>
        </div>
      </CardContent>

      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>修改后执行</DialogTitle>
            <DialogDescription>{action.title}</DialogDescription>
          </DialogHeader>

          {action.payload.type === "send_reply" ? (
            <div className="space-y-2">
              <Label htmlFor={`text-${action.id}`}>回复内容</Label>
              <Textarea
                id={`text-${action.id}`}
                rows={6}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
            </div>
          ) : null}

          {action.payload.type === "adjust_price" ? (
            <div className="space-y-2">
              <Label htmlFor={`price-${action.id}`}>新价格（元）</Label>
              <Input
                id={`price-${action.id}`}
                value={price}
                inputMode="decimal"
                onChange={(event) => setPrice(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                低于商品底价会被拒绝，这是 Agent 的安全线。
              </p>
            </div>
          ) : null}

          {action.payload.type === "ship_order" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor={`carrier-${action.id}`}>快递公司</Label>
                <Input
                  id={`carrier-${action.id}`}
                  value={carrier}
                  onChange={(event) => setCarrier(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`tracking-${action.id}`}>运单号</Label>
                <Input
                  id={`tracking-${action.id}`}
                  value={trackingNo}
                  onChange={(event) => setTrackingNo(event.target.value)}
                />
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(false)} disabled={pending}>
              取消
            </Button>
            <Button
              disabled={pending}
              onClick={() =>
                run(() =>
                  approveActionWithEdits(action.id, {
                    text: action.payload.type === "send_reply" ? text : undefined,
                    priceInput: action.payload.type === "adjust_price" ? price : undefined,
                    carrier: action.payload.type === "ship_order" ? carrier : undefined,
                    trackingNo: action.payload.type === "ship_order" ? trackingNo : undefined,
                  }),
                )
              }
            >
              确认执行
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
