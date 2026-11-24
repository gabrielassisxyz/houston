// Pure unit tests for descendantsOf in lib/beads-view.ts, without a build or a server: every bead
// under a parent at any depth, by the parent-child edges.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const moduleCache = new Map();

function load(name) {
  if (moduleCache.has(name)) return moduleCache.get(name);
  const exports = {};
  moduleCache.set(name, exports);
  const source = readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const wrapper = vm.runInThisContext(`(function (exports, require) {\n${code}\n})`, { filename: `lib/${name}.ts` });
  wrapper(exports, (id) => (id.startsWith("./") ? load(id.slice(2)) : require(id)));
  return exports;
}

const { descendantsOf } = load("beads-view");

const bead = (id, parents = [], extra = []) => ({
  id,
  title: id,
  status: "open",
  dependencies: [
    ...parents.map((parent) => ({ issue_id: id, depends_on_id: parent, type: "parent-child" })),
    ...extra.map(([to, type]) => ({ issue_id: id, depends_on_id: to, type })),
  ],
});
const ids = (beads) => beads.map((b) => b.id);

// Direct children only, in the order they are held.
{
  const beads = [bead("e"), bead("a", ["e"]), bead("x"), bead("b", ["e"])];
  assert.deepEqual(ids(descendantsOf("e", beads)), ["a", "b"], "direct children");
  assert.deepEqual(ids(descendantsOf("a", beads)), [], "a bead with nothing under it");
  assert.deepEqual(ids(descendantsOf("gone", beads)), [], "an id no bead has");
}

// Three levels: nearest first, and the parent itself is never part of the answer.
{
  const beads = [bead("c", ["b"]), bead("b", ["a"]), bead("a", ["e"]), bead("e"), bead("d", ["e"])];
  assert.deepEqual(ids(descendantsOf("e", beads)), ["a", "d", "b", "c"], "every depth, nearest first");
  assert.deepEqual(ids(descendantsOf("a", beads)), ["b", "c"], "from the middle of the tree");
}

// Only parent-child edges lead down: a bead that merely blocks or relates is not under the epic.
{
  const beads = [bead("e"), bead("a", ["e"]), bead("blocked", [], [["e", "blocks"]]), bead("near", [], [["a", "related"]])];
  assert.deepEqual(ids(descendantsOf("e", beads)), ["a"], "other edge types are not followed");
}

// A cycle ends the walk instead of running forever, and nothing is returned twice.
{
  const beads = [bead("e", ["b"]), bead("a", ["e"]), bead("b", ["a"])];
  assert.deepEqual(ids(descendantsOf("e", beads)), ["a", "b"], "a loop back to the parent is not followed");
}

// A bead reached by two ways is returned once.
{
  const beads = [bead("e"), bead("a", ["e"]), bead("b", ["e"]), bead("shared", ["a", "b"])];
  assert.deepEqual(ids(descendantsOf("e", beads)), ["a", "b", "shared"], "two parents, one mention");
}

// Ids in the merged form: the same own id in two projects stays in its own tree.
{
  const beads = [
    bead("alpha:e"), bead("alpha:a", ["alpha:e"]), bead("alpha:b", ["alpha:a"]),
    bead("beta:e"), bead("beta:a", ["beta:e"]),
  ];
  assert.deepEqual(ids(descendantsOf("alpha:e", beads)), ["alpha:a", "alpha:b"], "one project's tree");
  assert.deepEqual(ids(descendantsOf("beta:e", beads)), ["beta:a"], "the other project's tree");
}

// The beads returned are the ones passed in, not copies.
{
  const child = bead("a", ["e"]);
  assert.equal(descendantsOf("e", [bead("e"), child])[0], child, "the same objects");
}

console.log("PASS epic descendants: direct children, depth, edge types, a cycle, two parents, merged ids");
