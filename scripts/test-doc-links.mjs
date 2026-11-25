// Pure scan of markdown links and code-span path tokens in the public docs.
// No server, no build. The repository root comes from import.meta.url, never
// from the working directory, so this passes from anywhere.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PREFIXES = ["app/", "bin/", "components/", "design/", "docs/", "hooks/", "lib/", "scripts/"];
const EXACT = new Set(["README.md", "AGENTS.md", "SECURITY.md", "LICENSE"]);

function walkMarkdown(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkMarkdown(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

const sources = [path.join(root, "README.md"), path.join(root, "AGENTS.md"), ...walkMarkdown(path.join(root, "docs"))];

function stripFences(text) {
  return text.replace(/```[\s\S]*?```/g, "");
}

function stripSurrounding(token) {
  return token.replace(/^[\"'(\[{<]+/, "").replace(/[\"'\)\]}>,;.:!?]+$/, "");
}

const missingLinks = [];
const missingPaths = [];

for (const file of sources) {
  const raw = fs.readFileSync(file, "utf8");
  const text = stripFences(raw);
  const rel = path.relative(root, file);

  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = match[1].trim().split(/\s+/)[0] ?? "";
    if (target === "") continue;
    if (target.startsWith("#")) continue;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) continue;
    const clean = target.split("#")[0].split("?")[0].trim();
    if (clean === "") continue;
    const resolved = path.resolve(path.dirname(file), clean);
    if (!fs.existsSync(resolved)) {
      missingLinks.push(`${rel}: link (${target}) resolves to ${path.relative(root, resolved)}`);
    }
  }

  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const span = match[1];
    for (const token of span.split(/\s+/)) {
      let t = stripSurrounding(token.trim());
      if (t === "") continue;
      if (t.includes("$HOME") || t.includes("$XDG") || t.includes("${") || t.startsWith("~/") || t.startsWith("$")) continue;
      if (t.startsWith("/")) continue;
      if (t.startsWith("http://") || t.startsWith("https://") || t.startsWith("mailto:")) continue;
      if (t.startsWith("node_modules/") || t.includes("/node_modules/")) continue;
      const base = t.split(":")[0];
      if (EXACT.has(base)) {
        const candidate = path.join(root, base);
        if (!fs.existsSync(candidate)) {
          missingPaths.push(`${rel}: code span \`${span}\` token ${token}`);
        }
        continue;
      }
      const isPrefix = PREFIXES.some((p) => t.startsWith(p));
      if (!isPrefix) continue;
      let candidate = t;
      const colon = candidate.indexOf(":");
      if (colon !== -1 && /:\d/.test(candidate.slice(colon))) {
        candidate = candidate.slice(0, colon);
      }
      candidate = stripSurrounding(candidate);
      if (candidate === "") continue;
      if (!fs.existsSync(path.join(root, candidate))) {
        missingPaths.push(`${rel}: code span \`${span}\` token ${token}`);
      }
    }
  }
}

assert.deepEqual(missingLinks, [], "markdown links resolve to files");
assert.deepEqual(missingPaths, [], "code-span path tokens exist");

console.log("PASS doc links: markdown links and code-span paths exist");
