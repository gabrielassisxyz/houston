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

  console.log("PASS install-services and update scripts: syntax, plistlib, --print, idempotent install, guards, and update order/recovery");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
