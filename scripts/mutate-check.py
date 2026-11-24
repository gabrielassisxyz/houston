#!/usr/bin/env python3
"""Break one guard on purpose and check that a test goes red: the proof that the test can fail.

    scripts/mutate-check.py <port> <test-script> <file> '<exact old text>' '<new text>'
    scripts/mutate-check.py 3211 scripts/test-br-store.mjs lib/br.ts 'status === "tombstone"' 'status === "never"'

It replaces <old> with <new> in <file>, rebuilds, runs the test through scripts/with-server.sh,
and puts the file back. The restore is in a `finally`, so a failed build or an interrupted run
never leaves the mutant in the tree. Run it from the repository root.

Exit codes: 0 the test went red (the guard works); 1 the test stayed green (it cannot fail for
this); 2 the mutation did not apply or did not build, which says nothing about the guard. After
the last mutation, rebuild before trusting any other result: the build on disk is the mutant's.
"""
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    if len(sys.argv) != 6:
        print(__doc__)
        return 2
    port, test, rel, old, new = sys.argv[1:6]
    target = ROOT / rel
    original = target.read_text()
    if original.count(old) != 1:
        print(f"MUTATION NOT APPLIED: expected one occurrence of {old!r}, found {original.count(old)}")
        return 2
    try:
        target.write_text(original.replace(old, new))
        build = subprocess.run(["npm", "run", "build"], cwd=ROOT, capture_output=True, text=True)
        if build.returncode != 0:
            print("MUTANT DID NOT BUILD (inconclusive):", build.stdout[-400:])
            return 2
        run = subprocess.run(
            ["bash", str(ROOT / "scripts" / "with-server.sh"), port, "node", test],
            cwd=ROOT, capture_output=True, text=True,
        )
        lines = (run.stdout + run.stderr).strip().splitlines()
        reason = next((ln for ln in lines if "Error" in ln), lines[-1] if lines else "")
        if run.returncode == 0:
            print("SURVIVED: the test stayed green with the guard broken")
            return 1
        print(f"KILLED: {reason[:200]}")
        return 0
    finally:
        target.write_text(original)


if __name__ == "__main__":
    sys.exit(main())
