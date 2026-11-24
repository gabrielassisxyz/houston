// Pure unit tests for lib/merged-list.ts without a build or server.
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
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const wrapper = vm.runInThisContext(`(function (exports, require) {\n${code}\n})`, {
    filename: `lib/${name}.ts`,
  });
  wrapper(exports, (id) => (id.startsWith("./") ? load(id.slice(2)) : require(id)));
  return exports;
}

const { putBead, takeBead, setBeadStatus } = load("merged-list");
const { namespaceBead } = load("aggregate");
const { makeIndex, parentOf, childrenCountMap, isBlocked } = load("beads-view");

function makeBead(id, overrides = {}) {
  return {
    id,
    title: `Bead ${id}`,
    description: "",
    notes: "",
    design: "",
    acceptance_criteria: "",
    status: "open",
    priority: 2,
    issue_type: "task",
    assignee: "",
    created_by: "",
    labels: [],
    dependencies: [],
    comments: [],
    ...overrides,
  };
}

function makeResponse(projects) {
  const beads = [];
  const summaries = [];
  for (const p of projects) {
    const ref = { id: p.id, name: p.name };
    summaries.push({ id: p.id, name: p.name, kind: p.kind ?? "br", count: p.beads.length });
    for (const b of p.beads) beads.push(namespaceBead(ref, b));
  }
  return {
    beads,
    meta: {
      kind: "all",
      readOnly: true,
      humanActor: "tester",
      humanAllowlist: [],
      pollIntervalMs: 5000,
      projects: summaries,
      failed: [],
    },
  };
}

function countOf(data, projectId) {
  return data.meta.projects.find((p) => p.id === projectId)?.count;
}

// 1. Twin ids across two projects: beta operations must never disturb alpha.
{
  const data = makeResponse([
    { id: "alpha", name: "Alpha", beads: [makeBead("ab-1", { title: "Alpha one" })] },
    { id: "beta", name: "Beta", beads: [makeBead("ab-1", { title: "Beta one" })] },
  ]);
  const alphaOriginal = data.beads[0];

  // putBead on beta's ab-1
  const snapshotPut = structuredClone(data);
  const betaReplacement = makeBead("ab-1", { title: "Beta edited" });
  const beadSnapshot = structuredClone(betaReplacement);
  const afterPut = putBead(data, "beta", betaReplacement);
  assert.notEqual(afterPut, data);
  assert.equal(afterPut.beads[0], alphaOriginal, "putBead must keep alpha bead reference");
  assert.equal(afterPut.beads[0].id, "alpha:ab-1");
  assert.equal(afterPut.beads[1].id, "beta:ab-1");
  assert.equal(afterPut.beads[1].title, "Beta edited");
  assert.equal(countOf(afterPut, "alpha"), 1);
  assert.equal(countOf(afterPut, "beta"), 1);
  assert.deepEqual(data, snapshotPut, "putBead must not mutate input response");
  assert.deepEqual(betaReplacement, beadSnapshot, "putBead must not mutate input bead");

  // setBeadStatus on beta's ab-1
  const snapshotStatus = structuredClone(data);
  const afterStatus = setBeadStatus(data, "beta", "ab-1", "in_progress");
  assert.notEqual(afterStatus, data);
  assert.equal(afterStatus.beads[0], alphaOriginal, "setBeadStatus must keep alpha bead reference");
  assert.equal(afterStatus.beads[0].status, "open");
  assert.equal(afterStatus.beads[1].status, "in_progress");
  assert.equal(countOf(afterStatus, "alpha"), 1);
  assert.equal(countOf(afterStatus, "beta"), 1);
  assert.deepEqual(data, snapshotStatus, "setBeadStatus must not mutate input response");

  // takeBead on beta's ab-1
  const snapshotTake = structuredClone(data);
  const afterTake = takeBead(data, "beta", "ab-1");
  assert.notEqual(afterTake, data);
  assert.equal(afterTake.beads.length, 1);
  assert.equal(afterTake.beads[0], alphaOriginal, "takeBead must keep alpha bead reference");
  assert.equal(countOf(afterTake, "alpha"), 1);
  assert.equal(countOf(afterTake, "beta"), 0);
  assert.deepEqual(data, snapshotTake, "takeBead must not mutate input response");
}

