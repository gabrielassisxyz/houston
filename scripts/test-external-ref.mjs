// external_ref, the reference a bead keeps to an item of another tracker. Pure: lib/*.ts load
// without a build, and the bd store runs against a stubbed command runner, so no bd is needed
// and no command is run. The br store is covered against a real tracker by
// scripts/test-br-store.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);

/**
 * A loader with its own module cache. The stubs apply to nested loads too, and the cache is
 * never shared between sets of stubs: a `./bd` reached through another module must not be the
 * one the bd cases get, which has a stubbed command runner.
 */
function loader(stubs = {}) {
  const all = { 'server-only': {}, ...stubs };
  const cache = new Map();
  const load = (name) => {
    if (cache.has(name)) return cache.get(name);
    const exports = {};
    cache.set(name, exports);
    const source = fs.readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8');
    const code = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const wrapper = vm.runInThisContext(`(function (exports, require) {\n${code}\n})`, { filename: `lib/${name}.ts` });
    wrapper(exports, (id) => {
      if (Object.hasOwn(all, id)) return all[id];
      return id.startsWith('./') ? load(id.slice(2)) : require(id);
    });
    return exports;
  };
  return load;
}

/** A bd store whose commands are recorded and answered by `answer(args)` instead of being run. */
function stubbedBd(answer) {
  const calls = [];
  const execFile = () => assert.fail('the bd store runs commands through the promisified execFile');
  execFile[promisify.custom] = async (_bin, args) => {
    calls.push([...args]);
    return { stdout: answer(args) };
  };
  const { createBdStore } = loader({ 'node:child_process': { execFile } })('bd');
  return { calls, store: createBdStore('/nonexistent') };
}

const minimal = { id: 'bd-1', title: 't', status: 'open', issue_type: 'task' };

// ---------------------------------------------------------------- the bead as read
{
  const { beadSchema } = loader()('schema');
  const absent = beadSchema.parse(minimal);
  assert.equal(Object.hasOwn(absent, 'external_ref'), false, 'a bead without a reference gets no key');
  assert.equal(beadSchema.parse({ ...minimal, external_ref: null }).external_ref, null, 'null is a valid bead');
  assert.equal(beadSchema.parse({ ...minimal, external_ref: 'STRY00000001' }).external_ref, 'STRY00000001', 'the reference is kept');
}

// ---------------------------------------------------------------- bd: both read paths
{
  const rows = [
    { ...minimal, id: 'bd-ref', external_ref: 'STRY00000001' },
    { ...minimal, id: 'bd-null', external_ref: null },
    { ...minimal, id: 'bd-none' },
  ];
  const { store } = stubbedBd((args) => {
    if (args[0] === 'export') return rows.map((r) => JSON.stringify(r)).join('\n');
    return JSON.stringify({ schema_version: 1, data: [rows.find((r) => r.id === args[1])] });
  });
  const listed = await store.list();
  assert.deepEqual(
    listed.map((b) => [b.id, b.external_ref]),
    [['bd-ref', 'STRY00000001'], ['bd-null', null], ['bd-none', undefined]],
    'list carries the reference and skips no bead over it',
  );
  assert.equal((await store.get('bd-ref')).external_ref, 'STRY00000001', 'get carries the reference');
  assert.equal((await store.get('bd-null'))?.external_ref, null, 'get answers a bead whose reference is null');
}

console.log('PASS external_ref: schema and bd reads');
