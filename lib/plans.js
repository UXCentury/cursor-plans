/**
 * Plan file parsing and list helpers.
 *
 * Kept free of the VS Code API so Node tests can cover the rules that
 * used to break silently: numbered filenames, real @ paths, grouping,
 * and New / In progress / Done.
 */

const fs = require("fs");
const path = require("path");

/** Search order. `.cursor/plans` is Cursor's native location; `docs/plans` is the fallback. */
const PLAN_DIR_REL = [".cursor/plans", "docs/plans"];

function planDirs(root) {
  return PLAN_DIR_REL.map((rel) => path.join(root, ...rel.split("/")));
}

/** Only `NN-name.plan.md` files are listed. The two-digit prefix is the badge id. */
function planId(filename) {
  return (filename.match(/^(\d{2})-/) || [])[1] || "";
}

function posixRel(root, abs) {
  return path.relative(root, abs).split(path.sep).join("/");
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
  const fallback = filename.replace(/\.plan\.md$/, "").replace(/^\d{2}-/, "").replace(/-/g, " ");
  return {
    name: nameMatch ? nameMatch[1].trim() : fallback,
    overview: stripQuotes(overviewMatch ? overviewMatch[1] : ""),
    group: stripQuotes(groupMatch ? groupMatch[1] : ""),
    todos,
  };
}

/**
 * Scan workspace folders for plan files.
 * `io` is injectable so tests can run without touching the real disk.
 */
function collectPlans(folders, io = {
  exists: fs.existsSync,
  readDir: (dir) => fs.readdirSync(dir),
  readFile: (abs) => fs.readFileSync(abs, "utf8"),
}) {
  const found = new Map();
  for (const folder of folders) {
    const root = folder.root;
    const index = folder.index;
    for (const dir of planDirs(root)) {
      if (!io.exists(dir)) continue;
      for (const name of io.readDir(dir).slice().sort()) {
        if (!name.endsWith(".plan.md")) continue;
        const id = planId(name);
        if (!id) continue;
        const abs = path.join(dir, name);
        const rel = posixRel(root, abs);
        const key = index + ":" + rel;
        if (found.has(key)) continue;
        const parsed = parsePlanSource(io.readFile(abs), name);
        found.set(key, {
          ...parsed,
          id,
          abs,
          rel,
          prompt: buildPrompt(rel),
        });
      }
    }
  }
  return [...found.values()].sort((a, b) => {
    const byId = a.id.localeCompare(b.id);
    return byId || a.rel.localeCompare(b.rel);
  });
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
  planDirs,
  planId,
  buildPrompt,
  parsePlanSource,
  collectPlans,
  progressOf,
  filterPlans,
  groupSections,
};
