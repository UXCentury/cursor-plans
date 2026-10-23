const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const { collectPlans, planDirs, groupSections } = require("./lib/plans");

const PLAN_GLOBS = [".cursor/plans/*.plan.md", "docs/plans/*.plan.md"];

function activate(context) {
  const sidebar = new PlansViewProvider();
  const explorer = new PlansViewProvider();
  const opts = { webviewOptions: { retainContextWhenHidden: true } };
  const refreshAll = debounce(() => {
    sidebar.refresh();
    explorer.refresh();
  }, 80);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("plans.sidebar", sidebar, opts),
    vscode.window.registerWebviewViewProvider("plans.explorer", explorer, opts),
    vscode.commands.registerCommand("plans.refresh", refreshAll),
    vscode.commands.registerCommand("plans.openIndex", () => openIndex()),
    vscode.commands.registerCommand("plans.focus", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.plans");
      await vscode.commands.executeCommand("plans.sidebar.focus");
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(refreshAll),
    ...watchPlanFiles(refreshAll),
  );
}

function deactivate() {}

function watchPlanFiles(onChange) {
  return PLAN_GLOBS.map((glob) => {
    const watcher = vscode.workspace.createFileSystemWatcher("**/" + glob);
    watcher.onDidCreate(onChange);
    watcher.onDidChange(onChange);
    watcher.onDidDelete(onChange);
    return watcher;
  });
}

function debounce(fn, ms) {
  let timer;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

class PlansViewProvider {
  constructor() {
    this.view = undefined;
    this.ready = false;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    this.ready = false;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage((msg) => {
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
    webviewView.webview.html = this.render();
  }

  refresh() {
    if (!this.view || !this.ready) return;
    this.view.webview.postMessage({ type: "plans", plans: scanPlans() });
  }

  async onMessage(msg) {
    if (msg.type === "open" && msg.uri) {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(msg.uri));
      await vscode.window.showTextDocument(doc, { preview: true });
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
      height: 100%;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: transparent;
    }
    .wrap { padding: 8px 10px 16px; }
    .hint {
      font-size: 11px;
      line-height: 1.45;
      color: var(--vscode-descriptionForeground);
      margin: 0 0 12px;
    }
    .group {
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      margin: 14px 0 6px;
    }
    .group:first-of-type { margin-top: 0; }
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
    .actions { margin-top: 8px; }
    button {
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
    button:hover { background: var(--vscode-toolbar-hoverBackground); }
    .empty {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      line-height: 1.5;
      padding: 12px 4px;
    }
    .empty code {
      font-size: 11px;
      color: var(--vscode-foreground);
    }
  </style>
</head>
<body>
  <div class="wrap" id="root"></div>
  <script>
    const vscode = acquireVsCodeApi();

    function esc(s) {
      return String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }
    function escAttr(s) {
      return esc(s).replace(/"/g, "&quot;");
    }

    function card(p) {
      const done = p.todos.filter((t) => t.status === "completed").length;
      const total = p.todos.length;
      const pct = total ? Math.round((done / total) * 100) : 0;
      return \`<article class="card" data-open="\${escAttr(p.uri)}" role="button" tabindex="0">
        <div class="row">
          <div class="num">\${esc(p.id)}</div>
          <div class="body">
            <div class="name">\${esc(p.name)}</div>
            <div class="overview">\${esc(p.overview)}</div>
            <div class="bar"><i style="width:\${pct}%"></i></div>
            <div class="meta">\${done}/\${total} done</div>
            <div class="actions">
              <button type="button" data-copy="\${escAttr(p.prompt)}">Copy build prompt</button>
            </div>
          </div>
        </div>
      </article>\`;
    }

    ${groupSections.toString()}

    function paint(plans) {
      const root = document.getElementById("root");
      if (!plans.length) {
        root.innerHTML = '<p class="empty">Add a <code>01-name.plan.md</code> file to <code>.cursor/plans/</code>.</p>';
        return;
      }
      let html = '<p class="hint">Click a plan to open it. Copy the build prompt into a new Agent chat to run it.</p>';
      html += groupSections(plans).map((section) => {
        const heading = section.title ? \`<div class="group">\${esc(section.title)}</div>\` : "";
        return heading + section.plans.map(card).join("");
      }).join("");
      root.innerHTML = html;
    }

    const root = document.getElementById("root");
    root.addEventListener("click", (e) => {
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
    root.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (e.target.closest("[data-copy]")) return;
      const open = e.target.closest("[data-open]");
      if (!open) return;
      e.preventDefault();
      vscode.postMessage({ type: "open", uri: open.getAttribute("data-open") });
    });

    window.addEventListener("message", (e) => {
      if (e.data && e.data.type === "plans") paint(e.data.plans);
    });
    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }
}

function scanPlans() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) return [];
  return collectPlans(
    folders.map((folder) => ({ root: folder.uri.fsPath, index: folder.index })),
  ).map((plan) => ({
    ...plan,
    uri: vscode.Uri.file(plan.abs).toString(),
  }));
}

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