// 2. putBead replacing an existing bead keeps its index, list length, counts, and untouched refs.
{
  const data = makeResponse([
    { id: "alpha", name: "Alpha", beads: [makeBead("a-1"), makeBead("a-2")] },
    { id: "beta", name: "Beta", beads: [makeBead("b-1")] },
  ]);
  const snapshot = structuredClone(data);
  const updated = makeBead("a-1", { title: "Updated a-1", priority: 0 });
  const next = putBead(data, "alpha", updated);

  assert.notEqual(next, data);
  assert.equal(next.beads.length, 3);
  assert.equal(next.beads[0].id, "alpha:a-1");
  assert.equal(next.beads[0].title, "Updated a-1");
  assert.equal(next.beads[0].priority, 0);
  assert.deepEqual(next.beads[0].project, data.beads[0].project);
  assert.equal(next.beads[0].local_id, "a-1");
  assert.equal(next.beads[1], data.beads[1]);
  assert.equal(next.beads[2], data.beads[2]);
  assert.equal(countOf(next, "alpha"), 2);
  assert.equal(countOf(next, "beta"), 1);
  assert.deepEqual(data, snapshot);
}

// 3. putBead of a new bead for a project with beads inserts right after that project's last bead.
{
  const data = makeResponse([
    { id: "alpha", name: "Alpha", beads: [makeBead("a-1"), makeBead("a-2")] },
    { id: "beta", name: "Beta", beads: [makeBead("b-1")] },
    { id: "gamma", name: "Gamma", beads: [makeBead("g-1")] },
  ]);
  const snapshot = structuredClone(data);
  const inserted = makeBead("a-3", { title: "Third alpha" });
  const beadSnapshot = structuredClone(inserted);
  const next = putBead(data, "alpha", inserted);

  assert.notEqual(next, data);
  assert.deepEqual(
    next.beads.map((b) => b.id),
    ["alpha:a-1", "alpha:a-2", "alpha:a-3", "beta:b-1", "gamma:g-1"],
  );
  // The card's project chip and every write made from the card read these two fields.
  assert.deepEqual(next.beads[2].project, { id: "alpha", name: "Alpha" });
  assert.equal(next.beads[2].local_id, "a-3");
  assert.equal(next.beads[0], data.beads[0]);
  assert.equal(next.beads[1], data.beads[1]);
  assert.equal(next.beads[3], data.beads[2]);
  assert.equal(next.beads[4], data.beads[3]);
  assert.equal(countOf(next, "alpha"), 3);
  assert.equal(countOf(next, "beta"), 1);
  assert.equal(countOf(next, "gamma"), 1);
  assert.deepEqual(data, snapshot);
  assert.deepEqual(inserted, beadSnapshot);
}

