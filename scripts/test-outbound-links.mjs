// Pure table test for lib/outbound-links.ts, without a build or a server: every rule that keeps a
// link from Houston on the configured ServiceNow host or on an allowed GitHub owner refuses its
// case, and each link kind is built or kept when it should be.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const moduleCache = new Map();

function load(name) {
  if (moduleCache.has(name)) return moduleCache.get(name);
  const exports = {};
  moduleCache.set(name, exports);
  const source = readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const wrapper = vm.runInThisContext(`(function (exports, require) {\n${code}\n})`, { filename: `lib/${name}.ts` });
  wrapper(exports, (id) => (id.startsWith('./') ? load(id.slice(2)) : require(id)));
  return exports;
}

const { ticketLink, pullRequestLink, runLink, changeLink } = load('outbound-links');

const HOST = 'example.com';
const OWNERS = ['org', 'org-a'];
const SETTINGS = { serviceNowHost: HOST, githubOrgs: OWNERS };
const REPO = 'org/repo-a';

// Whatever any case below answers, a link is either null or on an allowed place. This is checked
// on every answer, accepted and refused alike, so a refusal that leaked a link would fail here
// even before its own assertion.
function assertContained(link, label) {
  if (link === null) return;
  assert.equal(typeof link, 'string', `${label}: a link is a string`);
  const url = new URL(link);
  assert.equal(url.protocol, 'https:', `${label}: a link is https`);
  assert.equal(url.username, '', `${label}: a link has no user name`);
  assert.equal(url.password, '', `${label}: a link has no password`);
  assert.equal(url.port, '', `${label}: a link has no port`);
  assert.equal(url.href, link, `${label}: a link is canonical`);
  if (url.hostname === 'github.com') {
    const owner = url.pathname.split('/')[1];
    assert.ok(OWNERS.includes(owner), `${label}: a GitHub link is under an allowed owner`);
    return;
  }
  assert.equal(url.hostname, HOST, `${label}: a link is on the ServiceNow host`);
}

function accepted(link, expected, label) {
  assertContained(link, label);
  assert.equal(link, expected, `${label} is accepted`);
}

function refused(link, label) {
  assertContained(link, label);
  assert.equal(link, null, `${label} is refused`);
}

// ---------------------------------------------------------------- ticket links: accepted
for (const [raw, expected, label] of [
  ['https://example.com/nav_to.do?uri=incident.do?sys_id=1', 'https://example.com/nav_to.do?uri=incident.do?sys_id=1', 'ticket link'],
  ['https://example.com:443/incident.do?sys_id=1', 'https://example.com/incident.do?sys_id=1', 'ticket link with :443'],
  ['https://example.com/incident.do?opened_by=user@example.com', 'https://example.com/incident.do?opened_by=user@example.com', 'ticket link with @ in its query'],
  ['https://example.com/people/user@example.com', 'https://example.com/people/user@example.com', 'ticket link with @ in its path'],
  ['https://example.com', 'https://example.com/', 'ticket link with no path'],
  ['https://example.com?sys_id=1', 'https://example.com/?sys_id=1', 'ticket link with the query right after the host'],
  ['https://example.com#top', 'https://example.com/#top', 'ticket link with the fragment right after the host'],
  ['https://Example.COM/x', 'https://example.com/x', 'ticket link with an uppercase host, kept as the parser lowercases it'],
]) {
  accepted(ticketLink(raw, SETTINGS), expected, label);
}

