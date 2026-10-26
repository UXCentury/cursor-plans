/**
 * Cursor Plans — activity-bar list of workspace `*.plan.md` files.
 *
 * Parsing lives in `lib/plans.js`. This file wires VS Code: views,
 * commands, file watchers, and the webview that renders the list.
 *
 * Cursor writes new plans to `~/.cursor/plans`. On Windows that is
 * `C:\Users\<you>\.cursor\plans`, not a folder inside the repo. The sidebar
 * lists both. Save to workspace moves a home-folder plan into the project.
 */
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const {
  collectPlans,
  collectHomePlans,
  listSidebarPlans,
  homeDirOverlapsWorkspace,
  homePlansDir,
  planDirs,
  parsePlanSource,
  savePlanToWorkspace,
  isUnderDir,
  groupSections,
  progressOf,
  filterPlans,
  searchPlans,
  paginatePlans,
  PAGE_SIZE,
} = require("./lib/plans");
const { buildBundle, stringifyBundle, parseBundle, importBundle } = require("./lib/cplan");

const PLAN_GLOBS = [".cursor/plans/*.plan.md", "docs/plans/*.plan.md"];

const providers = [];
let lastSelection = [];
/** Cursor can call activate more than once; registering webview providers twice breaks the sidebar. */
let sidebarProvider;
let explorerProvider;

function broadcast(msg) {
  for (const view of providers) view.post(msg);
}

function activate(context) {
  if (sidebarProvider) {
    sidebarProvider.refresh();
    explorerProvider.refresh();
    return;
  }
  sidebarProvider = new PlansViewProvider(context.extensionUri);
  explorerProvider = new PlansViewProvider(context.extensionUri);
  providers.push(sidebarProvider, explorerProvider);
  const opts = { webviewOptions: { retainContextWhenHidden: false } };
  const refreshAll = debounce(() => {
    sidebarProvider.refresh();
    explorerProvider.refresh();
  }, 80);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("plans.sidebar", sidebarProvider, opts),
    vscode.window.registerWebviewViewProvider("plans.explorer", explorerProvider, opts),
    vscode.commands.registerCommand("plans.refresh", refreshAll),
    vscode.commands.registerCommand("plans.openIndex", () => openIndex()),
    vscode.commands.registerCommand("plans.saveToWorkspace", () => saveActiveEditor()),
    vscode.commands.registerCommand("plans.export", () => exportPlans(lastSelection)),
    vscode.commands.registerCommand("plans.import", () => importPlans()),
    vscode.commands.registerCommand("plans.focus", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.plans");
      await vscode.commands.executeCommand("plans.sidebar.focus");
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(refreshAll),
    vscode.window.onDidChangeActiveTextEditor(refreshAll),
    ...watchPlanFiles(refreshAll),
    ...watchHomePlans(refreshAll),
  );
}

function deactivate() {}

/** Watch both plan directories across every workspace folder. */
function watchPlanFiles(onChange) {
  return PLAN_GLOBS.map((glob) => {
    const watcher = vscode.workspace.createFileSystemWatcher("**/" + glob);
    watcher.onDidCreate(onChange);
    watcher.onDidChange(onChange);
    watcher.onDidDelete(onChange);
    return watcher;
  });
}

/** Home-folder plans live outside the workspace, so watch that directory directly. */
function watchHomePlans(onChange) {
  try {
    const dir = homePlansDir();
    if (!fs.existsSync(dir)) return [];
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(dir), "*.plan.md"),
    );
    watcher.onDidCreate(onChange);
    watcher.onDidChange(onChange);
    watcher.onDidDelete(onChange);
    return [watcher];
  } catch {
    return [];
  }
}

