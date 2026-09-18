import { llmConfigView, loginStateView } from "@/app/actions";
import { LlmConfigCard } from "@/components/llm-config-card";
import { LoginStateCard } from "@/components/login-state-card";

export const dynamic = "force-dynamic";

export default async function LoginStatePage() {
  const [login, llm] = await Promise.all([loginStateView(), llmConfigView()]);
  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">账号与模型</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          真实读通道和发私信靠闲鱼登录态；润色、选品筛选和问答靠模型配置。两份都只写本机。
        </p>
      </div>
      <LoginStateCard view={login} />
      <LlmConfigCard view={llm} />
    </div>
  );
}