// 4. putBead of a first bead for an empty project: first, middle, and last in meta.projects.
{
  // Empty project first
  const emptyFirst = makeResponse([
    { id: "alpha", name: "Alpha", beads: [] },
    { id: "beta", name: "Beta", beads: [makeBead("b-1")] },
    { id: "gamma", name: "Gamma", beads: [makeBead("g-1")] },
  ]);
  const snapFirst = structuredClone(emptyFirst);
  const resFirst = putBead(emptyFirst, "alpha", makeBead("a-1"));
  assert.deepEqual(
    resFirst.beads.map((b) => b.id),
    ["alpha:a-1", "beta:b-1", "gamma:g-1"],
  );
  assert.equal(resFirst.beads[1], emptyFirst.beads[0]);
  assert.equal(resFirst.beads[2], emptyFirst.beads[1]);
  assert.equal(countOf(resFirst, "alpha"), 1);
  assert.equal(countOf(resFirst, "beta"), 1);
  assert.equal(countOf(resFirst, "gamma"), 1);
  assert.deepEqual(emptyFirst, snapFirst);

  // Empty project in the middle
  const emptyMiddle = makeResponse([
    { id: "alpha", name: "Alpha", beads: [makeBead("a-1"), makeBead("a-2")] },
    { id: "beta", name: "Beta", beads: [] },
    { id: "gamma", name: "Gamma", beads: [makeBead("g-1")] },
  ]);
  const snapMiddle = structuredClone(emptyMiddle);
  const resMiddle = putBead(emptyMiddle, "beta", makeBead("b-1"));
  assert.deepEqual(
    resMiddle.beads.map((b) => b.id),
    ["alpha:a-1", "alpha:a-2", "beta:b-1", "gamma:g-1"],
  );
  assert.equal(resMiddle.beads[0], emptyMiddle.beads[0]);
  assert.equal(resMiddle.beads[1], emptyMiddle.beads[1]);
  assert.equal(resMiddle.beads[3], emptyMiddle.beads[2]);
  assert.equal(countOf(resMiddle, "alpha"), 2);
  assert.equal(countOf(resMiddle, "beta"), 1);
  assert.equal(countOf(resMiddle, "gamma"), 1);
  assert.deepEqual(emptyMiddle, snapMiddle);

  // Empty project last
  const emptyLast = makeResponse([
    { id: "alpha", name: "Alpha", beads: [makeBead("a-1")] },
    { id: "beta", name: "Beta", beads: [makeBead("b-1")] },
    { id: "gamma", name: "Gamma", beads: [] },
  ]);
  const snapLast = structuredClone(emptyLast);
  const resLast = putBead(emptyLast, "gamma", makeBead("g-1"));
  assert.deepEqual(
    resLast.beads.map((b) => b.id),
    ["alpha:a-1", "beta:b-1", "gamma:g-1"],
  );
  assert.equal(resLast.beads[0], emptyLast.beads[0]);
  assert.equal(resLast.beads[1], emptyLast.beads[1]);
  assert.equal(countOf(resLast, "alpha"), 1);
  assert.equal(countOf(resLast, "beta"), 1);
  assert.equal(countOf(resLast, "gamma"), 1);
  assert.deepEqual(emptyLast, snapLast);

  // Two adjacent empty projects: skips the next empty one and inserts before the nearest non-empty later project
  const twoEmpty = makeResponse([
    { id: "alpha", name: "Alpha", beads: [] },
    { id: "beta", name: "Beta", beads: [] },
    { id: "gamma", name: "Gamma", beads: [makeBead("g-1")] },
  ]);
  const resTwoEmpty = putBead(twoEmpty, "alpha", makeBead("a-1"));
  assert.deepEqual(
    resTwoEmpty.beads.map((b) => b.id),
    ["alpha:a-1", "gamma:g-1"],
  );
  assert.equal(countOf(resTwoEmpty, "alpha"), 1);
  assert.equal(countOf(resTwoEmpty, "beta"), 0);
  assert.equal(countOf(resTwoEmpty, "gamma"), 1);
}

// 5. putBead twice with the same new bead raises count only once.
{
  const data = makeResponse([
    { id: "alpha", name: "Alpha", beads: [makeBead("a-1")] },
    { id: "beta", name: "Beta", beads: [makeBead("b-1")] },
  ]);
  const first = putBead(data, "alpha", makeBead("a-2", { title: "First write" }));
  const second = putBead(first, "alpha", makeBead("a-2", { title: "Second write" }));

  assert.equal(countOf(first, "alpha"), 2);
  assert.equal(countOf(second, "alpha"), 2);
  assert.deepEqual(
    second.beads.map((b) => b.id),
    ["alpha:a-1", "alpha:a-2", "beta:b-1"],
  );
  assert.equal(second.beads[1].title, "Second write");
  assert.equal(second.beads[0], first.beads[0]);
  assert.equal(second.beads[2], first.beads[2]);
}