/** Collapse bursty watcher events so the webview is not rebuilt on every write. */
function debounce(fn, ms) {
  let timer;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

class PlansViewProvider {
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
    this.view = undefined;
    /** False until the webview has attached its message listener. */
    this.ready = false;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    this.ready = false;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: this.extensionUri ? [this.extensionUri] : [],
    };
    webviewView.webview.onDidReceiveMessage((msg) => {
      // The first payload is dropped if we post before the script is listening.
      if (msg.type === "ready") {
        this.ready = true;
        this.refresh();
        return;
      }
      this.onMessage(msg);
    });
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.refresh();
    });
    try {
      webviewView.webview.html = this.render();
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      webviewView.webview.html =
        '<!DOCTYPE html><html><body style="color:#ccc;background:#1e1e1e;font:12px sans-serif;padding:12px">Plans failed to load.<pre>' +
        message.replace(/</g, "&lt;") +
        "</pre></body></html>";
    }
    // If the ready handshake is lost (restored webview), still push a list once.
    setTimeout(() => {
      if (this.view === webviewView && !this.ready) {
        this.ready = true;
        this.refresh();
      }
    }, 600);
  }

  post(msg) {
    if (!this.view) return;
    if (!this.ready) return;
    try {
      this.view.webview.postMessage(msg);
    } catch (err) {
      console.error("Plans webview postMessage failed:", err);
    }
  }

  refresh() {
    try {
      this.post({ type: "plans", ...scanPlans() });
    } catch (err) {
      console.error(err);
      this.post({ type: "plans", plans: [], activeHome: null });
    }
  }

  async onMessage(msg) {
    if (msg.type === "selection") {
      lastSelection = Array.isArray(msg.uris) ? msg.uris : [];
      return;
    }
    if (msg.type === "export") {
      await exportPlans(msg.uris);
      return;
    }
    if (msg.type === "import") {
      await importPlans();
      return;
    }
    if (msg.type === "open" && msg.uri) {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(msg.uri));
      await vscode.window.showTextDocument(doc, { preview: true });
      return;
    }
    if (msg.type === "save" && msg.uri) {
      await saveUriToWorkspace(msg.uri);
      return;
    }
    if (msg.type === "copy" && msg.prompt) {
      await vscode.env.clipboard.writeText(msg.prompt);
      vscode.window.showInformationMessage(
        "Build prompt copied. Paste it in a new Agent chat (the @ path is included).",
      );
    }
  }

  render() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
  <style>
    :root { color-scheme: light dark; }
    html, body {
      margin: 0;
      padding: 0;
      min-height: 100%;
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground, #cccccc);
      background: var(--vscode-sideBar-background, #252526);
    }
    .wrap { padding: 8px 10px 16px; }
    .tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 2px;
      margin: 0 0 10px;
      border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
    }
    .tabs button {
      border: none;
      border-bottom: 2px solid transparent;
      border-radius: 0;
      margin-bottom: -1px;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      font: inherit;
      font-size: 11px;
      font-weight: 500;
      padding: 4px 8px 6px;
      cursor: pointer;
    }
    .tabs button:hover { color: var(--vscode-foreground); }
    .tabs button[aria-selected="true"] {
      color: var(--vscode-foreground);
      border-bottom-color: var(--vscode-focusBorder);
    }
    .tabs .n {
      font-variant-numeric: tabular-nums;
      opacity: 0.65;
      margin-left: 4px;
    }
    .search {
      display: block;
      width: 100%;
      box-sizing: border-box;
      margin: 0 0 8px;
      padding: 4px 8px;
      border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, #3c3c3c));
      border-radius: 4px;
      background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #cccccc);
      font: inherit;
      font-size: 12px;
      outline: none;
    }
    .search:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .search::placeholder {
      color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground));
    }
    .pager {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-top: 8px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .pager .range { font-variant-numeric: tabular-nums; }
    .pager .btns { display: flex; gap: 4px; }
    .pager button {
      font: inherit;
      font-size: 11px;
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 4px;
      padding: 2px 8px;
      cursor: pointer;
      background: transparent;
      color: var(--vscode-foreground);
    }
    .pager button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
    .pager button:disabled { opacity: 0.4; cursor: default; }
    .group {
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      margin: 14px 0 6px;
    }
    .group:first-of-type { margin-top: 0; }
    .note {
      font-size: 11px;
      line-height: 1.45;
      color: var(--vscode-descriptionForeground);
      margin: 0 0 8px;
    }
    .card {
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 6px;
      padding: 8px;
      margin-bottom: 6px;
      background: var(--vscode-sideBar-background);
      cursor: pointer;
    }
    .card:hover { background: var(--vscode-list-hoverBackground); }
    .card:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .row {
      display: flex;
      gap: 8px;
      align-items: flex-start;
    }
    .num {
      flex: 0 0 28px;
      height: 28px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-variant-numeric: tabular-nums;
      font-weight: 650;
      font-size: 11px;
      background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,0.15));
    }
    .body { flex: 1; min-width: 0; }
    .name { font-weight: 600; line-height: 1.3; }
    .overview {
      margin-top: 3px;
      font-size: 11px;
      line-height: 1.4;
      color: var(--vscode-descriptionForeground);
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .bar {
      margin-top: 7px;
      height: 3px;
      border-radius: 99px;
      background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,0.2));
      overflow: hidden;
    }
    .bar > i {
      display: block;
      height: 100%;
      background: var(--vscode-progressBar-background, var(--vscode-button-background));
    }
    .meta {
      margin-top: 4px;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }
    .actions { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px; }
    .card button {
      font: inherit;
      font-size: 11px;
      font-weight: 600;
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 4px;
      padding: 3px 8px;
      cursor: pointer;
      background: transparent;
      color: var(--vscode-foreground);
    }
    .card button:hover { background: var(--vscode-toolbar-hoverBackground); }
    .card button.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: transparent;
    }
    .card button.primary:hover { background: var(--vscode-button-hoverBackground); }
    .callout {
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 6px;
      padding: 8px;
      margin: 0 0 10px;
    }
    .callout .name { font-weight: 600; line-height: 1.3; }
    .callout button {
      font: inherit;
      font-size: 11px;
      font-weight: 600;
      border: none;
      border-radius: 4px;
      padding: 4px 8px;
      cursor: pointer;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .callout button:hover { background: var(--vscode-button-hoverBackground); }
    .empty {
      color: var(--vscode-descriptionForeground, #9da7b3);
      font-size: 12px;
      line-height: 1.5;
      padding: 12px 4px;
    }
    .empty code {
      font-size: 11px;
      color: var(--vscode-foreground);
    }
    .pick {
      flex: 0 0 16px;
      display: flex;
      align-items: center;
      height: 28px;
      cursor: pointer;
    }
    .pick input { margin: 0; }
    .selbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      margin: 0 0 8px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .selbar button {
      font: inherit;
      font-size: 11px;
      font-weight: 600;
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 4px;
      padding: 2px 8px;
      cursor: pointer;
      background: transparent;
      color: var(--vscode-foreground);
    }
    .selbar button:hover { background: var(--vscode-toolbar-hoverBackground); }
    .xfer { margin: 0 0 8px; }
    .xfer-label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
    }
    .xfer-bar {
      height: 3px;
      border-radius: 99px;
      background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,0.2));
      overflow: hidden;
    }
    .xfer-bar > i {
      display: block;
      height: 100%;
      width: 0;
      background: var(--vscode-progressBar-background, var(--vscode-button-background));
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div id="banner"></div>
    <div id="xfer" class="xfer" hidden>
      <div id="xfer-label" class="xfer-label"></div>
      <div class="xfer-bar"><i id="xfer-bar"></i></div>
    </div>
    <input id="q" class="search" type="search" placeholder="Search plans" aria-label="Search plans" />
    <div id="tabs" class="tabs" role="tablist" aria-label="Plan status" hidden></div>
    <div id="selbar"></div>
    <div id="list"><p class="empty" style="color:#9da7b3">Loading plans…</p></div>
    <div id="pager"></div>
  </div>
  <script>
    try {
    const vscode = acquireVsCodeApi();
    const saved = vscode.getState() || {};
    let allPlans = [];
    let homeDir = "";
    let homeOmitted = 0;
    let activeHome = null;
    // Persist tab, query, and page when the watcher rebuilds the list.
    let filter = saved.filter || "all";
    let query = saved.query || "";
    let page = saved.page || 1;
    let selected = new Set(saved.selected || []);
    let pageUris = [];

    function esc(s) {
      return String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }
    function escAttr(s) {
      return esc(s).replace(/"/g, "&quot;");
    }

    function badge(p) {
      return p.id ? esc(p.id) : "·";
    }

    function card(p) {
      const todos = p.todos || [];
      const done = todos.filter((t) => t.status === "completed").length;
      const total = todos.length;
      const pct = total ? Math.round((done / total) * 100) : 0;
      const on = selected.has(p.uri) ? "checked" : "";
      return \`<article class="card" data-open="\${escAttr(p.uri)}" role="button" tabindex="0">
        <div class="row">
          <label class="pick" data-select="\${escAttr(p.uri)}"><input type="checkbox" tabindex="-1" \${on} /></label>
          <div class="num">\${badge(p)}</div>
          <div class="body">
            <div class="name">\${esc(p.name)}</div>
            <div class="overview">\${esc(p.overview)}</div>
            <div class="bar"><i style="width:\${pct}%"></i></div>
            <div class="meta">\${done}/\${total} done\${p.source === "home" ? " · home folder" : ""}</div>
            <div class="actions">
              <button type="button" data-copy="\${escAttr(p.prompt)}">Copy build prompt</button>
              \${p.source === "home" ? \`<button type="button" data-save="\${escAttr(p.uri)}">Save to workspace</button>\` : ""}
              <button type="button" data-export-one="\${escAttr(p.uri)}">Export</button>
            </div>
          </div>
        </div>
      </article>\`;
    }

    // Shared helpers are injected as source. They must stay plain functions.
    ${progressOf.toString()}
    ${filterPlans.toString()}
    ${searchPlans.toString()}
    const PAGE_SIZE = ${PAGE_SIZE};
    ${paginatePlans.toString()}
    ${groupSections.toString()}

    function persist() {
      vscode.setState({ filter, query, page, selected: [...selected] });
    }

    function postSelection() {
      vscode.postMessage({ type: "selection", uris: [...selected] });
    }

    function pruneSelected() {
      const live = new Set(allPlans.map((p) => p.uri));
      for (const uri of [...selected]) {
        if (!live.has(uri)) selected.delete(uri);
      }
    }

    function selbarHtml() {
      const n = selected.size;
      if (!allPlans.length) return "";
      let html = '<div class="selbar">';
      html += '<button type="button" data-select-page>Select page</button>';
      if (n) {
        html += \`<span>\${n} selected</span>
          <button type="button" data-export-sel>Export selected</button>
          <button type="button" data-select-clear>Clear</button>\`;
      } else {
        html += '<button type="button" data-export-all>Export all</button>';
      }
      html += '<button type="button" data-import>Import</button></div>';
      return html;
    }

    function searched() {
      return searchPlans(allPlans, query);
    }

    function count(kind) {
      const pool = searched();
      if (kind === "all") return pool.length;
      return pool.filter((p) => progressOf(p) === kind).length;
    }

    function tab(id, label) {
      const on = filter === id ? "true" : "false";
      return \`<button type="button" role="tab" data-filter="\${id}" aria-selected="\${on}">\${label}<span class="n">\${count(id)}</span></button>\`;
    }

    function workspaceHtml(plans) {
      if (!plans.length) return "";
      return groupSections(plans).map((section) => {
        const heading = section.title ? \`<div class="group">\${esc(section.title)}</div>\` : "";
        return heading + section.plans.map(card).join("");
      }).join("");
    }

    function bannerHtml() {
      let html = "";
      if (homeDir && allPlans.some((p) => p.source === "home")) {
        html += \`<p class="note">Cursor stores plans in <code>\${esc(homeDir)}</code></p>\`;
        if (homeOmitted > 0) {
          html += \`<p class="note">\${homeOmitted} more in the home folder. Use <strong>Save to workspace</strong> or search here.</p>\`;
        }
      }
      if (!activeHome) return html;
      return html + \`<div class="callout">
        <div class="name">\${esc(activeHome.name)}</div>
        <p class="note">This file is in the home folder, not this project.</p>
        <button type="button" data-save="\${escAttr(activeHome.uri)}">Save to workspace</button>
      </div>\`;
    }

    function pagerHtml(slice) {
      if (slice.pages < 2) return "";
      const prevOff = slice.page <= 1 ? "disabled" : "";
      const nextOff = slice.page >= slice.pages ? "disabled" : "";
      return \`<div class="pager">
        <span class="range">\${slice.from}–\${slice.to} of \${slice.total}</span>
        <span class="btns">
          <button type="button" data-page="prev" \${prevOff} aria-label="Previous page">Prev</button>
          <button type="button" data-page="next" \${nextOff} aria-label="Next page">Next</button>
        </span>
      </div>\`;
    }

    function paint(payload) {
      try {
      if (payload) {
        allPlans = payload.plans || [];
        homeDir = payload.homeDir || "";
        homeOmitted = payload.homeOmitted || 0;
        activeHome = payload.activeHome || null;
        pruneSelected();
      }
      document.getElementById("banner").innerHTML = bannerHtml();
      const qEl = document.getElementById("q");
      const tabs = document.getElementById("tabs");
      const selbar = document.getElementById("selbar");
      const list = document.getElementById("list");
      const pager = document.getElementById("pager");
      if (!allPlans.length) {
        qEl.hidden = true;
        tabs.hidden = true;
        tabs.innerHTML = "";
        selbar.innerHTML = selbarHtml();
        pager.innerHTML = "";
        pageUris = [];
        list.innerHTML = '<p class="empty">No plan files in this project or in <code>' + esc(homeDir || "~/.cursor/plans") + '</code>. Run <strong>Plans: Save to workspace</strong> or Import a <code>.cplan</code> file.</p>';
        return;
      }
      qEl.hidden = false;
      tabs.hidden = false;
      if (document.activeElement !== qEl) qEl.value = query;
      tabs.innerHTML = tab("all", "All") + tab("new", "New") + tab("in_progress", "In progress") + tab("done", "Done");
      selbar.innerHTML = selbarHtml();
      const labels = { new: "new", in_progress: "in progress", done: "done" };
      const shown = filterPlans(searched(), filter);
      const slice = paginatePlans(shown, page);
      page = slice.page;
      pageUris = slice.items.map((p) => p.uri);
      if (!shown.length) {
        list.innerHTML = query
          ? \`<p class="empty">No plans match “\${esc(query)}”.</p>\`
          : \`<p class="empty">No \${labels[filter] || ""} plans.</p>\`;
        pager.innerHTML = "";
        return;
      }
      list.innerHTML = workspaceHtml(slice.items);
      pager.innerHTML = pagerHtml(slice);
      } catch (err) {
        const list = document.getElementById("list");
        if (list) list.innerHTML = '<p class="empty">' + esc(err && err.message ? err.message : String(err)) + '</p>';
      }
    }

    const wrap = document.querySelector(".wrap");
    if (!wrap) throw new Error("Plans markup missing");
    wrap.addEventListener("click", (e) => {
      const tabBtn = e.target.closest("[data-filter]");
      if (tabBtn) {
        e.preventDefault();
        e.stopPropagation();
        filter = tabBtn.getAttribute("data-filter");
        page = 1;
        persist();
        paint();
        return;
      }
      const pageBtn = e.target.closest("[data-page]");
      if (pageBtn && !pageBtn.disabled) {
        e.preventDefault();
        e.stopPropagation();
        page += pageBtn.getAttribute("data-page") === "next" ? 1 : -1;
        persist();
        paint();
        return;
      }
      const pick = e.target.closest("[data-select]");
      if (pick) {
        e.stopPropagation();
        const uri = pick.getAttribute("data-select");
        if (selected.has(uri)) selected.delete(uri);
        else selected.add(uri);
        persist();
        postSelection();
        paint();
        return;
      }
      if (e.target.closest("[data-select-page]")) {
        e.preventDefault();
        e.stopPropagation();
        for (const uri of pageUris) selected.add(uri);
        persist();
        postSelection();
        paint();
        return;
      }
      if (e.target.closest("[data-select-clear]")) {
        e.preventDefault();
        e.stopPropagation();
        selected.clear();
        persist();
        postSelection();
        paint();
        return;
      }
      if (e.target.closest("[data-export-all]")) {
        e.preventDefault();
        e.stopPropagation();
        vscode.postMessage({ type: "export", uris: [] });
        return;
      }
      if (e.target.closest("[data-export-sel]")) {
        e.preventDefault();
        e.stopPropagation();
        vscode.postMessage({ type: "export", uris: [...selected] });
        return;
      }
      const one = e.target.closest("[data-export-one]");
      if (one) {
        e.preventDefault();
        e.stopPropagation();
        vscode.postMessage({ type: "export", uris: [one.getAttribute("data-export-one")] });
        return;
      }
      if (e.target.closest("[data-import]")) {
        e.preventDefault();
        e.stopPropagation();
        vscode.postMessage({ type: "import" });
        return;
      }
      const save = e.target.closest("[data-save]");
      if (save) {
        e.preventDefault();
        e.stopPropagation();
        vscode.postMessage({ type: "save", uri: save.getAttribute("data-save") });
        return;
      }
      const copy = e.target.closest("[data-copy]");
      if (copy) {
        e.preventDefault();
        e.stopPropagation();
        vscode.postMessage({ type: "copy", prompt: copy.getAttribute("data-copy") });
        return;
      }
      const open = e.target.closest("[data-open]");
      if (open) {
        vscode.postMessage({ type: "open", uri: open.getAttribute("data-open") });
      }
    });
    wrap.addEventListener("input", (e) => {
      if (e.target.id !== "q") return;
      query = e.target.value;
      page = 1;
      persist();
      paint();
    });
    wrap.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (e.target.closest("input, [data-copy], [data-save], [data-page], [data-select], [data-export-one]")) return;
      const open = e.target.closest("[data-open]");
      if (!open) return;
      e.preventDefault();
      vscode.postMessage({ type: "open", uri: open.getAttribute("data-open") });
    });

    window.addEventListener("message", (e) => {
      const data = e.data || {};
      if (data.type === "plans") paint(data);
      if (data.type === "progress") {
        document.getElementById("xfer").hidden = false;
        document.getElementById("xfer-label").textContent = data.label || "";
        document.getElementById("xfer-bar").style.width = (data.pct || 0) + "%";
      }
      if (data.type === "progress-done") {
        document.getElementById("xfer").hidden = true;
        document.getElementById("xfer-bar").style.width = "0";
      }
    });
    vscode.postMessage({ type: "ready" });
    postSelection();
    } catch (err) {
      const list = document.getElementById("list");
      if (list) list.innerHTML = '<p class="empty">' + String(err) + '</p>';
    }
  </script>
</body>
</html>`;
  }
}

function withUri(plan) {
  return { ...plan, uri: vscode.Uri.file(plan.abs).toString() };
}

function workspaceFolders() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) return [];
  return folders.map((folder) => ({ root: folder.uri.fsPath, index: folder.index }));
}

