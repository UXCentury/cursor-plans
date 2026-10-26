/**
 * Plan file parsing and list helpers.
 *
 * Kept free of the VS Code API so Node tests can cover the rules that
 * used to break silently: numbered filenames, real @ paths, grouping,
 * New / In progress / Done, and moving a home-folder plan into the project.
 */

const fs = require("fs");
const path = require("path");

/** Search order. `.cursor/plans` is Cursor's native location; `docs/plans` is the fallback. */
const PLAN_DIR_REL = [".cursor/plans", "docs/plans"];

/** Default cap when listing home-folder plans. The picker passes 0 for no cap. */
const HOME_PLAN_LIMIT = 40;

function defaultIo() {
  return {
    exists: fs.existsSync,
    readDir: (dir) => fs.readdirSync(dir),
    readFile: (abs) => fs.readFileSync(abs, "utf8"),
    stat: (abs) => fs.statSync(abs),
    mkdir: (dir) => fs.mkdirSync(dir, { recursive: true }),
    rename: (from, to) => fs.renameSync(from, to),
    copyFile: (from, to) => fs.copyFileSync(from, to),
    unlink: (abs) => fs.unlinkSync(abs),
  };
}

function planDirs(root) {
  return PLAN_DIR_REL.map((rel) => path.join(root, ...rel.split("/")));
}

function homePlansDir(home = require("os").homedir()) {
  return path.join(home, ".cursor", "plans");
}

/** Two-digit prefix is the badge id. Cursor's native `slug_hash.plan.md` files have none. */
function planId(filename) {
  return (filename.match(/^(\d{2})-/) || [])[1] || "";
}

function posixRel(root, abs) {
  return path.relative(root, abs).split(path.sep).join("/");
}

