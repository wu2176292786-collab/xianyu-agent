"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { draftReplyFor, sendReply } from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { INTENT_LABEL, awaitingSellerReply, classifyIntent } from "@/lib/agent/reply";
import type { Conversation, Listing } from "@/lib/domain/types";
import { clockTime, relativeTime, yuan } from "@/lib/format";
import { cn } from "@/lib/utils";

function lastMessage(conversation: Conversation) {
  return conversation.messages.at(-1);
}

export function InboxView({
  conversations,
  listings,
}: {
  conversations: Conversation[];
  listings: Listing[];
}) {
  const listingById = useMemo(
    () => new Map(listings.map((l) => [l.id, l] as const)),
    [listings],
  );

  const ordered = useMemo(
    () =>
      [...conversations].sort((a, b) => {
        const aNeeds = awaitingSellerReply(a) ? 0 : 1;
        const bNeeds = awaitingSellerReply(b) ? 0 : 1;
        if (aNeeds !== bNeeds) return aNeeds - bNeeds;
        return (
          Date.parse(lastMessage(b)?.createdAt ?? "") -
          Date.parse(lastMessage(a)?.createdAt ?? "")
        );
      }),
    [conversations],
  );

  const [selectedId, setSelectedId] = useState(ordered[0]?.id ?? "");
  const [draft, setDraft] = useState("");
  const [draftOwner, setDraftOwner] = useState(selectedId);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const selected = ordered.find((c) => c.id === selectedId) ?? ordered[0];

  // 切换会话时丢掉上一条草稿，避免把回复发错人。
  if (draftOwner !== selectedId) {
    setDraftOwner(selectedId);
    setDraft("");
  }

  if (!selected) {
    return (
      <div className="rounded-lg border border-dashed px-6 py-16 text-center">
        <p className="text-sm font-medium">收件箱是空的</p>
        <p className="mt-1 text-sm text-muted-foreground">买家发来消息后会显示在这里。</p>
      </div>
    );
  }

  const listing = listingById.get(selected.listingId);
  const needsReply = awaitingSellerReply(selected);

  const generate = () =>
    startTransition(async () => {
      const result = await draftReplyFor(selected.id);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setDraft(result.text);
      toast.success(result.message);
    });

  const send = () =>
    startTransition(async () => {
      const result = await sendReply(selected.id, draft);
      toast[result.ok ? "success" : "error"](result.message);
      if (result.ok) {
        setDraft("");
        router.refresh();
      }
    });

  return (
    <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
      <div className="rounded-lg border bg-background">
        <div className="max-h-72 overflow-y-auto lg:max-h-[70vh]">
          {ordered.map((conversation) => {
            const item = lastMessage(conversation);
            const conversationListing = listingById.get(conversation.listingId);
            const intent = item
              ? classifyIntent(
                  [...conversation.messages].reverse().find((m) => m.author === "buyer")?.text ??
                    item.text,
                  conversationListing,
                )
              : "other";
            return (
              <button
                key={conversation.id}
                type="button"
                onClick={() => setSelectedId(conversation.id)}
                className={cn(
                  "flex w-full gap-3 border-b px-4 py-3 text-left transition-colors last:border-b-0",
                  conversation.id === selected.id ? "bg-accent" : "hover:bg-muted/60",
                )}
              >
                <span aria-hidden className="mt-0.5 text-xl leading-none">
                  {conversation.buyerEmoji}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium">{conversation.buyerName}</p>
                    {awaitingSellerReply(conversation) ? (
                      <span className="size-1.5 shrink-0 rounded-full bg-rose-500" />
                    ) : null}
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {item ? relativeTime(item.createdAt) : ""}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {conversationListing?.title ?? "未知商品"}
                  </p>
                  <p className="mt-1 line-clamp-1 text-sm text-muted-foreground">
                    {item?.author === "seller" ? "我：" : ""}
                    {item?.text}
                  </p>
                  <Badge variant="outline" className="mt-1.5 text-[11px]">
                    {INTENT_LABEL[intent]}
                  </Badge>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex min-h-[28rem] flex-col rounded-lg border bg-background">
        <div className="flex flex-wrap items-start justify-between gap-2 border-b px-4 py-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm font-medium">
              <span aria-hidden>{selected.buyerEmoji}</span>
              {selected.buyerName}
              {needsReply ? <Badge variant="secondary">待回复</Badge> : null}
            </p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {listing ? `${listing.emoji} ${listing.title}` : "未知商品"}
            </p>
          </div>
          {listing ? (
            <div className="text-right text-xs text-muted-foreground">
              <p className="text-sm font-medium text-foreground tabular-nums">
                {yuan(listing.priceCents)}
              </p>
              <p>底价 {yuan(listing.floorPriceCents)}</p>
            </div>
          ) : null}
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {selected.messages.map((message) => (
            <div
              key={message.id}
              className={cn(
                "flex flex-col gap-1",
                message.author === "seller" ? "items-end" : "items-start",
              )}
            >
              <div
                className={cn(
                  "max-w-[80%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap",
                  message.author === "seller"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted",
                )}
              >
                {message.text}
              </div>
              <span className="text-[11px] text-muted-foreground">
                {clockTime(message.createdAt)}
                {message.viaAgent ? " · Agent 起草" : ""}
              </span>
            </div>
          ))}
        </div>

        <div className="space-y-2 border-t px-4 py-3">
          <Textarea
            rows={3}
            value={draft}
            placeholder="写一条回复，或者让 Agent 先起草…"
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={pending} onClick={generate}>
              {pending ? "处理中…" : "让 Agent 起草"}
            </Button>
            <Button size="sm" disabled={pending || draft.trim().length === 0} onClick={send}>
              发送
            </Button>
            <p className="ml-auto text-xs text-muted-foreground">
              发送前请自己再看一眼，Agent 只负责起草。
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