/** The open editor, if it is a plan still sitting in `~/.cursor/plans`. */
function activeHomePlan() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== "file") return null;
  const abs = editor.document.uri.fsPath;
  if (!abs.endsWith(".plan.md") || !isUnderDir(abs, homePlansDir()) || !fs.existsSync(abs)) {
    return null;
  }
  const name = path.basename(abs);
  const parsed = parsePlanSource(editor.document.getText(), name);
  return withUri({ ...parsed, id: "", abs, rel: name, source: "home", prompt: "" });
}

/** Workspace plans plus the user home folder Cursor actually writes to. */
function scanPlans() {
  const folders = workspaceFolders();
  const homeDir = homePlansDir();
  if (!folders.length) return { plans: [], homeDir, homeOmitted: 0, activeHome: null };
  const listed = listSidebarPlans(folders, homeDir);
  return {
    plans: listed.plans.map(withUri),
    homeDir,
    homeOmitted: listed.homeOmitted,
    activeHome: activeHomePlan(),
  };
}

function workspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length ? folders[0].uri.fsPath : "";
}

function workspacePlanNames() {
  return new Set(collectPlans(workspaceFolders()).map((p) => path.basename(p.abs)));
}

async function saveUriToWorkspace(uriString) {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showWarningMessage("Open a folder to save a plan into the workspace.");
    return;
  }
  const abs = vscode.Uri.parse(uriString).fsPath;
  if (!abs.endsWith(".plan.md") || !isUnderDir(abs, homePlansDir()) || !fs.existsSync(abs)) {
    vscode.window.showWarningMessage("Only plans in ~/.cursor/plans can be saved to the workspace.");
    return;
  }
  let dest;
  try {
    dest = savePlanToWorkspace(abs, root);
  } catch (err) {
    vscode.window.showErrorMessage(
      "Could not save the plan: " + (err && err.message ? err.message : String(err)),
    );
    return;
  }
  const rel = path.relative(root, dest).split(path.sep).join("/");
  const doc = await vscode.workspace.openTextDocument(dest);
  await vscode.window.showTextDocument(doc, { preview: true });
  const note = fs.existsSync(abs) ? " The original is still in ~/.cursor/plans." : "";
  vscode.window.showInformationMessage("Saved to " + rel + "." + note);
}

