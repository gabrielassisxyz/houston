// Pure tests for scripts/install-services.sh and scripts/update.sh.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installScript = path.join(root, "scripts", "install-services.sh");
const updateScript = path.join(root, "scripts", "update.sh");
const uid = String(process.getuid());

function parsePlist(xml) {
  const py = [
    "import json, plistlib, sys",
    "data = plistlib.loads(sys.stdin.buffer.read())",
    "print(json.dumps(data))",
  ].join("\n");
  const out = execFileSync("python3", ["-c", py], { input: xml, encoding: "utf8" });
  return JSON.parse(out);
}

function makeStub(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return file;
}

function makeGoStub(dir, logFile, { failOnBuild = false } = {}) {
  const q = JSON.stringify(logFile);
  const body = [
    `{ printf 'go %s\\n' "$*"; printf 'cwd %s\\n' "$PWD"; } >> ${q}`,
    failOnBuild
      ? `if [ -n "\${STUB_FAIL_GO:-}" ]; then exit 1; fi`
      : `true`,
    `prev=""; out=""`,
    `for arg in "$@"; do`,
    `  if [ "$prev" = "-o" ]; then out="$arg"; break; fi`,
    `  prev="$arg"`,
    `done`,
    `if [ -n "$out" ]; then mkdir -p "$(dirname "$out")"; printf '#!/usr/bin/env bash\\nexit 0\\n' > "$out"; chmod +x "$out"; fi`,
    `exit 0`,
  ].join("\n");
  return makeStub(dir, "go", body);
}

