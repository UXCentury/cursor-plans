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
  buildPrompt,
  planId,
  collectPlans,
  groupSections,
  progressOf,
  filterPlans,
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

test("collectPlans keeps numbered files and the real @ path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-plans-"));
  fs.mkdirSync(path.join(root, ".cursor", "plans"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs", "plans"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cursor", "plans", "01-demo.plan.md"), SAMPLE);
  fs.writeFileSync(path.join(root, ".cursor", "plans", "notes.plan.md"), SAMPLE);
  fs.writeFileSync(path.join(root, "docs", "plans", "09-later.plan.md"), SAMPLE);

  const plans = collectPlans([{ root, index: 0 }]);
  fs.rmSync(root, { recursive: true, force: true });

  assert.equal(plans.some((p) => p.rel.endsWith("notes.plan.md")), false);
  assert.deepEqual(plans.map((p) => p.id), ["01", "09"]);
  assert.equal(plans[0].rel, ".cursor/plans/01-demo.plan.md");
  assert.match(plans[0].prompt, /@\.cursor\/plans\/01-demo\.plan\.md/);
  assert.equal(plans[1].rel, "docs/plans/09-later.plan.md");
  assert.match(plans[1].prompt, /@docs\/plans\/09-later\.plan\.md/);
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