async function pickAndSaveHomePlan() {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showWarningMessage("Open a folder to save a plan into the workspace.");
    return;
  }
  const homeDir = homePlansDir();
  if (homeDirOverlapsWorkspace(homeDir, workspaceFolders())) {
    vscode.window.showInformationMessage("This folder already is ~/.cursor/plans.");
    return;
  }
  const { plans } = collectHomePlans(homeDir, workspacePlanNames(), 0);
  if (!plans.length) {
    vscode.window.showInformationMessage("No extra plans in ~/.cursor/plans to move here.");
    return;
  }
  const picked = await vscode.window.showQuickPick(
    plans.map((p) => ({
      label: p.name,
      description: p.rel,
      detail: p.overview,
      abs: p.abs,
    })),
    {
      title: "Move a home-folder plan into this project",
      placeHolder: "Filter by name",
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );
  if (!picked) return;
  await saveUriToWorkspace(vscode.Uri.file(picked.abs).toString());
}

async function saveActiveEditor() {
  if (activeHomePlan()) {
    await saveUriToWorkspace(vscode.window.activeTextEditor.document.uri.toString());
    return;
  }
  await pickAndSaveHomePlan();
}

function plansForExport(uris) {
  const all = listSidebarPlans(workspaceFolders(), homePlansDir()).plans;
  if (!uris || !uris.length) return all;
  const want = new Set(uris);
  return all.filter((p) => want.has(vscode.Uri.file(p.abs).toString()));
}

