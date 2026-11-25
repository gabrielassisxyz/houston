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

// ---------------------------------------------------------------- the input schemas
{
  const { createInputSchema, updateInputSchema } = loader()('schema');
  const inputs = [
    ['create', (extra) => createInputSchema.safeParse({ title: 't', ...extra })],
    ['update', (extra) => updateInputSchema.safeParse(extra)],
  ];
  for (const [name, parse] of inputs) {
    const accepted = (value) => {
      const res = parse({ external_ref: value });
      assert.ok(res.success, `${name} accepts ${JSON.stringify(value)}: ${res.error?.message}`);
      return res.data.external_ref;
    };
    const refused = (value) => {
      const res = parse({ external_ref: value });
      assert.equal(res.success, false, `${name} refuses ${JSON.stringify(value)}`);
      assert.deepEqual(res.error.issues.map((i) => i.path.join('.')), ['external_ref'], `${name} blames the reference`);
    };
    assert.equal(accepted('  STRY00000001 \n'), 'STRY00000001', `${name} trims`);
    assert.equal(accepted('x'.repeat(128)), 'x'.repeat(128), `${name} accepts 128 characters`);
    assert.equal(accepted(` ${'x'.repeat(128)} `), 'x'.repeat(128), `${name} counts the length after trimming`);
    refused('x'.repeat(129));
    for (const control of ['\u0000', '\n', '\t', '\u001f', '\u007f']) refused(`STRY${control}00000001`);
    refused('\u0000STRY00000001');
    // Only control characters are refused here; what else a reference may hold is the tracker's call.
    assert.equal(accepted('org/repo-a #~é'), 'org/repo-a #~é', `${name} leaves printable text alone`);
    refused(null);
    assert.equal(accepted(''), '', `${name} keeps an empty string`);
    assert.equal(accepted('   '), '', `${name} reads blanks as empty`);
    const without = parse({});
    assert.ok(without.success, `${name} does not require the field`);
    assert.equal(Object.hasOwn(without.data, 'external_ref'), false, `${name} adds no default`);
  }
}

// ---------------------------------------------------------------- demo store
{
  const load = loader();
  const { createInputSchema, updateInputSchema } = load('schema');
  const { demoStore } = load('demo-store');
  const create = (extra) => demoStore.create(createInputSchema.parse({ title: 'demo', ...extra }), 'actor');
  const update = (id, patch) => demoStore.update(id, updateInputSchema.parse(patch), 'actor');
  // The reference as both read paths answer it, and whether the key is there at all.
  const check = async (id, expected, what) => {
    const paths = [['get', await demoStore.get(id)], ['list', (await demoStore.list()).find((b) => b.id === id)]];
    for (const [where, bead] of paths) {
      assert.equal(bead.external_ref, expected, `demo ${what}: ${where}`);
      assert.equal(Object.hasOwn(bead, 'external_ref'), expected !== undefined, `demo ${what}: ${where} key`);
    }
  };

  const made = await create({ external_ref: 'STRY00000001' });
  assert.equal(made.external_ref, 'STRY00000001', 'demo create answers the reference');
  await check(made.id, 'STRY00000001', 'create');
  await check((await create({})).id, undefined, 'create without a reference');
  await check((await create({ external_ref: '' })).id, undefined, 'create with an empty reference');

  assert.equal((await update(made.id, { external_ref: 'INC00000001' })).external_ref, 'INC00000001', 'demo update answers the reference');
  await check(made.id, 'INC00000001', 'update');
  await update(made.id, { priority: 1 });
  await check(made.id, 'INC00000001', 'update without the field');
  // The key present and undefined is what an assignment of the whole patch would copy over.
  await demoStore.update(made.id, { priority: 0, external_ref: undefined }, 'actor');
  await check(made.id, 'INC00000001', 'update with an undefined field');
  assert.equal((await demoStore.get(made.id)).priority, 0, 'the rest of that patch applied');
  const cleared = await update(made.id, { external_ref: '' });
  assert.equal(Object.hasOwn(cleared, 'external_ref'), false, 'demo clear answers a bead without the key');
  await check(made.id, undefined, 'clear');
  await update(made.id, { external_ref: '' });
  await check(made.id, undefined, 'clear of a bead without a reference');
  await update(made.id, { external_ref: 'CHG00000001' });
  await check(made.id, 'CHG00000001', 'set again after a clear');
}

