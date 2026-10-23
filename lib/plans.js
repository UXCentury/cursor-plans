const fs = require("fs");
const path = require("path");

const PLAN_DIR_REL = [".cursor/plans", "docs/plans"];

function planDirs(root) {
  return PLAN_DIR_REL.map((rel) => path.join(root, ...rel.split("/")));
}

function planId(filename) {
  return (filename.match(/^(\d{2})-/) || [])[1] || "";
}

function posixRel(root, abs) {
  return path.relative(root, abs).split(path.sep).join("/");
}

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
  groupSections,
};