/** Display name when frontmatter has no `name:`. Strips the trailing Cursor hash. */
function fallbackName(filename) {
  return filename
    .replace(/\.plan\.md$/, "")
    .replace(/^\d{2}-/, "")
    .replace(/_[a-f0-9]{8}$/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
}

/**
 * Build prompt pasted into a new Agent chat.
 * `rel` must be the workspace-relative path of the file that was scanned.
 */
function buildPrompt(rel) {
  return [
    "Build this plan. Do not edit the plan file itself. Follow it as specified.",
    "",
    "@" + rel,
  ].join("\n");
}

function stripQuotes(s) {
  return s.replace(/\*\*/g, "").replace(/^"|"$/g, "").trim();
}

/**
 * Parse Cursor-style YAML frontmatter from a `.plan.md` body.
 * Unknown or missing fields become empty strings / an empty todo list.
 */
function parsePlanSource(raw, filename) {
  const fm = raw.startsWith("---") ? raw.slice(3).split("\n---")[0] : "";
  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  const overviewMatch = fm.match(/^overview:\s*"?(.+?)"?\s*$/m);
  const groupMatch = fm.match(/^group:\s*"?(.+?)"?\s*$/m);
  const todos = [];
  const todoBlock = fm.split(/^todos:\s*$/m)[1] || "";
  const chunks = todoBlock.split(/^\s*- id:/m).slice(1);
  for (const chunk of chunks) {
    const status = (chunk.match(/status:\s*(\w+)/) || [])[1] || "pending";
    const content = (chunk.match(/content:\s*"(.+)"/) || [])[1] || "";
    todos.push({ status, content });
  }
  return {
    name: nameMatch ? nameMatch[1].trim() : fallbackName(filename),
    overview: stripQuotes(overviewMatch ? overviewMatch[1] : ""),
    group: stripQuotes(groupMatch ? groupMatch[1] : ""),
    todos,
  };
}

function isPlanFile(name) {
  return name.endsWith(".plan.md");
}

function compareWorkspacePlans(a, b) {
  if (a.id && b.id) return a.id.localeCompare(b.id) || a.rel.localeCompare(b.rel);
  if (a.id) return -1;
  if (b.id) return 1;
  return a.rel.localeCompare(b.rel);
}

/**
 * Scan workspace folders for plan files.
 * `io` is injectable so tests can run without touching the real disk.
 */
function collectPlans(folders, io = defaultIo()) {
  const found = new Map();
  for (const folder of folders) {
    const root = folder.root;
    const index = folder.index;
    for (const dir of planDirs(root)) {
      if (!io.exists(dir)) continue;
      for (const name of io.readDir(dir).slice().sort()) {
        if (!isPlanFile(name)) continue;
        const abs = path.join(dir, name);
        const rel = posixRel(root, abs);
        const key = index + ":" + rel;
        if (found.has(key)) continue;
        const parsed = parsePlanSource(io.readFile(abs), name);
        found.set(key, {
          ...parsed,
          id: planId(name),
          abs,
          rel,
          source: "workspace",
          prompt: buildPrompt(rel),
        });
      }
    }
  }
  return [...found.values()].sort(compareWorkspacePlans);
}

/**
 * True when two paths are the same file or directory.
 * `path.relative` ignores drive-letter case on Windows. String equality does not:
 * VS Code's `fsPath` is `c:\...` while `os.homedir()` is `C:\...`.
 */
function samePath(a, b, pathImpl = path) {
  return pathImpl.relative(pathImpl.resolve(a), pathImpl.resolve(b)) === "";
}

/**
 * True when the workspace already is `~/.cursor/plans` (or contains it).
 * In that case the home-folder section would duplicate the workspace list.
 */
function homeDirOverlapsWorkspace(homeDir, folders, pathImpl = path) {
  return (folders || []).some((folder) => {
    const root = folder.root;
    return (
      samePath(homeDir, root, pathImpl) ||
      samePath(homeDir, pathImpl.resolve(root, ".cursor", "plans"), pathImpl)
    );
  });
}

/**
 * Newest plans from `~/.cursor/plans` that are not already in the workspace.
 * Used by the Save to workspace picker. `limit` 0 means no cap.
 */
function collectHomePlans(homeDir, skipNames, limit = HOME_PLAN_LIMIT, io = defaultIo()) {
  const empty = { plans: [], omitted: 0, total: 0 };
  if (!homeDir || !io.exists(homeDir)) return empty;
  const skip = skipNames instanceof Set ? skipNames : new Set(skipNames || []);
  const ranked = [];
  for (const name of io.readDir(homeDir)) {
    if (!isPlanFile(name) || skip.has(name)) continue;
    const abs = path.join(homeDir, name);
    const mtime = io.stat ? io.stat(abs).mtimeMs : 0;
    ranked.push({ name, abs, mtime });
  }
  ranked.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  const total = ranked.length;
  const slice = !limit ? ranked : ranked.slice(0, limit);
  const plans = slice.map((row) => {
    const parsed = parsePlanSource(io.readFile(row.abs), row.name);
    return {
      ...parsed,
      id: planId(row.name),
      abs: row.abs,
      rel: row.name,
      source: "home",
      prompt: "",
    };
  });
  return { plans, omitted: Math.max(0, total - plans.length), total };
}

/**
 * Workspace plans, then the newest home-folder plans Cursor wrote outside the repo.
 * Same rules on macOS, Linux, and Windows. Home entries are capped so large profiles
 * stay responsive; names already in the workspace are not listed twice.
 */
function listSidebarPlans(folders, homeDir, io = defaultIo()) {
  const workspace = collectPlans(folders, io);
  if (!homeDir || homeDirOverlapsWorkspace(homeDir, folders)) {
    return { plans: workspace, homeOmitted: 0, homeTotal: 0 };
  }
  const skip = new Set(workspace.map((p) => path.basename(p.abs)));
  const { plans: homeRaw, omitted, total } = collectHomePlans(homeDir, skip, HOME_PLAN_LIMIT, io);
  const home = homeRaw.map((p) => ({
    ...p,
    prompt: buildPrompt(p.abs.split(path.sep).join("/")),
  }));
  return {
    plans: [...workspace, ...home],
    homeOmitted: omitted,
    homeTotal: total,
  };
}

/** Next free `name.plan.md` / `name-2.plan.md` path under destDir. */
function uniquePlanPath(destDir, filename, exists = fs.existsSync) {
  const dest = path.join(destDir, filename);
  if (!exists(dest)) return dest;
  const base = filename.replace(/\.plan\.md$/, "");
  let i = 2;
  while (exists(path.join(destDir, `${base}-${i}.plan.md`))) i += 1;
  return path.join(destDir, `${base}-${i}.plan.md`);
}

/**
 * Move a home-folder plan into `<workspace>/.cursor/plans/`.
 * A rename across drives (C: to F:) fails, so fall back to copy.
 * Windows also refuses to delete a file the editor still has open; the
 * workspace copy is kept and the original stays in `~/.cursor/plans`.
 */
function savePlanToWorkspace(abs, workspaceRoot, io = defaultIo()) {
  const destDir = path.join(workspaceRoot, ".cursor", "plans");
  io.mkdir(destDir);
  const dest = uniquePlanPath(destDir, path.basename(abs), io.exists);
  try {
    io.rename(abs, dest);
    return dest;
  } catch {
    // EXDEV across drives, or EPERM while the editor holds the file.
  }
  io.copyFile(abs, dest);
  try {
    io.unlink(abs);
  } catch {
    // The original is still open. Leave it in the home folder.
  }
  return dest;
}

function isUnderDir(abs, dir, pathImpl = path) {
  const rel = pathImpl.relative(pathImpl.resolve(dir), pathImpl.resolve(abs));
  if (rel === "") return true;
  if (pathImpl.isAbsolute(rel)) return false;
  const parent = ".." + pathImpl.sep;
  return rel !== ".." && !rel.startsWith(parent);
}

/**
 * Roll todo statuses up to one list filter.
 * `cancelled` does not count as unfinished; `in_progress` always wins.
 */
function progressOf(plan) {
  const todos = plan.todos || [];
  if (!todos.length) return "new";
  const anyActive = todos.some((t) => t.status === "in_progress");
  const anyDone = todos.some((t) => t.status === "completed");
  const unfinished = todos.some((t) => t.status !== "completed" && t.status !== "cancelled");
  if (anyActive || (anyDone && unfinished)) return "in_progress";
  if (anyDone && !unfinished) return "done";
  return "new";
}

function filterPlans(plans, filter) {
  if (!filter || filter === "all") return plans;
  return plans.filter((p) => progressOf(p) === filter);
}

/** Case-insensitive match on name, overview, group, path, and id. All terms must match. */
function searchPlans(plans, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return plans;
  const terms = q.split(/\s+/);
  return plans.filter((p) => {
    const hay = [p.name, p.overview, p.group, p.rel, p.id].join(" ").toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

const PAGE_SIZE = 8;

/** One page of an already-filtered list. `page` is 1-based and clamped. */
function paginatePlans(plans, page, size = PAGE_SIZE) {
  const total = plans.length;
  const pages = Math.max(1, Math.ceil(total / size) || 1);
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  const start = (current - 1) * size;
  return {
    items: plans.slice(start, start + size),
    page: current,
    pages,
    total,
    from: total ? start + 1 : 0,
    to: Math.min(start + size, total),
  };
}

/**
 * Split by optional frontmatter `group:`.
 * If no plan sets a group, the list stays a single untitled section.
 */
function groupSections(plans) {
  if (!plans.some((p) => p.group)) return [{ title: "", plans }];
  const order = [];
  const map = new Map();
  for (const p of plans) {
    const g = p.group || "";
    if (!map.has(g)) {
      map.set(g, []);
      order.push(g);
    }
    map.get(g).push(p);
  }
  return order.map((title) => ({ title, plans: map.get(title) }));
}

module.exports = {
  PLAN_DIR_REL,
  HOME_PLAN_LIMIT,
  planDirs,
  homePlansDir,
  planId,
  fallbackName,
  buildPrompt,
  parsePlanSource,
  collectPlans,
  collectHomePlans,
  listSidebarPlans,
  homeDirOverlapsWorkspace,
  samePath,
  uniquePlanPath,
  savePlanToWorkspace,
  isUnderDir,
  progressOf,
  filterPlans,
  searchPlans,
  PAGE_SIZE,
  paginatePlans,
  groupSections,
};
