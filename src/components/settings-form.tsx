"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { clearDemo, resetDemoData, updateSettings } from "@/app/actions";
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

  const clear = () =>
    startTransition(async () => {
      const result = await clearDemo();
      toast[result.ok ? "success" : "error"](result.message);
      // 店铺名可能被换成了平台上的真名，输入框要跟着更新
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
        <Button variant="outline" onClick={clear} disabled={pending}>
          清除示例数据
        </Button>
        <Button variant="ghost" onClick={reset} disabled={pending}>
          重置示例数据
        </Button>
      </div>
      <div className="space-y-1 text-xs text-muted-foreground">
        <p>
          <span className="font-medium">清除</span>
          ：只删掉示例店铺（商品、消息、订单、流量、示例研究任务），
          同步来的真实数据留着；顺便把店铺名换成平台上的真名。
        </p>
        <p>
          <span className="font-medium">重置</span>
          ：恢复成初始演示状态 —— 真实数据也会一起没了，得重新同步。
        </p>
      </div>
    </div>
  );
}
