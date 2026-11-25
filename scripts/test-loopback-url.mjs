// Pure table test for lib/loopback-url.ts. No server, no build.
import assert from "node:assert/strict";
import { checkWorkDashboardUrl } from "../lib/loopback-url.ts";

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