// ---------------------------------------------------------------- ticket links: refused per rule
for (const [raw, label] of [
  ['http://example.com/incident.do', 'http: ticket link'],
  ['https://other.example.org/incident.do', 'ticket link on another host'],
  ['https://example.com.other.org/incident.do', 'ticket link on a host that only starts with the allowed one'],
  ['https://sub.example.com/incident.do', 'ticket link on a subdomain of the allowed host'],
  ['https://example.com./incident.do', 'ticket link on the host with a trailing dot'],
  ['https://example.com:8443/incident.do', 'ticket link on port 8443'],
  ['https://user@example.com/incident.do', 'ticket link with a user name'],
  ['https://user:secret@example.com/incident.do', 'ticket link with a user name and a password'],
  ['https://:secret@example.com/incident.do', 'ticket link with a password only'],
  ['https://other.org@example.com/incident.do', 'ticket link with another host as its user name'],
  ['https://example.com@other.org/incident.do', 'ticket link with the allowed host as its user name'],
  ['https://@example.com/', 'https://@example.com/, which the parser repairs'],
  ['https:@example.com/', 'https:@example.com/, which the parser repairs'],
  ['https:///example.com/', 'https:///example.com/, which the parser repairs'],
  ['https://example.com:/', 'https://example.com:/, which the parser repairs'],
  ['https://example.com:443:443/', 'ticket link with two ports'],
  ['https://example.com/incident.do?q=a b', 'ticket link with a space inside'],
  ['https://example.com\\incident.do', 'ticket link with a backslash, which the parser reads as a slash'],
  ['https://other.org\\@example.com/', 'ticket link with a backslash before an @'],
  ['https://example.com/incident\\x.do', 'ticket link with a backslash in its path, which the parser reads as a slash'],
  [' https://example.com/incident.do', 'ticket link with a leading space'],
  ['https://example.com/incident.do ', 'ticket link with a trailing space'],
  ['https://exa\tmple.com/incident.do', 'ticket link with a tab, which the parser drops'],
  ['https://example.com/incident.do\n', 'ticket link with a trailing newline, which the parser drops'],
  ['https://example.com/incident\0.do', 'ticket link with a NUL'],
  ['https://example.com/incident\x7f.do', 'ticket link with a DEL'],
  ['https://example.com/incident\x1b.do', 'ticket link with an escape character'],
  ['https://example.com/incident .do', 'ticket link with a no-break space'],
  ['https://exam%70le.com/incident.do', 'ticket link with a percent-encoded host, which the parser decodes'],
  ['https://ｅxample.com/incident.do', 'ticket link with a fullwidth host, which the parser folds'],
  ['https://[::1]/incident.do', 'ticket link on an IPv6 literal'],
  ['HTTPS://example.com/incident.do', 'ticket link with an uppercase scheme'],
  ['//example.com/incident.do', 'scheme-relative ticket link'],
  ['/incident.do', 'relative ticket link'],
  ['javascript:alert(1)', 'javascript: ticket link'],
  ['https://', 'ticket link with no host'],
  ['', 'empty ticket link'],
]) {
  refused(ticketLink(raw, SETTINGS), label);
}
for (const [raw, label] of [[null, 'null'], [undefined, 'undefined'], [42, 'a number'], [{ href: 'https://example.com/' }, 'an object']]) {
  refused(ticketLink(raw, SETTINGS), `ticket link that is ${label}`);
}

// ---------------------------------------------------------------- ticket links: the host setting
const TICKET = 'https://example.com/incident.do?sys_id=1';
for (const [serviceNowHost, label] of [
  [undefined, 'unset'],
  [null, 'cleared'],
  ['', 'empty'],
  ['Example.com', 'invalid (uppercase)'],
  ['https://example.com', 'invalid (with a scheme)'],
  ['example.com:443', 'invalid (with a port)'],
  ['localhost', 'invalid (a single label)'],
]) {
  refused(ticketLink(TICKET, { serviceNowHost, githubOrgs: OWNERS }), `ticket link with serviceNowHost ${label}`);
}
// An invalid host refuses even a link that names it exactly, so the host's own rule is what refuses.
for (const host of ['localhost', '127.0.0.1']) {
  refused(ticketLink(`https://${host}/incident.do`, { serviceNowHost: host }), `ticket link on the invalid serviceNowHost ${host}`);
}

// ---------------------------------------------------------------- pull-request and run links: accepted
accepted(pullRequestLink(REPO, 7, SETTINGS), 'https://github.com/org/repo-a/pull/7', 'pull request link');
accepted(runLink(REPO, 123456789, SETTINGS), 'https://github.com/org/repo-a/actions/runs/123456789', 'run link');
accepted(pullRequestLink('org-a/repo_b.js', 1, SETTINGS), 'https://github.com/org-a/repo_b.js/pull/1', 'pull request link under a second owner');
accepted(runLink(REPO, 2 ** 53 - 1, SETTINGS), `https://github.com/org/repo-a/actions/runs/${2 ** 53 - 1}`, 'run link with the largest safe integer');

// ---------------------------------------------------------------- pull-request and run links: refused per rule
const builders = [['pull request link', pullRequestLink], ['run link', runLink]];
for (const [kind, build] of builders) {
  for (const [repo, label] of [
    ['Org/repo-a', 'an uppercase owner'],
    ['org/Repo-A', 'an uppercase repository name'],
    ['org/..', 'org/..'],
    ['org/.', 'org/.'],
    ['org-b/repo-a', 'an owner outside the list'],
    ['org-ab/repo-a', 'an owner that only starts with an allowed one'],
    ['org/repo-a/extra', 'three parts'],
    ['org', 'no name'],
    ['/repo-a', 'no owner'],
    [' org/repo-a', 'a leading space'],
    ['org/repo a', 'a space inside'],
    ['org/repo-a?x=1', 'a query'],
    ['org/repo-a#x', 'a fragment'],
    ['org/repo%2fa', 'a percent sign'],
    ['', 'an empty repository'],
    [null, 'no repository'],
  ]) {
    refused(build(repo, 7, SETTINGS), `${kind} with ${label}`);
  }
  for (const [id, label] of [
    [0, '0'],
    [-1, '-1'],
    [1.5, '1.5'],
    [NaN, 'NaN'],
    [Infinity, 'Infinity'],
    [2 ** 53, '2**53'],
    ['7', 'the string "7"'],
    [7n, 'a bigint'],
    [null, 'null'],
    [undefined, 'undefined'],
  ]) {
    refused(build(REPO, id, SETTINGS), `${kind} with id ${label}`);
  }
  for (const [githubOrgs, label] of [
    [undefined, 'unset'],
    [null, 'cleared'],
    [[], 'an empty list'],
    ['org', 'invalid (not a list)'],
    [['org', 'Org-A'], 'invalid (an uppercase entry)'],
    [['org', '-org'], 'invalid (an entry with a leading hyphen)'],
  ]) {
    refused(build(REPO, 7, { serviceNowHost: HOST, githubOrgs }), `${kind} with githubOrgs ${label}`);
  }
}