// 6. takeBead lowers count once; taking a missing bead returns the exact input and keeps count.
{
  const data = makeResponse([
    { id: "alpha", name: "Alpha", beads: [makeBead("a-1"), makeBead("a-2")] },
    { id: "beta", name: "Beta", beads: [makeBead("b-1")] },
  ]);
  const afterFirst = takeBead(data, "alpha", "a-1");
  assert.notEqual(afterFirst, data);
  assert.deepEqual(
    afterFirst.beads.map((b) => b.id),
    ["alpha:a-2", "beta:b-1"],
  );
  assert.equal(afterFirst.beads[0], data.beads[1]);
  assert.equal(afterFirst.beads[1], data.beads[2]);
  assert.equal(countOf(afterFirst, "alpha"), 1);
  assert.equal(countOf(afterFirst, "beta"), 1);

  const snapshotBeforeSecond = structuredClone(afterFirst);
  const afterSecond = takeBead(afterFirst, "alpha", "a-1");
  assert.equal(afterSecond, afterFirst, "second takeBead must return the exact input object");
  assert.equal(countOf(afterSecond, "alpha"), 1, "missing takeBead must not lower count");
  assert.deepEqual(afterFirst, snapshotBeforeSecond);
}

// 7. setBeadStatus changes only status; every other field is deep-equal; no-ops return exact input.
{
  const data = makeResponse([
    { id: "alpha", name: "Alpha", beads: [makeBead("ep-1", { issue_type: "epic" })] },
    {
      id: "beta",
      name: "Beta",
      beads: [
        makeBead("b-1", {
          title: "Rich bead",
          description: "Details",
          notes: "Note",
          design: "Design",
          acceptance_criteria: "AC",
          status: "open",
          priority: 1,
          issue_type: "feature",
          assignee: "alice",
          labels: ["ui", "urgent"],
          parent: "ep-9",
          dependencies: [{ issue_id: "b-1", depends_on_id: "ep-9", type: "parent-child" }],
          comments: [{ id: "c-1", author: "alice", text: "hi" }],
          await_type: "human",
        }),
      ],
    },
  ]);
  const originalBead = data.beads[1];
  const snapshot = structuredClone(data);
  const next = setBeadStatus(data, "beta", "b-1", "closed");

  assert.notEqual(next, data);
  assert.equal(next.beads[0], data.beads[0]);
  assert.notEqual(next.beads[1], originalBead);
  assert.equal(next.beads[1].status, "closed");
  assert.deepEqual(
    { ...next.beads[1], status: originalBead.status },
    originalBead,
    "setBeadStatus must change only status",
  );
  assert.equal(countOf(next, "alpha"), 1);
  assert.equal(countOf(next, "beta"), 1);
  assert.deepEqual(data, snapshot);

  // Missing bead returns exact input
  assert.equal(setBeadStatus(data, "beta", "does-not-exist", "closed"), data);
  // Same status returns exact input
  assert.equal(setBeadStatus(data, "beta", "b-1", "open"), data);
}

// 8. Unknown project id and undefined data return their input unchanged.
{
  const data = makeResponse([
    { id: "alpha", name: "Alpha", beads: [makeBead("a-1")] },
  ]);
  const snapshot = structuredClone(data);
  const stray = makeBead("x-1");
  const straySnap = structuredClone(stray);

  assert.equal(putBead(undefined, "alpha", stray), undefined);
  assert.equal(takeBead(undefined, "alpha", "a-1"), undefined);
  assert.equal(setBeadStatus(undefined, "alpha", "a-1", "closed"), undefined);

  assert.equal(putBead(data, "unknown", stray), data);
  assert.equal(takeBead(data, "unknown", "a-1"), data);
  assert.equal(setBeadStatus(data, "unknown", "a-1", "closed"), data);
  assert.deepEqual(data, snapshot);
  assert.deepEqual(stray, straySnap);
}

