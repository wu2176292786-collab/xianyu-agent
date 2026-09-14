"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { shipOrder } from "@/app/actions";
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
import type { Listing, Order, OrderStatus } from "@/lib/domain/types";
import { clockTime, hoursSince, yuan } from "@/lib/format";
import { cn } from "@/lib/utils";

const STATUS: Record<OrderStatus, { label: string; className: string }> = {
  pending_payment: { label: "待付款", className: "bg-muted text-muted-foreground" },
  pending_shipment: { label: "待发货", className: "bg-amber-100 text-amber-900" },
  shipped: { label: "已发货", className: "bg-sky-100 text-sky-900" },
  completed: { label: "已完成", className: "bg-emerald-100 text-emerald-900" },
  refund_requested: { label: "退款申请", className: "bg-rose-100 text-rose-900" },
};

export function OrdersTable({
  orders,
  listings,
  shipWithinHours,
  now,
}: {
  orders: Order[];
  listings: Listing[];
  shipWithinHours: number;
  /** 由服务端渲染时确定，保证列表里的时效口径一致 */
  now: number;
}) {
  const [pending, startTransition] = useTransition();
  const [shipping, setShipping] = useState<Order | null>(null);
  const [carrier, setCarrier] = useState("顺丰速运");
  const [trackingNo, setTrackingNo] = useState("");
  const router = useRouter();

  const titleOf = (listingId: string) =>
    listings.find((l) => l.id === listingId)?.title ?? "已删除的商品";

  const submit = () =>
    startTransition(async () => {
      if (!shipping) return;
      const result = await shipOrder(shipping.id, carrier, trackingNo);
      toast[result.ok ? "success" : "error"](result.message);
      if (result.ok) {
        setShipping(null);
        setTrackingNo("");
        router.refresh();
      }
    });

  return (
    <>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>订单号</TableHead>
              <TableHead className="min-w-56">商品</TableHead>
              <TableHead>买家</TableHead>
              <TableHead className="text-right">金额</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>时效</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orders.map((order) => {
              const overdueHours =
                order.status === "pending_shipment" && order.paidAt
                  ? hoursSince(order.paidAt, now) - shipWithinHours
                  : null;
              return (
                <TableRow key={order.id}>
                  <TableCell className="font-mono text-xs">{order.id}</TableCell>
                  <TableCell>
                    <p className="line-clamp-2 text-sm">{titleOf(order.listingId)}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      下单 {clockTime(order.createdAt)}
                    </p>
                  </TableCell>
                  <TableCell className="text-sm">{order.buyerName}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {yuan(order.amountCents)}
                  </TableCell>
                  <TableCell>
                    <span
                      className={cn(
                        "inline-flex rounded-full px-2 py-0.5 text-xs font-medium",
                        STATUS[order.status].className,
                      )}
                    >
                      {STATUS[order.status].label}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs">
                    {order.status === "shipped" || order.status === "completed" ? (
                      <span className="text-muted-foreground">
                        {order.carrier} {order.trackingNo}
                      </span>
                    ) : overdueHours === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : overdueHours > 0 ? (
                      <span className="font-medium text-rose-600">
                        已超时 {Math.floor(overdueHours)} 小时
                      </span>
                    ) : (
                      <span className="text-muted-foreground">
                        还剩 {Math.ceil(-overdueHours)} 小时
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {order.status === "pending_shipment" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => {
                          setShipping(order);
                          setTrackingNo("");
                        }}
                      >
                        发货
                      </Button>
                    ) : order.status === "refund_requested" ? (
                      <Badge variant="outline">需人工处理</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <Dialog open={shipping !== null} onOpenChange={(open) => !open && setShipping(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>填写发货信息</DialogTitle>
            <DialogDescription>
              订单 {shipping?.id} · {shipping ? titleOf(shipping.listingId) : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="carrier">快递公司</Label>
              <Input
                id="carrier"
                value={carrier}
                onChange={(event) => setCarrier(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tracking">运单号</Label>
              <Input
                id="tracking"
                value={trackingNo}
                placeholder="SF1234567890"
                onChange={(event) => setTrackingNo(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShipping(null)} disabled={pending}>
              取消
            </Button>
            <Button onClick={submit} disabled={pending}>
              确认发货
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
