"use strict";

const state = {
  token: "",
  data: null,
  latency: Object.create(null),
  busy: new Set(),
};

const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

let toastTimer = 0;
function toast(message, kind) {
  const box = $("toast");
  box.textContent = message;
  box.className = "toast" + (kind ? " " + kind : "");
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, kind === "err" || kind === "warn" ? 5000 : 2600);
}

async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-MH-Token": state.token },
    body: JSON.stringify(body || {}),
  });
  let payload = null;
  try { payload = await res.json(); } catch (_) { /* shutdown can cut the body */ }
  if (!payload) throw new Error("服务已关闭或响应异常");
  if (!payload.ok) {
    const err = payload.error || {};
    throw new Error(err.message + (err.hint ? "（" + err.hint + "）" : ""));
  }
  return payload.data;
}

async function bootstrap() {
  const res = await fetch("/api/bootstrap", { cache: "no-store" });
  const payload = await res.json();
  state.token = payload.data.token;
  state.data = payload.data.state;
  render();
}

async function refresh(quiet) {
  try {
    const res = await fetch("/api/state", { cache: "no-store" });
    const payload = await res.json();
    if (payload.ok) state.data = payload.data;
    render();
    if (!quiet) toast("已刷新");
  } catch (err) {
    toast(String(err.message || err), "err");
  }
}

function latencyOf(toolId, mirrorId) {
  return state.latency[toolId + "|" + mirrorId];
}

function render() {
  const data = state.data;
  if (!data) return;

  $("version").textContent = "v" + data.version;
  $("platform").textContent = data.platform;
  $("cfg-path").textContent = data.config_file || "";
  $("cfg-path").title = "打开所在目录";

  const tools = data.tools || [];
  const installed = tools.filter((t) => t.installed).length;
  const configured = tools.filter(
    (t) => t.current && t.current.source && t.current.origin !== "default" && t.current.origin !== "unknown",
  ).length;
  const mirrors = tools.reduce((n, t) => n + (t.mirrors || []).length, 0);

  const stats = $("stats");
  stats.replaceChildren(
    stat(tools.length, "个工具", "内置支持的包管理器"),
    stat(installed, "个已安装", "在 PATH 或已有配置文件"),
    stat(configured, "个已配置", "存在显式镜像源"),
    stat(mirrors, "个镜像", "含自定义条目"),
  );

  const wrap = $("tools");
  wrap.replaceChildren(...tools.map(card));
}

function stat(value, label, hint) {
  const box = el("div", "stat");
  box.append(el("b", null, String(value)), el("span", null, label));
  box.title = hint;
  return box;
}

function card(tool) {
  const node = el("div", "card" + (tool.installed ? "" : " off"));

  const head = el("div", "card-head");
  head.append(el("span", "tool-name", tool.name));
  head.append(el("span", "tool-cat", tool.category));
  if (tool.version) head.append(el("span", "tool-ver", tool.version));
  head.append(el("span", "badge " + (tool.installed ? "on" : "off"), tool.installed ? "已安装" : "未安装"));

  if (tool.current && tool.current.origin === "env") {
    const badge = el("span", "badge env", "环境变量");
    badge.title = "镜像源由环境变量控制，修改配置文件可能不生效";
    head.append(badge);
  }
  if (tool.current && tool.current.origin === "command") {
    const badge = el("span", "badge env", "命令输出");
    badge.title = tool.current.note || "由工具自身命令返回";
    head.append(badge);
  }
  if (tool.error) {
    const badge = el("span", "badge env", "读取失败");
    badge.title = tool.error;
    head.append(badge);
  }

  const right = el("div", "head-right");
  const current = el("span", "current" + (tool.mirror_id || tool.current.source ? "" : " unknown"));
  current.append(el("span", "dot"));
  const label = tool.mirror_id ? mirrorName(tool, tool.mirror_id) : (tool.current.source || "未配置");
  current.append(el("code", null, label));
  current.title = tool.current.source || "未设置镜像源";
  right.append(current);

  const testBtn = el("button", "btn small", "测速");
  testBtn.type = "button";
  testBtn.onclick = () => testTools([tool.id], testBtn);
  right.append(testBtn);

  const resetBtn = el("button", "btn small ghost", "还原官方");
  resetBtn.type = "button";
  resetBtn.title = "删除 MirrorHub 写入的配置，恢复官方源";
  resetBtn.onclick = () => resetTool(tool);
  right.append(resetBtn);

  head.append(right);
  node.append(head);

  const path = el("div", "path", tool.config_file || "（无配置文件路径）");
  path.title = "点击复制路径";
  path.onclick = async () => {
    if (!tool.config_file) return;
    try {
      await navigator.clipboard.writeText(tool.config_file);
      toast("已复制配置路径");
    } catch (_) {
      toast(tool.config_file);
    }
  };
  node.append(path);

  const pills = el("div", "pills");
  for (const m of tool.mirrors || []) pills.append(pill(tool, m));
  const add = el("button", "pill add", "＋ 自定义");
  add.type = "button";
  add.onclick = () => openCustom(tool.id);
  pills.append(add);
  node.append(pills);

  return node;
}

function mirrorName(tool, id) {
  const m = (tool.mirrors || []).find((x) => x.id === id);
  return m ? m.name : id;
}