// ---------------------------------------------------------------- bd store: writes
{
  let stored = {};
  const { calls, store } = stubbedBd((args) => {
    if (args[0] === 'create') return JSON.stringify({ schema_version: 1, data: { id: 'bd-1' } });
    if (args[0] === 'show') return JSON.stringify({ schema_version: 1, data: [{ ...minimal, ...stored }] });
    if (args[0] === 'update') return '';
    return assert.fail(`unexpected bd command: ${args.join(' ')}`);
  });
  const { createInputSchema } = loader()('schema');
  // The commands one operation ran for a verb, and the flag with the value after it.
  const ran = async (verb, operation) => {
    calls.length = 0;
    const bead = await operation();
    return { bead, commands: calls.filter((args) => args[0] === verb) };
  };
  const flagOf = (args) => {
    const at = args.indexOf('--external-ref');
    return at === -1 ? null : args.slice(at, at + 2);
  };
  const noFlag = (args) => !args.some((a) => a.startsWith('--external-ref'));

  for (const value of ['STRY00000001', '-INC00000001']) {
    stored = { external_ref: value };
    const { bead, commands } = await ran('create', () => store.create(createInputSchema.parse({ title: 't', external_ref: value }), 'actor'));
    assert.equal(commands.length, 1, 'one bd create');
    assert.deepEqual(flagOf(commands[0]), ['--external-ref', value], 'bd create sends the flag and the value');
    assert.equal(bead.external_ref, value, 'bd create answers the reference');
  }
  stored = {};
  for (const extra of [{}, { external_ref: '' }]) {
    const { commands } = await ran('create', () => store.create(createInputSchema.parse({ title: 't', ...extra }), 'actor'));
    assert.equal(commands.length, 1, 'one bd create');
    assert.ok(noFlag(commands[0]), `bd create sends no flag for ${JSON.stringify(extra)}: ${commands[0]}`);
  }

  for (const value of ['CHG00000001', '-INC00000001', '']) {
    stored = value ? { external_ref: value } : {};
    const { bead, commands } = await ran('update', () => store.update('bd-1', { external_ref: value }, 'actor'));
    assert.equal(commands.length, 1, `bd update runs for ${JSON.stringify(value)}`);
    assert.deepEqual(flagOf(commands[0]), ['--external-ref', value], `bd update sends the flag with ${JSON.stringify(value)}`);
    assert.equal(bead.external_ref, value || undefined, 'bd update answers what the tracker holds');
  }
  const other = await ran('update', () => store.update('bd-1', { priority: 1 }, 'actor'));
  assert.equal(other.commands.length, 1, 'bd update runs for another field');
  assert.ok(noFlag(other.commands[0]), `bd update leaves the reference alone: ${other.commands[0]}`);
  for (const patch of [{}, { external_ref: undefined }]) {
    const { commands } = await ran('update', () => store.update('bd-1', patch, 'actor'));
    assert.deepEqual(commands, [], 'an absent reference is no reason to run bd update');
  }
}

// ---------------------------------------------------------------- the text filter
{
  const load = loader();
  const { matchesFilters, emptyFilters } = load('filters');
  const { beadSchema } = load('schema');
  const bead = (extra) => beadSchema.parse({ ...minimal, title: 'Card', ...extra });
  const finds = (b, search, facets = {}) => matchesFilters(b, { ...emptyFilters, ...facets, search }, []);
  const carrying = bead({ external_ref: 'STRY00000001' });

  assert.equal(finds(carrying, 'STRY00000001'), true, 'the filter finds a bead by its reference');
  assert.equal(finds(carrying, 'ry0000000'), true, 'the filter finds a part of a reference, in any case');
  assert.equal(finds(carrying, '  stry00000001 '), true, 'the filter ignores blanks around what was typed');
  assert.equal(finds(carrying, 'STRY00000002'), false, 'another reference does not match');
  assert.equal(finds(carrying, 'STRY00000001', { status: ['closed'] }), false, 'a matching reference does not override a facet');
  for (const without of [bead({}), bead({ external_ref: null })]) {
    const held = JSON.stringify(without.external_ref) ?? 'no key';
    assert.equal(finds(without, 'STRY00000001'), false, `a bead with ${held} is not found by a reference`);
    for (const search of ['undefined', 'null']) {
      assert.equal(finds(without, search), false, `a bead with ${held} does not match "${search}"`);
    }
    assert.equal(finds(without, 'card'), true, `a bead with ${held} is still found by its title`);
  }
}

console.log('PASS external_ref: schema, input schemas, demo store, bd store and text filter');
