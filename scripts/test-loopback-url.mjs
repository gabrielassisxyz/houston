// Pure table test for lib/loopback-url.ts. No server, no build.
import assert from "node:assert/strict";
import { checkLoopbackServiceUrl, checkWorkDashboardUrl } from "../lib/loopback-url.ts";

// ── Accepted: exact normalised URL ─────────────────────────────────────
const accepted = [
  ["http://127.0.0.1:8000/", "http://127.0.0.1:8000/"],
  ["https://127.0.0.1/dash", "https://127.0.0.1/dash"],
  ["http://2130706433:8000", "http://127.0.0.1:8000/"],
  ["http://127.0.0.1:80/", "http://127.0.0.1/"],
  ["http://127.0.0.1:8000/a%3Fb%23c", "http://127.0.0.1:8000/a%3Fb%23c"],
  ["  http://127.0.0.1:8000/  ", "http://127.0.0.1:8000/"],
  ["http://127.0.0.1:8000/\n", "http://127.0.0.1:8000/"],
];
for (const [input, expected] of accepted) {
  const result = checkWorkDashboardUrl(input);
  assert.equal(result.ok, true, `${JSON.stringify(input)} should be accepted`);
  assert.equal(result.url, expected, `${JSON.stringify(input)} should normalise to ${expected}`);
}

// ── Refused: non-empty reason ──────────────────────────────────────────
const refused = [
  ["empty string", ""],
  ["whitespace only", "   "],
  ["unparseable", "not a url"],
  ["user and password", "http://user:pw@127.0.0.1:8000/"],
  ["username only", "http://user@127.0.0.1/"],
  ["password only", "http://:pw@127.0.0.1/"],
  ["ftp protocol", "ftp://127.0.0.1/"],
  ["javascript protocol", "javascript:alert(1)"],
  ["websocket protocol on the loopback host", "ws://127.0.0.1:8000/"],
  ["file protocol on the loopback host", "file://127.0.0.1/etc/hosts"],
  ["localhost", "http://localhost:8000/"],
  ["127.0.0.2", "http://127.0.0.2/"],
  ["ipv6 loopback", "http://[::1]/"],
  ["nip.io suffix", "http://127.0.0.1.nip.io/"],
  ["query", "http://127.0.0.1:8000/?a=1"],
  ["bare question mark", "http://127.0.0.1:8000/?"],
  ["fragment", "http://127.0.0.1:8000/#x"],
  ["bare hash", "http://127.0.0.1:8000/#"],
  ["empty query and fragment", "http://127.0.0.1:8000/?#"],
  ["port zero", "http://127.0.0.1:0/"],
  ["number", 8000],
  ["null", null],
  ["array", ["http://127.0.0.1:8000/"]],
  ["object with URL toString", { toString: () => "http://127.0.0.1:8000/" }],
  ["embedded tab", "http://127.0.0.1:8000/a\tb"],
  ["embedded line feed", "http://127.0.0.1:8000/a\nb"],
  ["embedded carriage return", "http://127.0.0.1:8000/a\rb"],
  ["embedded NUL", "http://127.0.0.1:8000/a\x00b"],
  ["embedded DEL", "http://127.0.0.1:8000/a\x7fb"],
];
for (const [name, input] of refused) {
  const result = checkWorkDashboardUrl(input);
  assert.equal(result.ok, false, `${name} should be refused`);
  assert.ok(
    typeof result.reason === "string" && result.reason.length > 0,
    `${name} needs a non-empty reason`,
  );
}

// ── Empty versus unparseable reasons ─────────────────────────────────────
const emptyReason = checkWorkDashboardUrl("").reason;
const blankReason = checkWorkDashboardUrl("   ").reason;
const parseReason = checkWorkDashboardUrl("not a url").reason;
assert.match(emptyReason, /empty/i, "empty string reason names emptiness");
assert.match(blankReason, /empty/i, "whitespace-only reason names emptiness");
assert.doesNotMatch(parseReason, /empty/i, "parse-failure reason must not mention emptiness");
assert.notEqual(emptyReason, parseReason, "empty and parse-failure reasons differ");