function pill(tool, mirror) {
  const active = tool.mirror_id === mirror.id;
  const btn = el("button", "pill" + (active ? " active" : ""));
  btn.type = "button";
  btn.title = mirror.url + (mirror.note ? "\n" + mirror.note : "");
  btn.append(el("span", null, mirror.name));

  const lat = latencyOf(tool.id, mirror.id);
  if (lat) {
    const text = lat.ok ? lat.ttfb_ms + " ms" : "失败";
    btn.append(el("span", "lat " + (lat.ok ? "good" : "bad"), text));
    if (!lat.ok) btn.title += "\n" + (lat.error || "");
  }

  if (mirror.custom && !active) {
    const x = el("button", "x", "×");
    x.type = "button";
    x.title = "删除这个自定义镜像";
    x.onclick = (ev) => { ev.stopPropagation(); removeCustom(tool, mirror); };
    btn.append(x);
  }

  btn.onclick = () => switchMirror(tool, mirror);
  return btn;
}

async function switchMirror(tool, mirror) {
  if (tool.mirror_id === mirror.id) {
    toast(tool.name + " 已在用 " + mirror.name);
    return;
  }
  try {
    const data = await api("/api/apply", { tool: tool.id, mirror: mirror.id });
    if (data.tool && data.tool.current && data.tool.current.origin === "env") {
      toast("已写入配置文件，但环境变量仍然优先", "warn");
    } else {
      toast("已切换 " + tool.name + " → " + mirror.name, "ok");
    }
    replaceTool(data.tool);
  } catch (err) {
    toast(String(err.message || err), "err");
  }
}

async function resetTool(tool) {
  try {
    const data = await api("/api/reset", { tool: tool.id });
    if (!data.change.changed) {
      toast(tool.name + " 未配置自定义源，无需恢复");
    } else {
      toast("已恢复 " + tool.name + " 官方源", "ok");
    }
    replaceTool(data.tool);
  } catch (err) {
    toast(String(err.message || err), "err");
  }
}

function replaceTool(view) {
  if (!view || !state.data) return;
  state.data.tools = state.data.tools.map((t) => (t.id === view.id ? view : t));
  render();
}

async function testTools(toolIds, btn) {
  const key = toolIds.join(",");
  if (state.busy.has(key)) return;
  state.busy.add(key);
  const oldText = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "测速中…"; }
  try {
    const data = await api("/api/test", { tools: toolIds, refresh: true });
    for (const r of data.results) state.latency[r.tool_id + "|" + r.mirror_id] = r;
    render();
    const ok = data.results.filter((r) => r.ok).length;
    toast("测速完成: " + ok + "/" + data.results.length + " 个镜像可用", ok ? "ok" : "err");
  } catch (err) {
    toast(String(err.message || err), "err");
  } finally {
    state.busy.delete(key);
    if (btn) { btn.disabled = false; btn.textContent = oldText || "测速"; }
  }
}

async function removeCustom(tool, mirror) {
  try {
    await api("/api/remove", { tool: tool.id, id: mirror.id });
    toast("已删除镜像 " + mirror.name, "ok");
    await refresh(true);
  } catch (err) {
    toast(String(err.message || err), "err");
  }
}

function openCustom(toolId) {
  const select = $("custom-tool");
  select.replaceChildren(
    ...(state.data.tools || []).map((t) => {
      const opt = el("option", null, t.name);
      opt.value = t.id;
      return opt;
    }),
  );
  if (toolId) select.value = toolId;
  $("custom-name").value = "";
  $("custom-url").value = "";
  $("custom-error").hidden = true;
  $("dlg-custom").showModal();
  $("custom-name").focus();
}

async function submitCustom(ev) {
  ev.preventDefault();
  const tool = $("custom-tool").value;
  const name = $("custom-name").value.trim();
  const url = $("custom-url").value.trim();
  const errBox = $("custom-error");
  errBox.hidden = true;
  try {
    const data = await api("/api/add", { tool, name, url });
    $("dlg-custom").close();
    toast("已添加镜像 " + data.mirror.name, "ok");
    await refresh(true);
  } catch (err) {
    errBox.textContent = String(err.message || err);
    errBox.hidden = false;
  }
}

async function quit() {
  try {
    await api("/api/quit");
  } catch (_) { /* server goes away immediately */ }
  document.body.innerHTML =
    '<main style="max-width:520px;margin:18vh auto;text-align:center;font-family:system-ui">' +
    '<h1 style="font-size:18px">MirrorHub 已退出</h1>' +
    '<p style="color:#888">可以关闭这个页面了。</p></main>';
}

$("btn-refresh").onclick = () => refresh(false);
$("btn-test-all").onclick = (ev) => {
  const ids = (state.data.tools || []).map((t) => t.id);
  testTools(ids, ev.currentTarget);
};
$("btn-quit").onclick = quit;
$("form-custom").addEventListener("submit", submitCustom);
$("custom-cancel").onclick = () => $("dlg-custom").close();
$("cfg-path").onclick = async () => {
  const path = state.data && state.data.config_file;
  if (!path) return;
  try { await navigator.clipboard.writeText(path); toast("已复制配置路径"); }
  catch (_) { toast(path); }
};

bootstrap().catch((err) => {
  $("tools").replaceChildren(el("div", "loading", "加载失败: " + (err.message || err)));
});
