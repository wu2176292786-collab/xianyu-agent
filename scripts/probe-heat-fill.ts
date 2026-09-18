/**
 * 手动跑一次「补热度」同一条路，打印过程，不打印 cookie。
 */
import { findChromePath } from "../src/lib/research/browse-search";
import { startHeatBrowser } from "../src/lib/research/browse-item";
import { ingestRivalDetail } from "../src/lib/research/pull";
import { loadLoginState } from "../src/lib/adapters/live/login-state";
import { getState } from "../src/lib/store";

async function main() {
  // 开关和商品 id 混在一起传，按前缀分开，不然 `--headed` 会被当成 id
  const args = process.argv.slice(2);
  const wantedId = args.find((arg) => !arg.startsWith("--"));
  const state = await getState();
  const rival =
    state.research.rivals.find((item) => item.id === wantedId) ??
    state.research.rivals.find((item) => item.watched);
  if (!rival) {
    console.warn("[heat] no-rival");
    process.exit(1);
  }

  const login = await loadLoginState();
  console.warn("[heat] probe", {
    rivalId: rival.id,
    itemId: rival.itemId,
    title: rival.title.slice(0, 40),
    url: rival.url,
    read: state.channel.read,
    hasLogin: Boolean(login?.cookie),
    chrome: findChromePath() ?? null,
    pauseUntil: state.research.heatPull?.pauseUntil,
    lastMessage: state.research.heatPull?.lastMessage,
  });

  const headed = process.argv.includes("--headed");
  const ignorePause = process.argv.includes("--ignore-pause");
  const started = await startHeatBrowser({ headed });
  console.warn("[heat] browser-start", {
    ok: Boolean(started.session),
    error: started.error ?? null,
    headed,
  });
  try {
    const result = await ingestRivalDetail(rival.id, {
      browser: started.session,
      ignorePause,
    });
    console.warn("[heat] result", result);
  } finally {
    await started.session?.close();
  }
}

main().catch((error) => {
  console.warn("[heat] crash", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