// 9. br show shape (flat deps without issue_id + parent set) matches list-row view results
//    and has namespaced dependencies[].depends_on_id and parent.
{
  const data = makeResponse([
    {
      id: "alpha",
      name: "Alpha",
      beads: [
        makeBead("ep-1", { issue_type: "epic", status: "open" }),
        makeBead("bk-1", { issue_type: "task", status: "open" }),
        makeBead("tk-1", {
          issue_type: "task",
          status: "open",
          dependencies: [
            {
              issue_id: "tk-1",
              depends_on_id: "ep-1",
              type: "parent-child",
              created_by: "alice",
              created_at: "2026-01-01T00:00:00Z",
            },
            {
              issue_id: "tk-1",
              depends_on_id: "bk-1",
              type: "blocks",
              created_by: "alice",
              created_at: "2026-01-01T00:00:00Z",
            },
          ],
        }),
      ],
    },
    {
      id: "beta",
      name: "Beta",
      beads: [
        makeBead("ep-1", { issue_type: "epic", status: "open" }),
        makeBead("bk-1", { issue_type: "task", status: "closed" }),
        makeBead("tk-1", {
          issue_type: "task",
          status: "open",
          dependencies: [
            { issue_id: "tk-1", depends_on_id: "ep-1", type: "parent-child" },
            { issue_id: "tk-1", depends_on_id: "bk-1", type: "blocks" },
          ],
        }),
      ],
    },
  ]);

  const beforeIndex = makeIndex(data.beads);
  const beforeParents = new Map(data.beads.map((b) => [b.id, parentOf(b, beforeIndex)?.id ?? null]));
  const beforeBlocked = new Map(data.beads.map((b) => [b.id, isBlocked(b, beforeIndex)]));
  const beforeChildren = childrenCountMap(data.beads);

  // Sanity-check baseline relationships so an all-false/all-null bug cannot pass.
  assert.equal(beforeParents.get("alpha:tk-1"), "alpha:ep-1");
  assert.equal(beforeBlocked.get("alpha:tk-1"), true);
  assert.equal(beforeBlocked.get("beta:tk-1"), false);
  assert.equal(beforeChildren.get("alpha:ep-1"), 1);

  // Write response shaped as `br show` parsed by beadSchema: no issue_id on deps, parent set.
  const writeReply = makeBead("tk-1", {
    title: "Edited task",
    issue_type: "task",
    status: "open",
    parent: "ep-1",
    dependencies: [
      { depends_on_id: "ep-1", type: "parent-child" },
      { depends_on_id: "bk-1", type: "blocks" },
    ],
  });
  const after = putBead(data, "alpha", writeReply);
  const replaced = after.beads.find((b) => b.id === "alpha:tk-1");
  assert.ok(replaced);
  assert.equal(replaced.parent, "alpha:ep-1", "parent must be namespaced");
  assert.deepEqual(
    replaced.dependencies.map((d) => d.depends_on_id),
    ["alpha:ep-1", "alpha:bk-1"],
    "dependencies[].depends_on_id must be namespaced",
  );

  const afterIndex = makeIndex(after.beads);
  const afterParents = new Map(after.beads.map((b) => [b.id, parentOf(b, afterIndex)?.id ?? null]));
  const afterBlocked = new Map(after.beads.map((b) => [b.id, isBlocked(b, afterIndex)]));
  const afterChildren = childrenCountMap(after.beads);

  assert.deepEqual(afterParents, beforeParents);
  assert.deepEqual(afterBlocked, beforeBlocked);
  assert.deepEqual(afterChildren, beforeChildren);

  // Closing alpha:bk-1 must unblock alpha:tk-1, proving the blocking edge targets alpha:bk-1.
  const unblocked = setBeadStatus(after, "alpha", "bk-1", "closed");
  const unblockedIndex = makeIndex(unblocked.beads);
  assert.equal(isBlocked(unblockedIndex.get("alpha:tk-1"), unblockedIndex), false);
}

// 10. Import boundary: lib/merged-list.ts imports only from ./aggregate and ./schema.
{
  const src = readFileSync(new URL("../lib/merged-list.ts", import.meta.url), "utf8");
  const specifiers = [...src.matchAll(/^\s*import\b[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.ok(specifiers.length > 0, "expected at least one import");
  for (const spec of specifiers) {
    assert.ok(
      spec === "./aggregate" || spec === "./schema",
      `unexpected import in lib/merged-list.ts: ${spec}`,
    );
  }
}

console.log(
  "PASS: merged-list putBead/takeBead/setBeadStatus isolation, counts, ordering, immutability, no-op identity, and view compatibility",
);
