/**
 * 弹窗：选任务 → 采当前页（搜索页会真点「下一页」，页数跟应用里设定的走）→ 投到本机应用。
 *
 * 请求是从扩展自己发出去的（manifest 里给了 localhost 的 host_permissions），
 * 所以不需要应用那边开 CORS，闲鱼页面本身也拿不到你的采集密钥。
 */
const DEFAULT_SEARCH_PAGES = 3;
const MIN_SEARCH_PAGES = 1;
const MAX_SEARCH_PAGES = 20;
const el = (id) => document.getElementById(id);

const state = { endpoint: "", token: "", taskId: "", tasks: [], searchPages: DEFAULT_SEARCH_PAGES };

function clampSearchPages(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SEARCH_PAGES;
  return Math.min(MAX_SEARCH_PAGES, Math.max(MIN_SEARCH_PAGES, Math.round(n)));
}

function renderSearchPages() {
  const hint = el("collect-hint");
  if (hint) {
    hint.textContent = `搜索页和店铺在售会在当前标签里点「下一页」，连采 ${state.searchPages} 页；店铺的货进这家店自己的任务。商品详情只采这一页。页数在应用的选品研究里改。`;
  }
  const collect = el("collect");
  if (collect) {
    collect.textContent = `加入研究（列表页翻 ${state.searchPages} 页）`;
  }
}

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
  box.replaceChildren();

  if (state.tasks.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "还没有研究任务，下面填个名字就能新建。";
    box.appendChild(empty);
    el("collect").disabled = true;
    return;
  }

  for (const task of state.tasks) {
    const row = document.createElement("div");
    row.className = "task";
    row.dataset.active = String(task.id === state.taskId);

    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "task-pick";
    const name = document.createElement("span");
    name.textContent = task.name;
    const meta = document.createElement("small");
    meta.textContent = `${task.rivals} 件${task.due > 0 ? ` · ${task.due} 件待回访` : ""}`;
    pick.append(name, meta);
    pick.addEventListener("click", async () => {
      state.taskId = task.id;
      await chrome.storage.local.set({ taskId: task.id });
      renderTasks();
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "task-del";
    remove.title = "删除这个任务";
    remove.textContent = "×";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      void deleteTask(task);
    });

    row.append(pick, remove);
    box.appendChild(row);
  }

  el("collect").disabled = !state.taskId;
}

async function loadTasks(okMessage) {
  if (!okMessage) say("连接中…");
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
    state.searchPages = clampSearchPages(data.searchPages);
    if (!state.tasks.some((task) => task.id === state.taskId)) {
      state.taskId = state.tasks[0]?.id ?? "";
    }

    el("setup").hidden = true;
    el("main").hidden = false;
    el("current").textContent = `${state.endpoint}，密钥 ${state.token.slice(0, 6)}…`;
    renderTasks();
    renderSearchPages();
    if (okMessage) say(okMessage, "ok");
    else say("");
  } catch {
    say(`连不上 ${state.endpoint}，确认 npm run dev 在跑。`, "error");
    showSetup();
  }
}

async function postTask(method, payload) {
  const response = await fetch(`${state.endpoint}/api/research/tasks`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: state.token, ...payload }),
  });
  const data = await response.json().catch(() => ({}));
  return {
    ok: response.ok && Boolean(data.ok),
    message: data.message ?? `应用返回 ${response.status}`,
    taskId: typeof data.taskId === "string" ? data.taskId : "",
  };
}

async function addTask() {
  const input = el("new-task-name");
  const name = input.value.trim();
  if (!name) {
    say("先给新任务起个名字。", "error");
    input.focus();
    return;
  }
  el("add-task").disabled = true;
  say("正在新建…");
  try {
    const created = await postTask("POST", { name });
    if (!created.ok) {
      say(created.message, "error");
      return;
    }
    input.value = "";
    if (created.taskId) {
      state.taskId = created.taskId;
      await chrome.storage.local.set({ taskId: created.taskId });
    }
    await loadTasks(created.message);
    await refreshResearchPages();
  } catch (error) {
    say(String(error?.message ?? error), "error");
  } finally {
    el("add-task").disabled = false;
  }
}

async function deleteTask(task) {
  const count = Number(task.rivals) || 0;
  const ok = window.confirm(
    count > 0
      ? `删除「${task.name}」会一并移出里面的 ${count} 件，确定？`
      : `删除「${task.name}」？`,
  );
  if (!ok) return;

  say("正在删除…");
  try {
    const removed = await postTask("DELETE", { taskId: task.id });
    if (!removed.ok) {
      say(removed.message, "error");
      return;
    }
    if (state.taskId === task.id) {
      state.taskId = "";
      await chrome.storage.local.set({ taskId: "" });
    }
    await loadTasks(removed.message);
    await refreshResearchPages();
  } catch (error) {
    say(String(error?.message ?? error), "error");
  }
}

el("add-task").addEventListener("click", () => {
  void addTask();
});
el("new-task-name").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void addTask();
  }
});

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

