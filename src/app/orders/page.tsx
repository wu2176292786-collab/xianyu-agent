import { OrdersTable } from "@/components/orders-table";
import { StatCard } from "@/components/stat-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { hoursSince, nowMs, yuan } from "@/lib/format";
import { getState } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  const state = await getState();
  const now = nowMs();

  const sorted = [...state.orders].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
  const pendingShipment = sorted.filter((o) => o.status === "pending_shipment");
  const overdue = pendingShipment.filter(
    (o) => o.paidAt && hoursSince(o.paidAt, now) > state.settings.shipWithinHours,
  );
  const refunds = sorted.filter((o) => o.status === "refund_requested");
  const gmv = sorted
    .filter((o) => o.status !== "pending_payment")
    .reduce((acc, o) => acc + o.amountCents, 0);

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">订单</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          承诺 {state.settings.shipWithinHours} 小时内发货，超时的订单 Agent 会主动备单提醒。
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon="📦" label="待发货" value={String(pendingShipment.length)} hint="笔" />
        <StatCard
          icon="⏰"
          label="已超时"
          value={String(overdue.length)}
          hint={overdue.length > 0 ? "会影响体验分" : "没有超时订单"}
        />
        <StatCard icon="↩️" label="退款申请" value={String(refunds.length)} hint="需要人工处理" />
        <StatCard icon="💰" label="累计成交" value={yuan(gmv)} hint="含进行中的订单" />
      </div>

      <Card className="py-0">
        <CardHeader className="border-b py-4">
          <CardTitle>全部订单</CardTitle>
          <CardDescription>
            发货会扣减库存，库存归零的商品会被自动下架规则接手。
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <OrdersTable
            orders={sorted}
            listings={state.listings}
            shipWithinHours={state.settings.shipWithinHours}
            now={now}
          />
        </CardContent>
      </Card>
    </div>
  );
}
