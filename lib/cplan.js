/**
 * `.cplan` bundles: a versioned JSON file of `*.plan.md` contents.
 * Import only ever writes basenames under `.cursor/plans`.
 */

const fs = require("fs");
const path = require("path");
const { uniquePlanPath } = require("./plans");

const CPLAN_VERSION = 1;

function defaultIo() {
  return {
    exists: fs.existsSync,
    mkdir: (dir) => fs.mkdirSync(dir, { recursive: true }),
    writeFile: (abs, content) => fs.writeFileSync(abs, content, "utf8"),
  };
}

/** Basename only, must end in `.plan.md`, no path segments. */
function planFileName(file) {
  const raw = String(file || "").replace(/\\/g, "/");
  if (!raw || raw.includes("..") || raw.includes("/") || /^[a-zA-Z]:/.test(raw)) return "";
  if (!raw.endsWith(".plan.md") || raw === ".plan.md") return "";
  return raw;
}

function buildBundle(entries, exportedAt = new Date().toISOString()) {
  const plans = [];
  const seen = new Set();
  for (const entry of entries || []) {
    const file = planFileName(entry.file || entry.rel || "");
    if (!file || seen.has(file)) continue;
    seen.add(file);
    plans.push({ file, content: String(entry.content ?? "") });
  }
  return { cplan: CPLAN_VERSION, exportedAt, plans };
}

function stringifyBundle(bundle) {
  return JSON.stringify(bundle, null, 2) + "\n";
}

function parseBundle(raw) {
  let data;
  try {
    data = JSON.parse(String(raw || ""));
  } catch {
    throw new Error("Not a valid .cplan file.");
  }
  if (!data || data.cplan !== CPLAN_VERSION || !Array.isArray(data.plans)) {
    throw new Error("Not a Cursor Plans .cplan file.");
  }
  const plans = [];
  const seen = new Set();
  for (const item of data.plans) {
    const file = planFileName(item && item.file);
    if (!file || seen.has(file) || typeof (item && item.content) !== "string") continue;
    seen.add(file);
    plans.push({ file, content: item.content });
  }
  if (!plans.length) throw new Error("This .cplan file has no plans.");
  return { cplan: CPLAN_VERSION, exportedAt: data.exportedAt || "", plans };
}

/**
 * Write bundle plans into destDir.
 * `conflict` is overwrite | skip | rename (default rename).
 */
function importBundle(bundle, destDir, conflict = "rename", io = defaultIo(), onProgress) {
  io.mkdir(destDir);
  const written = [];
  const skipped = [];
  const plans = (bundle && bundle.plans) || [];
  for (let i = 0; i < plans.length; i += 1) {
    const item = plans[i];
    if (onProgress) onProgress({ index: i + 1, total: plans.length, file: item.file });
    let dest = path.join(destDir, item.file);
    if (io.exists(dest)) {
      if (conflict === "skip") {
        skipped.push(item.file);
        continue;
      }
      if (conflict === "rename") dest = uniquePlanPath(destDir, item.file, io.exists);
    }
    io.writeFile(dest, item.content);
    written.push(path.basename(dest));
  }
  return { written, skipped };
}

module.exports = {
  CPLAN_VERSION,
  planFileName,
  buildBundle,
  stringifyBundle,
  parseBundle,
  importBundle,
};
