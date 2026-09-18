import { revalidatePath } from "next/cache";
import type { CredentialStatus } from "@/lib/adapters/live/credentials";

/**
 * Server Action 的共用回包。入口散在 agent / adapters / research，
 * 页面仍然只从 `@/app/actions` 引进来。
 */
export interface ActionResponse {
  ok: boolean;
  message: string;
  taskId?: string;
}

export interface LiveChannelStatus {
  credentials: CredentialStatus;
  endpoints: { listings?: string; conversations?: string; orders?: string };
}

export type LoginOrigin = "env" | "file" | "none";

export interface LoginStateView {
  credentials: CredentialStatus;
  origin: LoginOrigin;
  capturedAt?: string;
  description: string;
}

export function revalidateAll() {
  for (const path of [
    "/",
    "/listings",
    "/inbox",
    "/automations",
    "/automations/login",
    "/queue",
    "/research",
  ]) {
    revalidatePath(path);
  }
}
