const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  planFileName,
  buildBundle,
  stringifyBundle,
  parseBundle,
  importBundle,
} = require("../lib/cplan");

const SAMPLE = `---
name: Demo
overview: "A plan"
todos: []
---

# Demo
`;

test("planFileName allows only a .plan.md basename", () => {
  assert.equal(planFileName("01-demo.plan.md"), "01-demo.plan.md");
  assert.equal(planFileName(".cursor/plans/01-demo.plan.md"), "");
  assert.equal(planFileName("../secret.plan.md"), "");
  assert.equal(planFileName("/tmp/x.plan.md"), "");
  assert.equal(planFileName("notes.md"), "");
});

test("buildBundle and parseBundle round-trip", () => {
  const bundle = buildBundle(
    [{ file: "01-demo.plan.md", content: SAMPLE }],
    "2026-10-24T00:00:00.000Z",
  );
  const parsed = parseBundle(stringifyBundle(bundle));
  assert.equal(parsed.cplan, 1);
  assert.equal(parsed.plans.length, 1);
  assert.equal(parsed.plans[0].file, "01-demo.plan.md");
  assert.equal(parsed.plans[0].content, SAMPLE);
});

test("parseBundle rejects the wrong shape", () => {
  assert.throws(() => parseBundle("not json"), /Not a valid/);
  assert.throws(() => parseBundle("{}"), /Not a Cursor Plans/);
  assert.throws(() => parseBundle('{"cplan":1,"plans":[]}'), /no plans/);
});

test("importBundle renames when the destination exists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cplan-import-"));
  const destDir = path.join(root, ".cursor", "plans");
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, "01-demo.plan.md"), "old\n");
  const bundle = buildBundle([{ file: "01-demo.plan.md", content: SAMPLE }]);
  const result = importBundle(bundle, destDir, "rename");
  assert.deepEqual(result.written, ["01-demo-2.plan.md"]);
  assert.equal(fs.readFileSync(path.join(destDir, "01-demo.plan.md"), "utf8"), "old\n");
  assert.equal(fs.readFileSync(path.join(destDir, "01-demo-2.plan.md"), "utf8"), SAMPLE);
  fs.rmSync(root, { recursive: true, force: true });
});

test("importBundle can skip or overwrite", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cplan-conflict-"));
  const destDir = path.join(root, ".cursor", "plans");
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, "01-demo.plan.md"), "old\n");
  const bundle = buildBundle([{ file: "01-demo.plan.md", content: SAMPLE }]);

  const skipped = importBundle(bundle, destDir, "skip");
  assert.deepEqual(skipped.skipped, ["01-demo.plan.md"]);
  assert.equal(fs.readFileSync(path.join(destDir, "01-demo.plan.md"), "utf8"), "old\n");

  const over = importBundle(bundle, destDir, "overwrite");
  assert.deepEqual(over.written, ["01-demo.plan.md"]);
  assert.equal(fs.readFileSync(path.join(destDir, "01-demo.plan.md"), "utf8"), SAMPLE);
  fs.rmSync(root, { recursive: true, force: true });
});