// 1. Syntax check on both scripts.
for (const script of [installScript, updateScript]) {
  execFileSync("bash", ["-n", script], { stdio: "pipe" });
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "houston-svc-"));
try {
  // 2. --print with explicit arguments, with XDG_CONFIG_HOME set and unset,
  //    with no br on PATH and without creating any directory or file.
  {
    const printHome = path.join(scratch, "print-home");
    fs.mkdirSync(printHome);
    const customXdg = path.join(scratch, "custom-xdg");
    const checkout = "/opt/houston & test/app";
    const servicePath = "/opt/homebrew/bin:/usr/bin:/bin";
    const nodeBin = "/opt/homebrew/bin/node";
    const baseEnv = {
      HOME: printHome,
      PATH: "/usr/bin:/bin", // deliberately excludes br
    };

    // With XDG_CONFIG_HOME set.
    const xmlSet = execFileSync(
      installScript,
      ["--print", "--node", nodeBin, "--checkout", checkout, "--path", servicePath, "--port", "3456"],
      { env: { ...baseEnv, XDG_CONFIG_HOME: customXdg }, encoding: "utf8" },
    );
    const plistSet = parsePlist(xmlSet);
    assert.equal(plistSet.Label, "houston.hub");
    assert.deepEqual(plistSet.ProgramArguments, [
      nodeBin,
      `${checkout}/bin/houston-web.mjs`,
      "--no-open",
      "--port",
      "3456",
      "--host",
      "127.0.0.1",
    ]);
    assert.deepEqual(plistSet.EnvironmentVariables, {
      PATH: servicePath,
      XDG_CONFIG_HOME: customXdg,
    });
    assert.equal(plistSet.RunAtLoad, true);
    assert.equal(plistSet.KeepAlive, true);
    const expectedLog = `${printHome}/Library/Logs/houston/hub.log`;
    assert.equal(plistSet.StandardOutPath, expectedLog);
    assert.equal(plistSet.StandardErrorPath, expectedLog);
    assert.ok(path.isAbsolute(plistSet.StandardOutPath) && !plistSet.StandardOutPath.includes("~"));

    // With XDG_CONFIG_HOME unset -> falls back to $HOME/.config.
    const xmlUnset = execFileSync(
      installScript,
      ["--print", "--node", nodeBin, "--checkout", checkout, "--path", servicePath],
      { env: baseEnv, encoding: "utf8" },
    );
    const plistUnset = parsePlist(xmlUnset);
    assert.equal(plistUnset.ProgramArguments[4], "3300", "default port is 3300");
    assert.equal(plistUnset.EnvironmentVariables.XDG_CONFIG_HOME, `${printHome}/.config`);

    // --print must not touch disk.
    assert.deepEqual(fs.readdirSync(printHome), [], "--print creates nothing under HOME");
    assert.equal(fs.existsSync(customXdg), false, "--print creates nothing under XDG_CONFIG_HOME");

    // --print output is hub-only: no notes definition leaks in.
    assert.ok(!xmlSet.includes("houston.notes"), "--print output has no notes label");
    assert.ok(!xmlSet.includes("HOUSTON_VAULT"), "--print output has no notes env");

    // Control characters that cannot be safely represented in XML are refused.
    const badPath = spawnSync(
      installScript,
      ["--print", "--node", nodeBin, "--checkout", "/tmp/bad\npath"],
      { env: baseEnv, encoding: "utf8" },
    );
    assert.notEqual(badPath.status, 0, "newline in checkout path is refused");
  }

  // 3. Install against a temporary HOME with stub launchctl, br, git, node.
  const home = path.join(scratch, "home");
  const stubBin = path.join(scratch, "stubs");
  const serviceTools = path.join(scratch, "svc-tools");
  const logFile = path.join(scratch, "calls.log");
  fs.mkdirSync(home);
  fs.mkdirSync(stubBin);
  fs.mkdirSync(serviceTools);

  const stubNode = makeStub(serviceTools, "node", "exit 0");
  makeStub(serviceTools, "br", "exit 0");
  makeStub(serviceTools, "git", "exit 0");
  makeStub(
    stubBin,
    "launchctl",
    `printf 'launchctl %s\\n' "$*" >> ${JSON.stringify(logFile)}\nif [ "$1" = "bootout" ] && [ -n "\${STUB_BOOTOUT_FAIL:-}" ]; then exit 3; fi\nexit 0`,
  );

  const installEnv = {
    HOME: home,
    PATH: `${stubBin}:/usr/bin:/bin`,
  };

  // Relative --node is refused.
  const relNode = spawnSync(installScript, ["--node", "bin/node", "--path", serviceTools], {
    env: installEnv,
    encoding: "utf8",
  });
  assert.notEqual(relNode.status, 0, "relative --node is refused");
  assert.match(relNode.stderr, /absolute path/i);

  // Service PATH missing br is refused before loading.
  const noBrDir = path.join(scratch, "no-br");
  fs.mkdirSync(noBrDir);
  makeStub(noBrDir, "git", "exit 0");
  const missingBr = spawnSync(installScript, ["--node", stubNode, "--path", noBrDir], {
    env: installEnv,
    encoding: "utf8",
  });
  assert.notEqual(missingBr.status, 0, "missing br in service PATH is refused");
  assert.match(missingBr.stderr, /br not found/i);
  assert.equal(fs.existsSync(logFile), false, "launchctl was not called on tool-check failure");

  // First install: creates dirs, seeds config.json, calls bootout then bootstrap.
  execFileSync(installScript, ["--node", stubNode, "--path", serviceTools, "--port", "3310"], {
    env: { ...installEnv, STUB_BOOTOUT_FAIL: "1" },
    encoding: "utf8",
  });

  const plistPath = path.join(home, "Library", "LaunchAgents", "houston.hub.plist");
  const logsDir = path.join(home, "Library", "Logs", "houston");
  const configDir = path.join(home, ".config", "houston");
  const configFile = path.join(configDir, "config.json");

  assert.equal(fs.existsSync(plistPath), true, "plist exists");
  assert.equal(fs.statSync(logsDir).isDirectory(), true, "log dir exists");
  assert.equal(fs.statSync(configDir).isDirectory(), true, "config dir exists");
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, "utf8")), { projects: [] });

  const installedPlist = parsePlist(fs.readFileSync(plistPath, "utf8"));
  assert.equal(installedPlist.Label, "houston.hub");
  assert.equal(installedPlist.ProgramArguments[0], stubNode);
  assert.equal(installedPlist.ProgramArguments[1], path.join(root, "bin", "houston-web.mjs"));
  assert.equal(installedPlist.ProgramArguments[4], "3310");
  assert.equal(installedPlist.EnvironmentVariables.XDG_CONFIG_HOME, path.join(home, ".config"));

  const firstCalls = fs.readFileSync(logFile, "utf8").trim().split("\n");
  assert.deepEqual(firstCalls, [
    `launchctl bootout gui/${uid}/houston.hub`,
    `launchctl bootstrap gui/${uid} ${plistPath}`,
  ]);

  // Second install: idempotent and preserves existing config.json.
  const plistBefore = fs.readFileSync(plistPath, "utf8");
  fs.writeFileSync(configFile, JSON.stringify({ projects: [{ id: "a", name: "A", path: "/tmp/a" }] }));
  execFileSync(installScript, ["--node", stubNode, "--path", serviceTools, "--port", "3310"], {
    env: installEnv,
    encoding: "utf8",
  });
  assert.equal(fs.readFileSync(plistPath, "utf8"), plistBefore, "second run writes identical plist");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(configFile, "utf8")).projects.map((p) => p.id),
    ["a"],
    "existing config.json is preserved",
  );

  // Hub-only install never calls go, even when a stub go is on PATH.
  {
    const hubHome = path.join(scratch, "hub-home");
    fs.mkdirSync(hubHome);
    const hubStubs = path.join(scratch, "hub-stubs");
    fs.mkdirSync(hubStubs);
    const hubGoLog = path.join(scratch, "hub-go.log");
    fs.writeFileSync(hubGoLog, "");
    makeStub(
      hubStubs,
      "launchctl",
      `printf 'launchctl %s\\n' "$*" >> ${JSON.stringify(path.join(scratch, "hub-lc.log"))}\nexit 0`,
    );
    makeGoStub(hubStubs, hubGoLog);
    fs.writeFileSync(path.join(scratch, "hub-lc.log"), "");
    execFileSync(installScript, ["--node", stubNode, "--path", serviceTools], {
      env: { HOME: hubHome, PATH: `${hubStubs}:${stubBin}:/usr/bin:/bin` },
      encoding: "utf8",
    });
    assert.equal(fs.existsSync(path.join(hubHome, "Library", "LaunchAgents", "houston.notes.plist")), false, "hub-only install writes no notes plist");
    assert.equal(fs.readFileSync(hubGoLog, "utf8"), "", "hub-only install runs no go");
  }

  // 4. update.sh against the same temporary HOME with stub launchctl, git, npm.
  const emptyHome = path.join(scratch, "empty-home");
  fs.mkdirSync(emptyHome);
  const missingPlist = spawnSync(updateScript, [], {
    env: { HOME: emptyHome, PATH: `${stubBin}:/usr/bin:/bin` },
    encoding: "utf8",
  });
  assert.notEqual(missingPlist.status, 0, "update.sh refuses when plist is absent");
  assert.match(missingPlist.stderr, /service definition not found/i);

  const updateStubs = path.join(scratch, "update-stubs");
  fs.mkdirSync(updateStubs);
  const updateLog = path.join(scratch, "update-calls.log");
  makeStub(
    updateStubs,
    "launchctl",
    `printf 'launchctl %s\\n' "$*" >> ${JSON.stringify(updateLog)}\nif [ "$1" = "bootout" ] && [ -n "\${STUB_BOOTOUT_FAIL:-}" ]; then exit 3; fi\nexit 0`,
  );
  makeStub(
    updateStubs,
    "git",
    `printf 'git %s\\n' "$*" >> ${JSON.stringify(updateLog)}\nexit 0`,
  );
  makeStub(
    updateStubs,
    "npm",
    `printf 'npm %s\\n' "$*" >> ${JSON.stringify(updateLog)}\nif [ -n "\${STUB_FAIL_NPM:-}" ] && [ "$1" = "$STUB_FAIL_NPM" ]; then exit 1; fi\nexit 0`,
  );

  const updateEnv = {
    HOME: home,
    PATH: `${updateStubs}:/usr/bin:/bin`,
  };

  // Happy path: bootout -> git pull --ff-only -> npm ci -> npm run build -> bootstrap.
  execFileSync(updateScript, [], { env: updateEnv, encoding: "utf8" });
  assert.deepEqual(fs.readFileSync(updateLog, "utf8").trim().split("\n"), [
    `launchctl bootout gui/${uid}/houston.hub`,
    "git pull --ff-only",
    "npm ci",
    "npm run build",
    `launchctl bootstrap gui/${uid} ${plistPath}`,
  ]);

  // Failing npm ci: stops, names the step, leaves service unloaded (no build, no bootstrap).
  fs.writeFileSync(updateLog, "");
  const failed = spawnSync(updateScript, [], {
    env: { ...updateEnv, STUB_FAIL_NPM: "ci" },
    encoding: "utf8",
  });
  assert.notEqual(failed.status, 0, "update.sh fails when npm ci fails");
  assert.match(failed.stderr, /failed at step "npm ci"/);
  assert.match(failed.stderr, /remains unloaded/);
  assert.deepEqual(fs.readFileSync(updateLog, "utf8").trim().split("\n"), [
    `launchctl bootout gui/${uid}/houston.hub`,
    "git pull --ff-only",
    "npm ci",
  ]);

  // Second run resumes cleanly even though bootout returns non-zero (already unloaded).
  fs.writeFileSync(updateLog, "");
  execFileSync(updateScript, [], {
    env: { ...updateEnv, STUB_BOOTOUT_FAIL: "1" },
    encoding: "utf8",
  });
  assert.deepEqual(fs.readFileSync(updateLog, "utf8").trim().split("\n"), [
    `launchctl bootout gui/${uid}/houston.hub`,
    "git pull --ff-only",
    "npm ci",
    "npm run build",
    `launchctl bootstrap gui/${uid} ${plistPath}`,
  ]);

  // 5. Notes: --print-notes renders the second document with synthetic paths.
  {
    const notesPrintHome = path.join(scratch, "notes-print-home");
    fs.mkdirSync(notesPrintHome);
    const checkout = path.join(scratch, "syn-checkout");
    const vault = path.join(scratch, "syn-vault");
    const db = path.join(scratch, "syn-state", "notes.db");
    const servicePath = "/opt/homebrew/bin:/usr/bin:/bin";
    const baseEnv = { HOME: notesPrintHome, PATH: "/usr/bin:/bin" };
    const xml = execFileSync(
      installScript,
      [
        "--print-notes",
        "--notes-vault", vault,
        "--notes-db", db,
        "--notes-port", "3321",
        "--checkout", checkout,
        "--path", servicePath,
        "--port", "3456",
      ],
      { env: baseEnv, encoding: "utf8" },
    );
    const plist = parsePlist(xml);
    assert.equal(plist.Label, "houston.notes");
    assert.deepEqual(plist.ProgramArguments, [`${checkout}/notes/bin/houston`, "serve"]);
    assert.deepEqual(plist.EnvironmentVariables, {
      HOUSTON_VAULT: vault,
      HOUSTON_DB: db,
      HOUSTON_ADDR: "127.0.0.1:3321",
      XDG_CONFIG_HOME: `${notesPrintHome}/.config`,
      PATH: servicePath,
    });
    assert.equal(plist.RunAtLoad, true);
    assert.equal(plist.KeepAlive, true);
    const expectedNotesLog = `${notesPrintHome}/Library/Logs/houston/notes.log`;
    assert.equal(plist.StandardOutPath, expectedNotesLog);
    assert.equal(plist.StandardErrorPath, expectedNotesLog);
    assert.equal(plist.SoftResourceLimits.NumberOfFiles, 16384);
    assert.equal(plist.HardResourceLimits.NumberOfFiles, 65536);
    // Synthetic vault does not need to exist for --print-notes.
    assert.equal(fs.existsSync(vault), false, "print-notes works with a missing vault dir");
    assert.deepEqual(fs.readdirSync(notesPrintHome), [], "--print-notes creates nothing under HOME");
    assert.equal(fs.existsSync(checkout), false, "--print-notes creates nothing at checkout");

    // Defaults: --notes-db defaults under XDG_STATE_HOME, --notes-port 3301.
    const defHome = path.join(scratch, "notes-def-home");
    fs.mkdirSync(defHome);
    const defXml = execFileSync(
      installScript,
      ["--print-notes", "--notes-vault", path.join(scratch, "syn-vault2"), "--checkout", checkout, "--path", servicePath],
      { env: { HOME: defHome, PATH: "/usr/bin:/bin" }, encoding: "utf8" },
    );
    const defPlist = parsePlist(defXml);
    assert.equal(defPlist.EnvironmentVariables.HOUSTON_DB, `${defHome}/.local/state/houston/notes.db`);
    assert.equal(defPlist.EnvironmentVariables.HOUSTON_ADDR, "127.0.0.1:3301");
    // A default database whose parent does not exist yet is accepted.
    assert.equal(fs.existsSync(path.join(defHome, ".local")), false, "default db parent need not exist");

    // --print-notes needs no --node and no br/git/go on PATH, and runs no go.
    const noToolHome = path.join(scratch, "notes-notool-home");
    fs.mkdirSync(noToolHome);
    const goLog = path.join(scratch, "print-notes-go.log");
    fs.writeFileSync(goLog, "");
    const noToolStubs = path.join(scratch, "print-notes-stubs");
    fs.mkdirSync(noToolStubs);
    makeGoStub(noToolStubs, goLog);
    const noToolXml = execFileSync(
      installScript,
      ["--print-notes", "--notes-vault", vault, "--checkout", checkout, "--path", servicePath],
      { env: { HOME: noToolHome, PATH: `${noToolStubs}:/usr/bin:/bin` }, encoding: "utf8" },
    );
    assert.ok(noToolXml.includes("houston.notes"), "print-notes works without node/br/git/go");
    assert.equal(fs.readFileSync(goLog, "utf8"), "", "--print-notes runs no go");
    assert.deepEqual(fs.readdirSync(noToolHome), [], "--print-notes leaves HOME untouched");

    // Sibling db beside the vault passes: /vault-db is not inside /vault.
    const sibVault = path.join(scratch, "syn-vault");
    const sibXml = execFileSync(
      installScript,
      ["--print-notes", "--notes-vault", sibVault, "--notes-db", `${sibVault}-db`, "--checkout", checkout, "--path", servicePath],
      { env: { HOME: noToolHome, PATH: "/usr/bin:/bin" }, encoding: "utf8" },
    );
    assert.ok(sibXml.includes("-db"), "sibling db path passes");
  }

  // 6. Notes refusals: every new option and combination.
  {
    const rHome = path.join(scratch, "refuse-home");
    fs.mkdirSync(rHome);
    const rBase = { HOME: rHome, PATH: "/usr/bin:/bin" };
    const checkout = "/tmp/synthetic/checkout";
    const servicePath = "/usr/bin:/bin";
    const mustFail = (args, pattern, label, env = rBase) => {
      const r = spawnSync(installScript, args, { env, encoding: "utf8" });
      assert.notEqual(r.status, 0, `${label} is refused`);
      assert.match(r.stderr, pattern, `${label} names the problem`);
      return r;
    };
    mustFail(["--print", "--print-notes", "--notes-vault", "/tmp/v"], /cannot be combined/i, "--print with --print-notes");
    mustFail(["--print-notes"], /requires --notes-vault/i, "--print-notes without --notes-vault");
    mustFail(["--notes-db", "/tmp/x.db"], /requires --notes-vault/i, "--notes-db without --notes-vault");
    mustFail(["--notes-port", "3322"], /requires --notes-vault/i, "--notes-port without --notes-vault");
    mustFail(
      ["--print-notes", "--notes-vault", "relative/vault", "--checkout", checkout, "--path", servicePath],
      /absolute path/i,
      "relative --notes-vault",
    );
    mustFail(
      ["--print-notes", "--notes-vault", "/tmp/v", "--notes-db", "relative/db", "--checkout", checkout, "--path", servicePath],
      /absolute path/i,
      "relative --notes-db",
    );
    mustFail(
      ["--print-notes", "--notes-vault", "/tmp/v", "--notes-port", "0", "--checkout", checkout, "--path", servicePath],
      /--notes-port must be an integer between 1 and 65535/i,
      "--notes-port 0",
    );
    mustFail(
      ["--print-notes", "--notes-vault", "/tmp/v", "--notes-port", "70000", "--checkout", checkout, "--path", servicePath],
      /--notes-port must be an integer between 1 and 65535/i,
      "--notes-port 70000",
    );
    mustFail(
      ["--print-notes", "--notes-vault", "/tmp/v", "--notes-port", "3456", "--port", "3456", "--checkout", checkout, "--path", servicePath],
      /must not equal --port/i,
      "notes port equal to hub port",
    );
    mustFail(
      ["--print-notes", "--notes-vault", "/tmp/v", "--notes-db", "/tmp/v/notes.db", "--checkout", checkout, "--path", servicePath],
      /must not equal or lie inside/i,
      "--notes-db inside the vault",
    );
    mustFail(
      ["--print-notes", "--notes-vault", "/tmp/v", "--notes-db", "/tmp/v", "--checkout", checkout, "--path", servicePath],
      /must not equal or lie inside/i,
      "--notes-db equal to the vault",
    );
    // Lexical .. that escapes and re-enters still counts as inside.
    mustFail(
      ["--print-notes", "--notes-vault", "/tmp/v", "--notes-db", "/tmp/v/../v/notes.db", "--checkout", checkout, "--path", servicePath],
      /must not equal or lie inside/i,
      "--notes-db inside vault via dot-dot",
    );
    mustFail(
      ["--print-notes", "--notes-vault", "/tmp/v", "--checkout", checkout, "--path", servicePath],
      /XDG_STATE_HOME must be an absolute path/i,
      "relative XDG_STATE_HOME with default db",
      { ...rBase, XDG_STATE_HOME: "relative/state" },
    );
    // Control characters in notes values are refused.
    mustFail(
      ["--print-notes", "--notes-vault", "/tmp/bad\nvault", "--checkout", checkout, "--path", servicePath],
      /control characters/i,
      "newline in --notes-vault",
    );
    // Real install with a vault that is not a directory is refused.
    const fileVault = path.join(scratch, "file-vault");
    fs.writeFileSync(fileVault, "not a dir");
    mustFail(
      ["--node", stubNode, "--path", serviceTools, "--notes-vault", fileVault, "--checkout", checkout],
      /not a directory/i,
      "--notes-vault that is not a directory",
      installEnv,
    );
    // Without go on PATH, the notes install is refused with the Go 1.26 hint.
    // /usr/bin/go exists on this machine, so build a clean PATH without it.
    const vaultDir = path.join(scratch, "vault-dir");
    fs.mkdirSync(vaultDir);
    const cleanBin = path.join(scratch, "cleanbin-nogo");
    fs.mkdirSync(cleanBin);
    for (const tool of ["bash", "sh", "mkdir", "mktemp", "mv", "rm", "id", "tr", "dirname", "chmod"]) {
      for (const d of ["/usr/bin", "/bin"]) {
        const src = path.join(d, tool);
        if (fs.existsSync(src)) {
          try { fs.symlinkSync(src, path.join(cleanBin, tool)); } catch {}
          break;
        }
      }
    }
    makeStub(cleanBin, "launchctl", "exit 0");
    const noGo = spawnSync(
      installScript,
      ["--node", stubNode, "--path", serviceTools, "--notes-vault", vaultDir, "--checkout", checkout],
      { env: { HOME: rHome, PATH: cleanBin }, encoding: "utf8" },
    );
    assert.notEqual(noGo.status, 0, "notes install without go is refused");
    assert.match(noGo.stderr, /Go 1\.26/i, "missing go names Go 1.26");
  }

  // 7. Real notes install with a stub go: build runs in <checkout>/notes with
  //    the right -o path, after booting houston.notes out; idempotent.
  {
    const notesHome = path.join(scratch, "notes-home");
    fs.mkdirSync(notesHome);
    const notesCheckout = path.join(scratch, "notes-checkout");
    fs.mkdirSync(notesCheckout);
    fs.mkdirSync(path.join(notesCheckout, "notes"));
    const vaultDir = path.join(scratch, "notes-vault");
    fs.mkdirSync(vaultDir);
    const goLog = path.join(scratch, "notes-go.log");
    fs.writeFileSync(goLog, "");
    const lcLog = path.join(scratch, "notes-lc.log");
    fs.writeFileSync(lcLog, "");
    const notesStubBin = path.join(scratch, "notes-stubbin");
    fs.mkdirSync(notesStubBin);
    makeStub(
      notesStubBin,
      "launchctl",
      `printf 'launchctl %s\\n' "$*" >> ${JSON.stringify(lcLog)}\nexit 0`,
    );
    const goStubDir = path.join(scratch, "notes-gobin");
    fs.mkdirSync(goStubDir);
    makeGoStub(goStubDir, goLog);
    const env = { HOME: notesHome, PATH: `${notesStubBin}:${goStubDir}:/usr/bin:/bin` };
    const dbPath = path.join(scratch, "notes-state", "notes.db");
    execFileSync(
      installScript,
      [
        "--node", stubNode,
        "--path", serviceTools,
        "--port", "3300",
        "--checkout", notesCheckout,
        "--notes-vault", vaultDir,
        "--notes-db", dbPath,
        "--notes-port", "3305",
      ],
      { env, encoding: "utf8" },
    );
    const hubPlist = path.join(notesHome, "Library", "LaunchAgents", "houston.hub.plist");
    const notesPlistFile = path.join(notesHome, "Library", "LaunchAgents", "houston.notes.plist");
    assert.equal(fs.existsSync(hubPlist), true, "hub plist written with notes enabled");
    assert.equal(fs.existsSync(notesPlistFile), true, "notes plist written");
    const notesPlist = parsePlist(fs.readFileSync(notesPlistFile, "utf8"));
    const expectedBin = path.join(notesCheckout, "notes", "bin", "houston");
    assert.equal(notesPlist.Label, "houston.notes");
    assert.deepEqual(notesPlist.ProgramArguments, [expectedBin, "serve"]);
    assert.deepEqual(notesPlist.EnvironmentVariables, {
      HOUSTON_VAULT: vaultDir,
      HOUSTON_DB: dbPath,
      HOUSTON_ADDR: "127.0.0.1:3305",
      XDG_CONFIG_HOME: path.join(notesHome, ".config"),
      PATH: serviceTools,
    });
    const expectedNotesLog = path.join(notesHome, "Library", "Logs", "houston", "notes.log");
    assert.equal(notesPlist.StandardOutPath, expectedNotesLog);
    assert.equal(notesPlist.StandardErrorPath, expectedNotesLog);
    assert.equal(notesPlist.SoftResourceLimits.NumberOfFiles, 16384);
    assert.equal(notesPlist.HardResourceLimits.NumberOfFiles, 65536);
    // Stub go wrote an executable at the -o path.
    assert.equal(fs.existsSync(expectedBin), true, "stub go wrote the notes binary");
    // Build ran inside <checkout>/notes with the right arguments, after bootout.
    const goLines = fs.readFileSync(goLog, "utf8").trim().split("\n");
    const buildLine = goLines.find((l) => l.startsWith("go build"));
    assert.ok(buildLine, "go build ran");
    assert.ok(buildLine.includes(`-o ${expectedBin}`), "go build uses the checkout -o path");
    assert.ok(buildLine.includes("./cmd/houston"), "go build builds ./cmd/houston");
    const cwdLine = goLines.find((l) => l.startsWith("cwd "));
    assert.equal(cwdLine, `cwd ${path.join(notesCheckout, "notes")}`, "go build runs inside <checkout>/notes");
    const lcLines = fs.readFileSync(lcLog, "utf8").trim().split("\n");
    assert.deepEqual(lcLines, [
      `launchctl bootout gui/${uid}/houston.hub`,
      `launchctl bootout gui/${uid}/houston.notes`,
      `launchctl bootstrap gui/${uid} ${hubPlist}`,
      `launchctl bootstrap gui/${uid} ${notesPlistFile}`,
    ]);
    // Idempotent: second run writes identical plists and rebuilds.
    const hubBefore = fs.readFileSync(hubPlist, "utf8");
    const notesBefore = fs.readFileSync(notesPlistFile, "utf8");
    fs.writeFileSync(goLog, "");
    fs.writeFileSync(lcLog, "");
    execFileSync(
      installScript,
      [
        "--node", stubNode,
        "--path", serviceTools,
        "--port", "3300",
        "--checkout", notesCheckout,
        "--notes-vault", vaultDir,
        "--notes-db", dbPath,
        "--notes-port", "3305",
      ],
      { env, encoding: "utf8" },
    );
    assert.equal(fs.readFileSync(hubPlist, "utf8"), hubBefore, "second hub plist identical");
    assert.equal(fs.readFileSync(notesPlistFile, "utf8"), notesBefore, "second notes plist identical");
  }

  // 8. update.sh with the notes definition installed.
  {
    const notesHome = path.join(scratch, "notes-home");
    const hubPlist = path.join(notesHome, "Library", "LaunchAgents", "houston.hub.plist");
    const notesPlistFile = path.join(notesHome, "Library", "LaunchAgents", "houston.notes.plist");
    assert.equal(fs.existsSync(notesPlistFile), true, "notes home ready for update tests");
    const updStubs = path.join(scratch, "notes-update-stubs");
    fs.mkdirSync(updStubs);
    const updLog = path.join(scratch, "notes-update.log");
    const updGoLog = path.join(scratch, "notes-update-go.log");
    fs.writeFileSync(updLog, "");
    fs.writeFileSync(updGoLog, "");
    makeStub(
      updStubs,
      "launchctl",
      `printf 'launchctl %s\\n' "$*" >> ${JSON.stringify(updLog)}\nexit 0`,
    );
    makeStub(
      updStubs,
      "git",
      `printf 'git %s\\n' "$*" >> ${JSON.stringify(updLog)}\nexit 0`,
    );
    makeStub(
      updStubs,
      "npm",
      `printf 'npm %s\\n' "$*" >> ${JSON.stringify(updLog)}\nexit 0`,
    );
    makeGoStub(updStubs, updGoLog, { failOnBuild: true });
    const env = { HOME: notesHome, PATH: `${updStubs}:/usr/bin:/bin` };
    // Happy path order: both bootouts, git pull, npm ci, npm run build, go build, both bootstraps.
    execFileSync(updateScript, [], { env, encoding: "utf8" });
    const lines = fs.readFileSync(updLog, "utf8").trim().split("\n");
    assert.deepEqual(lines, [
      `launchctl bootout gui/${uid}/houston.hub`,
      `launchctl bootout gui/${uid}/houston.notes`,
      "git pull --ff-only",
      "npm ci",
      "npm run build",
      `launchctl bootstrap gui/${uid} ${hubPlist}`,
      `launchctl bootstrap gui/${uid} ${notesPlistFile}`,
    ]);
    const goLines = fs.readFileSync(updGoLog, "utf8").trim().split("\n");
    const buildLine = goLines.find((l) => l.startsWith("go build"));
    assert.ok(buildLine && buildLine.includes("./cmd/houston"), "update runs go build for notes");
    const cwdLine = goLines.find((l) => l.startsWith("cwd "));
    assert.equal(cwdLine, `cwd ${path.join(root, "notes")}`, "update go build runs inside <checkout>/notes");

    // Failing go build leaves both unloaded and says so.
    fs.writeFileSync(updLog, "");
    const failing = spawnSync(updateScript, [], {
      env: { ...env, STUB_FAIL_GO: "1" },
      encoding: "utf8",
    });
    assert.notEqual(failing.status, 0, "update fails when go build fails");
    assert.match(failing.stderr, /failed at step "go build"/);
    assert.match(failing.stderr, /houston\.hub/);
    assert.match(failing.stderr, /houston\.notes/);
    assert.match(failing.stderr, /remain.*unloaded/);
    const failLines = fs.readFileSync(updLog, "utf8").trim().split("\n");
    assert.ok(!failLines.some((l) => l.startsWith("launchctl bootstrap")), "no bootstrap after failed go build");

    // No go on PATH is refused before any bootout (clean PATH: /usr/bin/go exists here).
    fs.writeFileSync(updLog, "");
    const noGoStubs = path.join(scratch, "notes-update-nogo");
    fs.mkdirSync(noGoStubs);
    for (const tool of ["bash", "sh", "mkdir", "mktemp", "mv", "rm", "id", "tr", "dirname", "chmod"]) {
      for (const d of ["/usr/bin", "/bin"]) {
        const src = path.join(d, tool);
        if (fs.existsSync(src)) {
          try { fs.symlinkSync(src, path.join(noGoStubs, tool)); } catch {}
          break;
        }
      }
    }
    makeStub(
      noGoStubs,
      "launchctl",
      `printf 'launchctl %s\\n' "$*" >> ${JSON.stringify(updLog)}\nexit 0`,
    );
    makeStub(
      noGoStubs,
      "git",
      `printf 'git %s\\n' "$*" >> ${JSON.stringify(updLog)}\nexit 0`,
    );
    makeStub(
      noGoStubs,
      "npm",
      `printf 'npm %s\\n' "$*" >> ${JSON.stringify(updLog)}\nexit 0`,
    );
    const noGo = spawnSync(updateScript, [], {
      env: { HOME: notesHome, PATH: noGoStubs },
      encoding: "utf8",
    });
    assert.notEqual(noGo.status, 0, "update without go is refused");
    assert.match(noGo.stderr, /Go 1\.26/i);
    assert.equal(fs.readFileSync(updLog, "utf8"), "", "no bootout before missing-go refusal");
  }

  console.log("PASS install-services and update scripts: hub, notes, plistlib, guards, and update order/recovery");
} finally {
  // The notes update test mkdirs the checkout's notes/bin (ignored by git);
  // remove it when this branch has no notes/ of its own.
  const checkoutNotesBin = path.join(root, "notes", "bin");
  try {
    const st = fs.statSync(path.join(root, "notes"));
    void st;
  } catch {
    fs.rmSync(path.join(root, "notes"), { recursive: true, force: true });
  }
  if (fs.existsSync(checkoutNotesBin)) {
    try {
      const entries = fs.readdirSync(checkoutNotesBin);
      if (entries.length === 1 && entries[0] === "houston") {
        fs.rmSync(checkoutNotesBin, { recursive: true, force: true });
        try {
          if (fs.readdirSync(path.join(root, "notes")).length === 0) {
            fs.rmdirSync(path.join(root, "notes"));
          }
        } catch {}
      }
    } catch {}
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}
