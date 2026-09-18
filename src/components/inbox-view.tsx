"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { draftReplyFor, sendReply } from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { INTENT_LABEL, classifyIntent, lastActivityAt } from "@/lib/agent/reply";
import type { Conversation, Listing } from "@/lib/domain/types";
import { clockTime, relativeTime, yuan } from "@/lib/format";
import { cn } from "@/lib/utils";

function lastMessage(conversation: Conversation) {
  return conversation.messages.at(-1);
}

function productOf(conversation: Conversation, listing: Listing | undefined) {
  const title = listing?.title ?? conversation.listingTitle;
  const priceCents = listing?.priceCents ?? conversation.listingPriceCents;
  return {
    title,
    priceCents,
    floorPriceCents: listing?.floorPriceCents,
    emoji: listing?.emoji ?? "📦",
  };
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
        const aHot = a.status === "needs_reply" ? 0 : 1;
        const bHot = b.status === "needs_reply" ? 0 : 1;
        if (aHot !== bHot) return aHot - bHot;
        return lastActivityAt(b) - lastActivityAt(a);
      }),
    [conversations],
  );

  const [selectedId, setSelectedId] = useState(ordered[0]?.id ?? "");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const threadRef = useRef<HTMLDivElement>(null);

  const selected = ordered.find((c) => c.id === selectedId) ?? ordered[0];

  useEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    thread.scrollTop = thread.scrollHeight;
  }, [selected?.id, selected?.messages.length]);

  if (!selected) {
    return (
      <div className="rounded-lg border border-dashed px-6 py-16 text-center">
        <p className="text-sm font-medium">收件箱是空的</p>
        <p className="mt-1 text-sm text-muted-foreground">买家发来消息后会显示在这里。</p>
      </div>
    );
  }

  const listing = listingById.get(selected.listingId);
  const selectedProduct = productOf(selected, listing);
  const needsReply = selected.status === "needs_reply";
  const draft = drafts[selected.id] ?? "";

  const generate = () =>
    startTransition(async () => {
      const result = await draftReplyFor(selected.id);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setDrafts((current) => ({ ...current, [selected.id]: result.text }));
      toast.success(result.message);
    });

  const send = () =>
    startTransition(async () => {
      const result = await sendReply(selected.id, draft);
      toast[result.ok ? "success" : "error"](result.message);
      if (result.ok) {
        setDrafts((current) => ({ ...current, [selected.id]: "" }));
        router.refresh();
      }
    });

  return (
    <div className="grid gap-4 lg:h-[min(44rem,calc(100dvh-12rem))] lg:grid-cols-[22rem_1fr]">
      <div className="flex min-h-0 flex-col rounded-lg border bg-background">
        <div className="max-h-72 min-h-0 overflow-y-auto lg:max-h-none lg:flex-1">
          {ordered.map((conversation) => {
            const item = lastMessage(conversation);
            const conversationListing = listingById.get(conversation.listingId);
            const product = productOf(conversation, conversationListing);
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
                    {conversation.status === "needs_reply" ? (
                      <span className="size-1.5 shrink-0 rounded-full bg-rose-500" />
                    ) : null}
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {item ? relativeTime(item.createdAt) : ""}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {product.title ?? "未知商品"}
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

      <div className="flex min-h-[28rem] max-h-[min(40rem,70vh)] flex-col rounded-lg border bg-background lg:max-h-none lg:min-h-0">
        <div className="flex shrink-0 flex-wrap items-start justify-between gap-2 border-b px-4 py-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm font-medium">
              <span aria-hidden>{selected.buyerEmoji}</span>
              {selected.buyerName}
              {needsReply ? <Badge variant="secondary">待回复</Badge> : null}
            </p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {selectedProduct.title
                ? `${selectedProduct.emoji} ${selectedProduct.title}`
                : "未知商品"}
            </p>
          </div>
          {selectedProduct.priceCents !== undefined ? (
            <div className="text-right text-xs text-muted-foreground">
              <p className="text-sm font-medium text-foreground tabular-nums">
                {yuan(selectedProduct.priceCents)}
              </p>
              {selectedProduct.floorPriceCents !== undefined ? (
                <p>底价 {yuan(selectedProduct.floorPriceCents)}</p>
              ) : null}
            </div>
          ) : null}
        </div>

        <div ref={threadRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
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

        <div className="shrink-0 space-y-2 border-t px-4 py-3">
          <Textarea
            rows={3}
            value={draft}
            placeholder="写一条回复，或者让 Agent 先起草…"
            onChange={(event) =>
              setDrafts((current) => ({ ...current, [selected.id]: event.target.value }))
            }
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
