import { NextResponse } from "next/server";
import { researchViewStamp } from "@/lib/research/record";
import { getState } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * 研究台轮询用的短戳。采集端投完数据后戳会变，打开着的研究页据此刷新。
 */
export async function GET() {
  const state = await getState();
  return NextResponse.json({ ok: true, stamp: researchViewStamp(state) });
}