// ---------------------------------------------------------------- change links
const CHANGES = [
  { key: 'k1', number: 'CHG00000001', title: 'Change one', state: 'Scheduled', link: 'https://example.com/change_request.do?sys_id=1' },
  { key: 'k2', number: ' chg00000002 ', title: 'Change two', state: 'New', link: 'https://example.com/change_request.do?sys_id=2' },
  { key: 'k3', number: 'CHG00000003', title: 'Change three', state: 'New', link: 'http://example.com/change_request.do?sys_id=3' },
  { key: 'k4', number: 'CHG00000004', title: 'Change four', state: 'New', link: 'https://other.example.org/change_request.do?sys_id=4' },
  { key: 'k5', number: '', title: 'No number', state: 'New', link: 'https://example.com/change_request.do?sys_id=5' },
];
const standardForm = (number) => `https://example.com/change_request.do?sysparm_query=number=${number}`;

accepted(changeLink('CHG00000001', CHANGES, SETTINGS), CHANGES[0].link, 'change found in the changes source, linking to its own link');
accepted(changeLink('  chg00000001 ', CHANGES, SETTINGS), CHANGES[0].link, 'change found trimmed and without regard to case');
accepted(changeLink('CHG00000002', CHANGES, SETTINGS), CHANGES[1].link, 'change whose record number is padded and lowercase');
accepted(changeLink('CHG00000009', CHANGES, SETTINGS), standardForm('CHG00000009'), 'change absent from the changes source, getting the standard change form');
accepted(changeLink(' CHG00000009 ', CHANGES, SETTINGS), standardForm('CHG00000009'), 'absent change number trimmed before the standard form');
accepted(changeLink('CHG00000009', [], SETTINGS), standardForm('CHG00000009'), 'change with an empty changes source');

refused(changeLink('CHG00000003', CHANGES, SETTINGS), 'change whose record link is http, never falling back to the standard form');
refused(changeLink('CHG00000004', CHANGES, SETTINGS), 'change whose record link is on another host');
refused(changeLink('CHG1?x=1', CHANGES, SETTINGS), 'malformed fallback number CHG1?x=1');
refused(changeLink('CHG1/../x', CHANGES, SETTINGS), 'malformed fallback number with a path');
refused(changeLink('chg00000009', CHANGES, SETTINGS), 'absent lowercase number, outside the ticket-number shape');
refused(changeLink('CHG 00000009', CHANGES, SETTINGS), 'absent number with a space inside');
refused(changeLink('', CHANGES, SETTINGS), 'empty change number, even with a record whose number is empty');
refused(changeLink('   ', CHANGES, SETTINGS), 'blank change number');
refused(changeLink(null, CHANGES, SETTINGS), 'change number that is null');
for (const [serviceNowHost, label] of [[undefined, 'unset'], [null, 'cleared'], ['Example.com', 'invalid'], ['localhost', 'invalid (a single label)']]) {
  const settings = { serviceNowHost, githubOrgs: OWNERS };
  refused(changeLink('CHG00000001', CHANGES, settings), `found change with serviceNowHost ${label}`);
  refused(changeLink('CHG00000009', CHANGES, settings), `absent change with serviceNowHost ${label}`);
}

// ---------------------------------------------------------------- containment over generated input
// A fixed-seed sweep over strings built from the pieces the rules above are about. Whatever comes
// out must be null or a link on the allowed host: the table cases prove each rule, this proves
// that no combination of them slips past the whole.
{
  const pieces = [
    'https://', 'https:', 'http://', '//', '/', '\\', '@', ':', '443', '8443', '.', 'example.com',
    'other.org', 'EXAMPLE.COM', '%2e', '%40', '?', '#', ' ', '\t', '\n', '\0', 'user', 'a', '[::1]',
  ];
  let seed = 0x2545f491;
  const next = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed;
  };
  let kept = 0;
  for (let i = 0; i < 20000; i++) {
    let raw = '';
    const length = 1 + (next() % 7);
    for (let j = 0; j < length; j++) raw += pieces[next() % pieces.length];
    const link = ticketLink(raw, SETTINGS);
    assertContained(link, `generated ${JSON.stringify(raw)}`);
    if (link !== null) kept++;
    assertContained(changeLink(raw, [], SETTINGS), `generated change number ${JSON.stringify(raw)}`);
    assertContained(changeLink('CHG00000001', [{ number: 'CHG00000001', link: raw }], SETTINGS), `generated change record link ${JSON.stringify(raw)}`);
  }
  assert.ok(kept > 0, 'the sweep reaches accepted links too');
}

console.log('outbound links: ok');
