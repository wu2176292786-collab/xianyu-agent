"use client";

import { useState, type ReactNode } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export interface QueueTab {
  value: string;
  label: string;
}

/**
 * 受控的标签页。
 *
 * 之前直接把 defaultValue 绑到「有没有失败动作」上，数据一变 Base UI 就会警告
 * 「不要在初始化之后改非受控组件的默认值」。改成受控，初值由 URL 决定，
 * 这样总览页的「去处理」也能直接跳到失败列表。
 */
export function QueueTabs({
  tabs,
  initialTab,
  children,
}: {
  tabs: QueueTab[];
  initialTab: string;
  children: ReactNode;
}) {
  const [value, setValue] = useState(initialTab);

  return (
    <Tabs value={value} onValueChange={(next) => setValue(String(next))}>
      <TabsList>
        {tabs.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {children}
    </Tabs>
  );
}
