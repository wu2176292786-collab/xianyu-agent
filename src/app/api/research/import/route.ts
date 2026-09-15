import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import {
  ensureCollectorToken,
  parseImportBody,
  verifyCollectorToken,
} from "@/lib/research/collector";
import { describeRecord, recordObservations } from "@/lib/research/record";
import { parsePageSnapshot } from "@/lib/research/snapshot";
import { logActivity, mutateState } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * 浏览器采集端投快照的入口。
 *
 * 和界面上「导入页面快照」走的是同一条解析与入库路径 —— 换个入口不该换行为：
 * 只追加不覆盖、抽不到就标缺失、短时重复合并成一条。
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: "请求体不是合法 JSON。" }, { status: 400 });
  }

  const parsedBody = parseImportBody(body);
  if (!parsedBody.ok) {
    return NextResponse.json({ ok: false, message: parsedBody.message }, { status: 400 });
  }

  const { token, taskId, snapshot } = parsedBody.value;
  const now = Date.now();
  const parsed = parsePageSnapshot(snapshot, now);

  const result = await mutateState((state) => {
    if (!verifyCollectorToken(ensureCollectorToken(state), token)) {
      return { status: 401, ok: false, message: "采集密钥不对。" };
    }

    const task = state.research.tasks.find((t) => t.id === taskId);
    if (!task) return { status: 404, ok: false, message: "找不到这个研究任务。" };

    if (parsed.items.length === 0) {
      return {
        status: 422,
        ok: false,
        message: parsed.warnings[0] ?? "这份快照里没认出任何商品。",
      };
    }

    const summary = recordObservations(state, taskId, parsed, now);
    const text = describeRecord(summary);
    logActivity(state, "human", `采集端投入「${task.name}」：${text}。`, now);

    return {
      status: 200,
      ok: true,
      message: [text, ...parsed.warnings].join("；"),
      summary,
    };
  });

  if (result.ok) revalidatePath("/research");

  const { status, ...payload } = result;
  return NextResponse.json(payload, { status });
}
