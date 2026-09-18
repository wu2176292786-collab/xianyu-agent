"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  confirmFloorPrice,
  delistListing,
  refreshListing,
  scoutListingCompetition,
  updateListingPrice,
} from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Listing, ListingStatus } from "@/lib/domain/types";
import { relativeTime, yuan, yuanPlain } from "@/lib/format";

const STATUS: Record<ListingStatus, { label: string; variant: "default" | "secondary" | "outline" }> = {
  on_sale: { label: "在售", variant: "default" },
  sold_out: { label: "已售完", variant: "secondary" },
  delisted: { label: "已下架", variant: "outline" },
};

export function ListingsTable({ listings }: { listings: Listing[] }) {
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<Listing | null>(null);
  const [price, setPrice] = useState("");
  const [confirming, setConfirming] = useState<Listing | null>(null);
  const [floor, setFloor] = useState("");
  const router = useRouter();

  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    startTransition(async () => {
      const result = await fn();
      toast[result.ok ? "success" : "error"](result.message);
      if (result.ok) {
        setEditing(null);
        setConfirming(null);
      }
      router.refresh();
    });

  return (
    <>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-64">商品</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">价格 / 底价</TableHead>
              <TableHead className="text-right">库存</TableHead>
              <TableHead className="text-right">7 天浏览</TableHead>
              <TableHead className="text-right">想要 / 咨询</TableHead>
              <TableHead>上次擦亮</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {listings.map((listing) => (
              <TableRow key={listing.id}>
                <TableCell>
                  <div className="flex items-start gap-3">
                    <span aria-hidden className="text-xl leading-none">
                      {listing.emoji}
                    </span>
                    <div className="min-w-0">
                      <p className="line-clamp-2 text-sm font-medium">{listing.title}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {listing.category}
                        {listing.tags.length > 0 ? ` · ${listing.tags.join(" · ")}` : ""}
                      </p>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={STATUS[listing.status].variant}>
                    {STATUS[listing.status].label}
                  </Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <p className="font-medium">{yuan(listing.priceCents)}</p>
                  {listing.floorConfirmed ? (
                    <p className="text-xs text-muted-foreground">
                      底价 {yuan(listing.floorPriceCents)}
                    </p>
                  ) : (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => {
                        setConfirming(listing);
                        setFloor(yuanPlain(listing.floorPriceCents));
                      }}
                      className="text-xs text-amber-700 underline underline-offset-2"
                    >
                      底价待确认
                    </button>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">{listing.stock}</TableCell>
                {/* 平台没给热度数据时显示「—」，不显示 0 —— 0 会被当成「没人看」 */}
                <TableCell className="text-right tabular-nums">
                  {listing.metricsUnknown ? (
                    <span className="text-muted-foreground" title="平台这次没返回浏览量">
                      —
                    </span>
                  ) : (
                    listing.views7d.toLocaleString("zh-CN")
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {listing.metricsUnknown ? "—" : `${listing.wants} / ${listing.inquiries7d}`}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {relativeTime(listing.lastRefreshedAt)}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => {
                        startTransition(async () => {
                          const result = await scoutListingCompetition(listing.id);
                          toast[result.ok ? "success" : "error"](result.message);
                          if (result.ok && result.taskId) {
                            router.push(`/research?task=${result.taskId}`);
                            return;
                          }
                          router.refresh();
                        });
                      }}
                    >
                      看对手
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending || listing.status !== "on_sale"}
                      onClick={() => run(() => refreshListing(listing.id))}
                    >
                      擦亮
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => {
                        setEditing(listing);
                        setPrice(yuanPlain(listing.priceCents));
                      }}
                    >
                      改价
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending || listing.status === "delisted"}
                      onClick={() => run(() => delistListing(listing.id))}
                    >
                      下架
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>修改价格</DialogTitle>
            <DialogDescription className="line-clamp-2">{editing?.title}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="listing-price">新价格（元）</Label>
            <Input
              id="listing-price"
              value={price}
              inputMode="decimal"
              onChange={(event) => setPrice(event.target.value)}
            />
            {editing ? (
              <p className="text-xs text-muted-foreground">
                当前 {yuan(editing.priceCents)}，底价 {yuan(editing.floorPriceCents)}
                ，低于底价会被拒绝。
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(null)} disabled={pending}>
              取消
            </Button>
            <Button
              disabled={pending || !editing}
              onClick={() => editing && run(() => updateListingPrice(editing.id, price))}
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>确认底价</DialogTitle>
            <DialogDescription className="line-clamp-2">
              {confirming?.title}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="listing-floor">底价（元）</Label>
            <Input
              id="listing-floor"
              value={floor}
              inputMode="decimal"
              onChange={(event) => setFloor(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              这件商品是同步进来的，当前底价是按挂牌价估的。确认之前，自动降价会绕开它 ——
              拿一个猜出来的底价去降价，等于没有底价。
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(null)} disabled={pending}>
              取消
            </Button>
            <Button
              disabled={pending || !confirming}
              onClick={() =>
                confirming && run(() => confirmFloorPrice(confirming.id, floor))
              }
            >
              确认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
