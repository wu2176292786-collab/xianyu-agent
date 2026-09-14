"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { resetDemoData, updateSettings } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ShopSettings } from "@/lib/domain/types";

export function SettingsForm({ settings }: { settings: ShopSettings }) {
  const [shopName, setShopName] = useState(settings.shopName);
  const [maxDiscountPercent, setMaxDiscountPercent] = useState(
    String(Math.round(settings.maxDiscount * 1000) / 10),
  );
  const [shipWithinHours, setShipWithinHours] = useState(String(settings.shipWithinHours));
  const [signature, setSignature] = useState(settings.signature);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const save = () =>
    startTransition(async () => {
      const result = await updateSettings({
        shopName,
        maxDiscountPercent,
        shipWithinHours,
        signature,
      });
      toast[result.ok ? "success" : "error"](result.message);
      router.refresh();
    });

  const reset = () =>
    startTransition(async () => {
      const result = await resetDemoData();
      toast.success(result.message);
      router.refresh();
    });

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="shopName">店铺名</Label>
          <Input
            id="shopName"
            value={shopName}
            onChange={(event) => setShopName(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="maxDiscount">议价最大让价（%）</Label>
          <Input
            id="maxDiscount"
            inputMode="decimal"
            value={maxDiscountPercent}
            onChange={(event) => setMaxDiscountPercent(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Agent 还价不会低于挂牌价打完这个折扣，也不会低于商品底价。
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="shipHours">承诺发货时效（小时）</Label>
          <Input
            id="shipHours"
            inputMode="numeric"
            value={shipWithinHours}
            onChange={(event) => setShipWithinHours(event.target.value)}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="signature">回复签名</Label>
        <Textarea
          id="signature"
          rows={2}
          value={signature}
          onChange={(event) => setSignature(event.target.value)}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={save} disabled={pending}>
          保存设置
        </Button>
        <Button variant="outline" onClick={reset} disabled={pending}>
          重置示例数据
        </Button>
        <p className="text-xs text-muted-foreground">
          重置会把商品、消息、订单和队列恢复成初始演示状态。
        </p>
      </div>
    </div>
  );
}
