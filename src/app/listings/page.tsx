import { ListingsTable } from "@/components/listings-table";
import { StatCard } from "@/components/stat-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { hoursSince, nowMs, yuan } from "@/lib/format";
import { getState } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function ListingsPage() {
  const state = await getState();
  const now = nowMs();

  const onSale = state.listings.filter((l) => l.status === "on_sale");
  const stale = onSale.filter((l) => hoursSince(l.lastRefreshedAt, now) >= 24);
  const inventoryValue = onSale.reduce((acc, l) => acc + l.priceCents * l.stock, 0);

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">商品</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          底价是 Agent 的红线：自动降价永远不会低于它，手动改价也会被拦。
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon="🏷️" label="在售商品" value={String(onSale.length)} hint={`共 ${state.listings.length} 件`} />
        <StatCard icon="✨" label="超 24 小时未擦亮" value={String(stale.length)} hint="擦亮可以抢曝光" />
        <StatCard
          icon="📚"
          label="在售库存"
          value={String(onSale.reduce((acc, l) => acc + l.stock, 0))}
          hint="件"
        />
        <StatCard icon="💵" label="在售货值" value={yuan(inventoryValue)} hint="按当前挂牌价" />
      </div>

      <Card className="py-0">
        <CardHeader className="border-b py-4">
          <CardTitle>全部商品</CardTitle>
          <CardDescription>
            擦亮、改价、下架都会立刻作用在本地模拟通道上，并记入动态。
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <ListingsTable listings={state.listings} />
        </CardContent>
      </Card>
    </div>
  );
}