async function importSnapshot(snapshot) {
  const response = await fetch(`${state.endpoint}/api/research/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: state.token,
      taskId: state.taskId,
      snapshot,
    }),
  });
  const data = await response.json().catch(() => ({}));
  return {
    ok: response.ok && Boolean(data.ok),
    message: data.message ?? `应用返回 ${response.status}`,
  };
}

el("collect").addEventListener("click", async () => {
  el("collect").disabled = true;
  say("正在读第 1 页…");

  try {
    const { tab, error } = await goofishTab();
    if (error) {
      say(error, "error");
      return;
    }

    const first = await askPage(tab.id, { kind: "collect" });

    if (!first) {
      say("读不到这一页。确认当前标签是闲鱼搜索或商品详情，刷新后再点一次。", "error");
      return;
    }
    if (!first.ok) {
      say(first.message, "error");
      return;
    }

    const snapshots = [first.snapshot];
    const notes = [];

    // 搜索结果和店铺在售都是列表页，翻页方式一样
    if (first.snapshot.pageType === "search" || first.snapshot.pageType === "shop") {
      for (let page = 2; page <= state.searchPages; page += 1) {
        say(`正在点第 ${page} 页…`);
        const turned = await askPage(tab.id, { kind: "next-page" });
        if (!turned?.ok) {
          notes.push(turned?.message ?? "没有下一页。");
          break;
        }
        say(`正在读第 ${page} 页…`);
        const collected = await askPage(tab.id, { kind: "collect" });
        if (!collected?.ok) {
          notes.push(collected?.message ?? `第 ${page} 页没读到。`);
          break;
        }
        snapshots.push(collected.snapshot);
      }
    }

    const messages = [];
    for (let i = 0; i < snapshots.length; i += 1) {
      say(`正在导入第 ${i + 1} / ${snapshots.length} 页…`);
      const imported = await importSnapshot(snapshots[i]);
      if (!imported.ok) {
        say(
          [...messages, imported.message].filter(Boolean).join("\n") || imported.message,
          messages.length > 0 ? "ok" : "error",
        );
        if (messages.length === 0) return;
        break;
      }
      messages.push(`第${i + 1}页：${imported.message}`);
    }

    if (notes.length > 0) messages.push(...notes);
    await loadTasks(messages.join("\n") || "已导入");
    await refreshResearchPages();
  } catch (error) {
    say(String(error?.message ?? error), "error");
  } finally {
    el("collect").disabled = false;
  }
});

/** 投进去之后，已经打开的选品研究页自己刷一下，不用再手动刷新。 */
async function refreshResearchPages() {
  const base = state.endpoint.replace(/\/+$/, "");
  const tabs = await chrome.tabs
    .query({ url: `${base}/research*` })
    .catch(() => []);
  await Promise.all(
    tabs
      .filter((tab) => tab.id)
      .map((tab) => chrome.tabs.reload(tab.id).catch(() => undefined)),
  );
}

/** 先跟页面上的脚本说话；没有注入时补打一份再问。 */
async function askPage(tabId, message) {
  const first = await chrome.tabs.sendMessage(tabId, message).catch(() => undefined);
  if (first) return first;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["collect.js"],
    });
  } catch {
    return undefined;
  }

  return chrome.tabs.sendMessage(tabId, message).catch(() => undefined);
}

/** 当前标签页，顺便确认是不是闲鱼的页面。 */
async function goofishTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { error: "找不到当前标签页。" };
  if (!/^https:\/\/[^/]*goofish\.com\//.test(tab.url ?? "")) {
    return { error: "请在闲鱼的页面上点这个按钮。" };
  }
  return { tab };
}

el("apis").addEventListener("click", async () => {
  const box = el("apis-list");
  box.textContent = "读取中…";

  const { tab, error } = await goofishTab();
  if (error) {
    box.textContent = error;
    return;
  }

  const result = await askPage(tab.id, { kind: "apis" });
  if (!result?.ok) {
    box.textContent = result?.message ?? "采集脚本还没就绪，刷新一下这个页面再试。";
    return;
  }
  if (result.apis.length === 0) {
    box.textContent = "这一页还没发过闲鱼接口请求。刷新页面、或者点一下要看的标签，再试。";
    return;
  }

  box.innerHTML = "";
  for (const item of result.apis) {
    const row = document.createElement("div");
    row.className = "api";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = `${item.api}${item.version ? `@${item.version}` : ""}`;
    row.appendChild(name);
    if (item.requestData) {
      const data = document.createElement("div");
      data.className = "data";
      data.textContent = item.requestData;
      row.appendChild(data);
    }
    box.appendChild(row);
  }

  const copy = document.createElement("button");
  copy.className = "secondary";
  copy.textContent = "全部复制";
  copy.addEventListener("click", async () => {
    const text = result.apis
      .map((i) => `${i.api}@${i.version ?? "?"}\n  data: ${i.requestData ?? "(无)"}`)
      .join("\n");
    await navigator.clipboard.writeText(text).catch(() => {});
    copy.textContent = "已复制";
  });
  box.appendChild(copy);
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