function exportFileName(plans) {
  if (plans.length === 1) {
    return path.basename(plans[0].abs).replace(/\.plan\.md$/, "") + ".cplan";
  }
  const folder = vscode.workspace.name || "plans";
  return folder.replace(/[^\w.-]+/g, "-") + ".cplan";
}

async function exportPlans(uris) {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showWarningMessage("Open a folder to export plans.");
    return;
  }
  const plans = plansForExport(uris);
  if (!plans.length) {
    vscode.window.showWarningMessage("No plans to export.");
    return;
  }
  const dest = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(root, exportFileName(plans))),
    filters: { "Cursor Plans": ["cplan"] },
    saveLabel: "Export",
    title: plans.length === 1 ? "Export plan" : "Export " + plans.length + " plans",
  });
  if (!dest) return;
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Exporting plans" },
      async (progress) => {
        const entries = [];
        for (let i = 0; i < plans.length; i += 1) {
          const file = path.basename(plans[i].abs);
          const label = i + 1 + " of " + plans.length + " · " + file;
          const pct = Math.round(((i + 1) / plans.length) * 100);
          progress.report({ message: label, increment: 100 / plans.length });
          broadcast({ type: "progress", label, pct });
          entries.push({ file, content: fs.readFileSync(plans[i].abs, "utf8") });
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const body = stringifyBundle(buildBundle(entries));
        await vscode.workspace.fs.writeFile(dest, Buffer.from(body, "utf8"));
      },
    );
    vscode.window.showInformationMessage(
      "Exported " + plans.length + (plans.length === 1 ? " plan." : " plans."),
    );
  } catch (err) {
    vscode.window.showErrorMessage("Export failed: " + (err && err.message ? err.message : String(err)));
  } finally {
    broadcast({ type: "progress-done" });
  }
}

