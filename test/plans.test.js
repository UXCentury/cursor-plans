/**
 * Parser and list-filter checks. These cover the rules the sidebar depends on
 * without launching VS Code.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  parsePlanSource,
  fallbackName,
  buildPrompt,
  planId,
  collectPlans,
  collectHomePlans,
  listSidebarPlans,
  homeDirOverlapsWorkspace,
  isUnderDir,
  uniquePlanPath,
  savePlanToWorkspace,
  groupSections,
  progressOf,
  filterPlans,
  searchPlans,
  paginatePlans,
} = require("../lib/plans");

const SAMPLE = `---
name: Activity bar list
overview: "Show workspace plan files in the sidebar."
group: Later
todos:
  - id: copy-path
    content: "Copy prompt uses the real path"
    status: completed
  - id: watch
    content: "Refresh on file change"
    status: pending
isProject: false
---

# Activity bar list
`;

test("planId reads the two-digit prefix and ignores other names", () => {
  assert.equal(planId("01-demo.plan.md"), "01");
  assert.equal(planId("demo.plan.md"), "");
  assert.equal(planId("access_admin_ux_ba62ee78.plan.md"), "");
});

test("fallbackName strips Cursor's trailing hash", () => {
  assert.equal(fallbackName("access_admin_ux_ba62ee78.plan.md"), "access admin ux");
  assert.equal(fallbackName("03-ship-checkout.plan.md"), "ship checkout");
});

test("buildPrompt uses the real relative path", () => {
  const prompt = buildPrompt(".cursor/plans/01-demo.plan.md");
  assert.match(prompt, /@\.cursor\/plans\/01-demo\.plan\.md/);
  assert.doesNotMatch(prompt, /@docs\/plans\//);
});

test("parsePlanSource reads name, overview, group, and todos", () => {
  const plan = parsePlanSource(SAMPLE, "01-demo.plan.md");
  assert.equal(plan.name, "Activity bar list");
  assert.equal(plan.overview, "Show workspace plan files in the sidebar.");
  assert.equal(plan.group, "Later");
  assert.equal(plan.todos.length, 2);
  assert.equal(plan.todos[0].status, "completed");
  assert.equal(plan.todos[1].content, "Refresh on file change");
});

test("parsePlanSource falls back to the filename when frontmatter is missing", () => {
  const plan = parsePlanSource("# just markdown\n", "03-ship-checkout.plan.md");
  assert.equal(plan.name, "ship checkout");
  assert.equal(plan.group, "");
  assert.equal(plan.todos.length, 0);
});

test("collectPlans lists numbered and Cursor-native names with the real @ path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-plans-"));
  fs.mkdirSync(path.join(root, ".cursor", "plans"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs", "plans"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cursor", "plans", "01-demo.plan.md"), SAMPLE);
  fs.writeFileSync(path.join(root, ".cursor", "plans", "notes.plan.md"), SAMPLE);
  fs.writeFileSync(path.join(root, "docs", "plans", "09-later.plan.md"), SAMPLE);

  const plans = collectPlans([{ root, index: 0 }]);
  fs.rmSync(root, { recursive: true, force: true });

  assert.equal(plans.some((p) => p.rel.endsWith("notes.plan.md")), true);
  assert.deepEqual(plans.map((p) => p.id), ["01", "09", ""]);
  assert.equal(plans[0].rel, ".cursor/plans/01-demo.plan.md");
  assert.match(plans[0].prompt, /@\.cursor\/plans\/01-demo\.plan\.md/);
  assert.equal(plans[1].rel, "docs/plans/09-later.plan.md");
  assert.equal(plans[0].source, "workspace");
});

test("collectHomePlans skips workspace names, newest first, and caps the list", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-home-plans-"));
  const files = [
    ["keep_new_aaaaaaaa.plan.md", 300],
    ["keep_old_bbbbbbbb.plan.md", 100],
    ["skip_me_cccccccc.plan.md", 400],
    ["mid_dddddddd.plan.md", 200],
  ];
  for (const [name, mtime] of files) {
    const abs = path.join(home, name);
    fs.writeFileSync(abs, SAMPLE);
    fs.utimesSync(abs, mtime, mtime);
  }

  const result = collectHomePlans(home, new Set(["skip_me_cccccccc.plan.md"]), 2);
  fs.rmSync(home, { recursive: true, force: true });

  assert.equal(result.total, 3);
  assert.equal(result.omitted, 1);
  assert.deepEqual(result.plans.map((p) => p.rel), [
    "keep_new_aaaaaaaa.plan.md",
    "mid_dddddddd.plan.md",
  ]);
  assert.equal(result.plans[0].source, "home");
  assert.equal(result.plans[0].prompt, "");

  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-home-plans-"));
  fs.writeFileSync(path.join(home2, "a_aaaaaaaa.plan.md"), SAMPLE);
  fs.writeFileSync(path.join(home2, "b_bbbbbbbb.plan.md"), SAMPLE);
  const all = collectHomePlans(home2, [], 0);
  fs.rmSync(home2, { recursive: true, force: true });
  assert.equal(all.plans.length, 2);
  assert.equal(all.omitted, 0);
});

test("listSidebarPlans adds home-folder plans and skips names already in the workspace", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-side-ws-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-side-home-"));
  fs.mkdirSync(path.join(root, ".cursor", "plans"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cursor", "plans", "01-demo.plan.md"), SAMPLE);
  fs.writeFileSync(path.join(home, "01-demo.plan.md"), SAMPLE);
  fs.writeFileSync(path.join(home, "from_home_aaaaaaaa.plan.md"), SAMPLE);

  const plans = listSidebarPlans([{ root, index: 0 }], home);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });

  assert.deepEqual(
    plans.map((p) => p.source + ":" + path.basename(p.abs)),
    ["workspace:01-demo.plan.md", "home:from_home_aaaaaaaa.plan.md"],
  );
  assert.match(plans[1].prompt, /from_home_aaaaaaaa\.plan\.md/);
});

test("homeDirOverlapsWorkspace detects ~/.cursor/plans inside the project", () => {
  assert.equal(
    homeDirOverlapsWorkspace("/tmp/proj/.cursor/plans", [{ root: "/tmp/proj" }]),
    true,
  );
  assert.equal(
    homeDirOverlapsWorkspace("/home/user/.cursor/plans", [{ root: "/tmp/proj" }]),
    false,
  );
});

test("isUnderDir matches a Windows path when only the drive letter case differs", () => {
  const win = path.win32;
  const dir = "C:\\Users\\me\\.cursor\\plans";
  assert.equal(isUnderDir("c:\\Users\\me\\.cursor\\plans\\demo.plan.md", dir, win), true);
  assert.equal(isUnderDir("c:\\Users\\me\\.cursor\\plans", dir, win), true);
  assert.equal(isUnderDir("c:\\Users\\me\\.cursor\\plans-extra\\demo.plan.md", dir, win), false);
  assert.equal(isUnderDir("D:\\Users\\me\\.cursor\\plans\\demo.plan.md", dir, win), false);
  assert.equal(
    homeDirOverlapsWorkspace("c:\\proj\\.cursor\\plans", [{ root: "C:\\proj" }], win),
    true,
  );
  assert.equal(
    homeDirOverlapsWorkspace("c:\\Users\\me\\.cursor\\plans", [{ root: "C:\\proj" }], win),
    false,
  );
});

test("uniquePlanPath adds a suffix when the destination exists", () => {
  const dir = "/tmp/plans";
  const exists = (p) => p === path.join(dir, "demo.plan.md") || p === path.join(dir, "demo-2.plan.md");
  assert.equal(uniquePlanPath(dir, "other.plan.md", exists), path.join(dir, "other.plan.md"));
  assert.equal(uniquePlanPath(dir, "demo.plan.md", exists), path.join(dir, "demo-3.plan.md"));
});

test("savePlanToWorkspace moves the file into .cursor/plans", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-save-home-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-save-ws-"));
  const src = path.join(home, "from_home_deadbeef.plan.md");
  fs.writeFileSync(src, SAMPLE);

  const dest = savePlanToWorkspace(src, root);
  const expected = path.join(root, ".cursor", "plans", "from_home_deadbeef.plan.md");

  assert.equal(dest, expected);
  assert.equal(fs.existsSync(src), false);
  assert.equal(fs.existsSync(expected), true);

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test("savePlanToWorkspace keeps the copy when the original cannot be renamed or deleted", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-save-locked-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-save-locked-ws-"));
  const src = path.join(home, "locked_deadbeef.plan.md");
  fs.writeFileSync(src, SAMPLE);
  const io = {
    exists: fs.existsSync,
    mkdir: (dir) => fs.mkdirSync(dir, { recursive: true }),
    rename: () => {
      throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
    },
    copyFile: fs.copyFileSync,
    unlink: () => {
      throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
    },
  };

  const dest = savePlanToWorkspace(src, root, io);

  assert.equal(dest, path.join(root, ".cursor", "plans", "locked_deadbeef.plan.md"));
  assert.equal(fs.existsSync(dest), true);
  assert.equal(fs.existsSync(src), true);

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test("groupSections stays flat until a plan sets group", () => {
  const flat = groupSections([
    { id: "01", group: "", name: "A" },
    { id: "02", group: "", name: "B" },
  ]);
  assert.equal(flat.length, 1);
  assert.equal(flat[0].title, "");
  assert.equal(flat[0].plans.length, 2);

  const grouped = groupSections([
    { id: "01", group: "", name: "A" },
    { id: "09", group: "Later", name: "B" },
  ]);
  assert.deepEqual(grouped.map((s) => s.title), ["", "Later"]);
});

test("progressOf maps todos to new, in progress, and done", () => {
  assert.equal(progressOf({ todos: [] }), "new");
  assert.equal(progressOf({ todos: [{ status: "pending" }] }), "new");
  assert.equal(progressOf({ todos: [{ status: "in_progress" }] }), "in_progress");
  assert.equal(progressOf({
    todos: [{ status: "completed" }, { status: "pending" }],
  }), "in_progress");
  assert.equal(progressOf({ todos: [{ status: "completed" }, { status: "completed" }] }), "done");
});

test("filterPlans keeps matching status and all", () => {
  const plans = [
    { id: "01", todos: [{ status: "pending" }] },
    { id: "02", todos: [{ status: "completed" }, { status: "pending" }] },
    { id: "03", todos: [{ status: "completed" }] },
  ];
  assert.deepEqual(filterPlans(plans, "new").map((p) => p.id), ["01"]);
  assert.deepEqual(filterPlans(plans, "in_progress").map((p) => p.id), ["02"]);
  assert.deepEqual(filterPlans(plans, "done").map((p) => p.id), ["03"]);
  assert.equal(filterPlans(plans, "all").length, 3);
});

test("searchPlans matches every term across name, overview, and path", () => {
  const plans = [
    { id: "01", name: "Casework", overview: "Alerts and queue", group: "", rel: "ris_06.plan.md" },
    { id: "02", name: "Money views", overview: "ClickHouse ledger", group: "Later", rel: "ris_07.plan.md" },
  ];
  assert.deepEqual(searchPlans(plans, "case").map((p) => p.id), ["01"]);
  assert.deepEqual(searchPlans(plans, "click house").map((p) => p.id), ["02"]);
  assert.equal(searchPlans(plans, "ris").length, 2);
  assert.equal(searchPlans(plans, "nope").length, 0);
  assert.equal(searchPlans(plans, "  ").length, 2);
});

test("paginatePlans returns one page and clamps the page number", () => {
  const plans = Array.from({ length: 20 }, (_, i) => ({ id: String(i + 1) }));
  const first = paginatePlans(plans, 1, 8);
  assert.equal(first.items.length, 8);
  assert.equal(first.page, 1);
  assert.equal(first.pages, 3);
  assert.equal(first.from, 1);
  assert.equal(first.to, 8);
  assert.equal(paginatePlans(plans, 3, 8).items.length, 4);
  assert.equal(paginatePlans(plans, 99, 8).page, 3);
  assert.equal(paginatePlans([], 1, 8).total, 0);
});
