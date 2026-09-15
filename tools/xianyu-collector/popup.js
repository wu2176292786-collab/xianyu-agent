/**
 * 弹窗：选任务 → 采当前页 → 投到本机应用。
 *
 * 请求是从扩展自己发出去的（manifest 里给了 localhost 的 host_permissions），
 * 所以不需要应用那边开 CORS，闲鱼页面本身也拿不到你的采集密钥。
 */
const el = (id) => document.getElementById(id);

const state = { endpoint: "", token: "", taskId: "", tasks: [] };

function say(text, tone = "info") {
  const box = el("message");
  box.hidden = !text;
  box.textContent = text;
  box.dataset.tone = tone;
}

function showSetup() {
  el("setup").hidden = false;
  el("main").hidden = true;
}

function renderTasks() {
  const box = el("tasks");
  box.innerHTML = "";

  if (state.tasks.length === 0) {
    box.textContent = "应用里还没有研究任务，先去「选品研究」新建一个。";
    el("collect").disabled = true;
    return;
  }

  for (const task of state.tasks) {
    const button = document.createElement("button");
    button.className = "task";
    button.dataset.active = String(task.id === state.taskId);
    button.innerHTML = `<span>${task.name}</span><small>${task.rivals} 件${
      task.due > 0 ? ` · ${task.due} 件待回访` : ""
    }</small>`;
    button.addEventListener("click", async () => {
      state.taskId = task.id;
      await chrome.storage.local.set({ taskId: task.id });
      renderTasks();
    });
    box.appendChild(button);
  }

  el("collect").disabled = !state.taskId;
}

async function loadTasks() {
  say("连接中…");
  try {
    const response = await fetch(
      `${state.endpoint}/api/research/tasks?token=${encodeURIComponent(state.token)}`,
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      say(data.message ?? `应用返回 ${response.status}`, "error");
      showSetup();
      return;
    }

    state.tasks = data.tasks ?? [];
    if (!state.tasks.some((task) => task.id === state.taskId)) {
      state.taskId = state.tasks[0]?.id ?? "";
    }

    el("setup").hidden = true;
    el("main").hidden = false;
    el("current").textContent = `${state.endpoint}，密钥 ${state.token.slice(0, 6)}…`;
    renderTasks();
    say("");
  } catch {
    say(`连不上 ${state.endpoint}，确认 npm run dev 在跑。`, "error");
    showSetup();
  }
}

el("save").addEventListener("click", async () => {
  state.endpoint = el("endpoint").value.trim().replace(/\/+$/, "");
  state.token = el("token").value.trim();
  if (!state.endpoint || !state.token) {
    say("地址和密钥都得填。", "error");
    return;
  }
  await chrome.storage.local.set({ endpoint: state.endpoint, token: state.token });
  await loadTasks();
});

el("edit").addEventListener("click", () => {
  el("endpoint").value = state.endpoint;
  el("token").value = state.token;
  showSetup();
  say("");
});

el("collect").addEventListener("click", async () => {
  el("collect").disabled = true;
  say("正在读当前页…");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      say("找不到当前标签页。", "error");
      return;
    }
    if (!/^https:\/\/[^/]*goofish\.com\//.test(tab.url ?? "")) {
      say("请在闲鱼的商品详情页或搜索结果页上点这个按钮。", "error");
      return;
    }

    const collected = await chrome.tabs
      .sendMessage(tab.id, { kind: "collect" })
      .catch(() => undefined);

    if (!collected) {
      say("页面上的采集脚本还没就绪，刷新一下这个页面再试。", "error");
      return;
    }
    if (!collected.ok) {
      say(collected.message, "error");
      return;
    }

    const response = await fetch(`${state.endpoint}/api/research/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: state.token,
        taskId: state.taskId,
        snapshot: collected.snapshot,
      }),
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.ok) {
      say(data.message ?? `应用返回 ${response.status}`, "error");
      return;
    }

    say(data.message, "ok");
    await loadTasks();
  } catch (error) {
    say(String(error?.message ?? error), "error");
  } finally {
    el("collect").disabled = false;
  }
});

(async () => {
  const saved = await chrome.storage.local.get(["endpoint", "token", "taskId"]);
  state.endpoint = saved.endpoint ?? "http://localhost:43117";
  state.token = saved.token ?? "";
  state.taskId = saved.taskId ?? "";

  el("endpoint").value = state.endpoint;
  el("token").value = state.token;

  if (!state.token) {
    showSetup();
    say("先填应用地址和采集密钥。密钥在应用的「选品研究」页面底部。");
    return;
  }
  await loadTasks();
})();