console.log("PASS loopback URL: 127.0.0.1 addresses accepted normalised; everything else refused with a reason");

// ── Second mode, the notes service address ───────────────────────────────
const serviceAccepted = [
  ["http://127.0.0.1:3301/", "http://127.0.0.1:3301/"],
  ["http://127.0.0.1:3301", "http://127.0.0.1:3301/"],
  ["https://127.0.0.1", "https://127.0.0.1/"],
  ["http://127.0.0.1:80/", "http://127.0.0.1/"],
  ["http://2130706433:3301", "http://127.0.0.1:3301/"],
  ["http://localhost:3301/", "http://localhost:3301/"],
  ["http://LOCALHOST:3301", "http://localhost:3301/"],
  ["http://[::1]:3301/", "http://[::1]:3301/"],
  ["http://[0:0:0:0:0:0:0:1]:3301", "http://[::1]:3301/"],
  ["http://127.0.0.1:65535/", "http://127.0.0.1:65535/"],
  ["  http://127.0.0.1:3301/  ", "http://127.0.0.1:3301/"],
  ["http://127.0.0.1:3301/\n", "http://127.0.0.1:3301/"],
];
for (const [input, expected] of serviceAccepted) {
  const result = checkLoopbackServiceUrl(input);
  assert.equal(result.ok, true, `service: ${JSON.stringify(input)} should be accepted`);
  assert.equal(result.url, expected, `service: ${JSON.stringify(input)} should normalise to ${expected}`);
}

// Each address breaks one rule only, so each rule has a case nothing else covers.
const serviceRefused = [
  ["empty string", ""],
  ["whitespace only", "   "],
  ["unparseable", "not a url"],
  ["number", 3301],
  ["null", null],
  ["array", ["http://127.0.0.1:3301/"]],
  ["object with URL toString", { toString: () => "http://127.0.0.1:3301/" }],
  ["tab the parser would drop", "http://127.0.0.1\t:3301/"],
  ["line feed the parser would drop", "http://127.0.0.1:33\n01/"],
  ["ftp protocol", "ftp://127.0.0.1/"],
  ["websocket protocol", "ws://127.0.0.1:3301/"],
  ["file protocol", "file://127.0.0.1/"],
  ["user and password", "http://user:pw@127.0.0.1:3301/"],
  ["username only", "http://user@127.0.0.1:3301/"],
  ["password only", "http://:pw@127.0.0.1:3301/"],
  ["127.0.0.2", "http://127.0.0.2:3301/"],
  ["wildcard 0.0.0.0", "http://0.0.0.0:3301/"],
  ["wildcard [::]", "http://[::]:3301/"],
  ["IPv4-mapped IPv6", "http://[::ffff:127.0.0.1]:3301/"],
  ["nip.io suffix", "http://127.0.0.1.nip.io:3301/"],
  ["localhost suffix", "http://localhost.example.com:3301/"],
  ["localhost with a trailing dot", "http://localhost.:3301/"],
  ["outside host", "http://example.com:3301/"],
  ["query", "http://127.0.0.1:3301/?a=1"],
  ["bare question mark", "http://127.0.0.1:3301/?"],
  ["fragment", "http://127.0.0.1:3301/#x"],
  ["bare hash", "http://127.0.0.1:3301/#"],
  ["path prefix", "http://127.0.0.1:3301/prefix/"],
  ["path without a trailing slash", "http://127.0.0.1:3301/api"],
  ["double slash path", "http://127.0.0.1:3301//"],
  ["port zero", "http://127.0.0.1:0/"],
  ["port past the range", "http://127.0.0.1:65536/"],
];
for (const [name, input] of serviceRefused) {
  const result = checkLoopbackServiceUrl(input);
  assert.equal(result.ok, false, `service: ${name} should be refused`);
  assert.match(result.reason, /^Notes service URL /, `service: ${name} needs a reason naming the setting`);
}

console.log("PASS loopback service URL: loopback roots accepted normalised; everything else refused with a reason");