async function importPlans() {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showWarningMessage("Open a folder to import plans.");
    return;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { "Cursor Plans": ["cplan"] },
    openLabel: "Import",
    title: "Import plans",
  });
  if (!picked || !picked.length) return;
  let bundle;
  try {
    const raw = Buffer.from(await vscode.workspace.fs.readFile(picked[0])).toString("utf8");
    bundle = parseBundle(raw);
  } catch (err) {
    vscode.window.showErrorMessage(err && err.message ? err.message : String(err));
    return;
  }
  const destDir = path.join(root, ".cursor", "plans");
  const collisions = bundle.plans.filter((p) => fs.existsSync(path.join(destDir, p.file)));
  let conflict = "rename";
  if (collisions.length) {
    const choice = await vscode.window.showQuickPick(
      [
        { label: "Keep both", description: "Add -2, -3 to names that already exist", id: "rename" },
        { label: "Overwrite", description: "Replace existing files", id: "overwrite" },
        { label: "Skip existing", description: "Import only new names", id: "skip" },
      ],
      { title: collisions.length + " plan(s) already exist in this project", placeHolder: "Choose how to import" },
    );
    if (!choice) return;
    conflict = choice.id;
  }
  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Importing plans" },
      async (progress) => {
        return importBundle(bundle, destDir, conflict, undefined, (step) => {
          const label = step.index + " of " + step.total + " · " + step.file;
          const pct = Math.round((step.index / step.total) * 100);
          progress.report({ message: label, increment: 100 / step.total });
          broadcast({ type: "progress", label, pct });
        });
      },
    );
    const parts = ["Imported " + result.written.length];
    if (result.skipped.length) parts.push("skipped " + result.skipped.length);
    vscode.window.showInformationMessage(parts.join(", ") + ".");
  } catch (err) {
    vscode.window.showErrorMessage("Import failed: " + (err && err.message ? err.message : String(err)));
  } finally {
    broadcast({ type: "progress-done" });
  }
}

/** Open a plans README if one exists; otherwise reveal the plans folder. */
async function openIndex() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) {
    vscode.window.showWarningMessage("Open a folder to use Plans.");
    return;
  }
  const root = folders[0].uri.fsPath;
  const readmes = [
    path.join(root, ".cursor", "plans", "README.md"),
    path.join(root, "docs", "plans", "README.md"),
  ];
  for (const index of readmes) {
    if (!fs.existsSync(index)) continue;
    const doc = await vscode.workspace.openTextDocument(index);
    await vscode.window.showTextDocument(doc, { preview: true });
    return;
  }
  const dirs = planDirs(root);
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(dir));
    return;
  }
  vscode.window.showInformationMessage("Add *.plan.md files to .cursor/plans/ in this workspace.");
}

module.exports = { activate, deactivate };
