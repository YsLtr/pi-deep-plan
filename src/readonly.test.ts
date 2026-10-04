// node --test --experimental-strip-types src/readonly.test.ts
import assert from "node:assert/strict";
import test from "node:test";

import { readOnlyVerdict } from "./readonly.ts";

// Harmless redirections and env-prefixed commands must pass; real writers must not.
const ALLOWED = [
	`cd /repo && ls -la && echo "---" && cat package.json`,
	"ls -la docs/adr 2>&1 | head -60",
	"head -25 tests/diag/selectors.js && echo '=== pkg ===' && cat package.json",
	"grep -rn todo src/",
	"git status",
	"du -sh docs legacy dist 2>/dev/null",
	"du -sh dist 2>&1 >/dev/null",
	`FOO=1 grep -rn "selectors" tests scripts package.json 2>/dev/null | head -10`,
	"cat x 2>&-",
];

const DENIED = [
	"echo x > out.txt",
	"echo x >> /dev/null.bak",
	"du -sh x >& file",
	"du -sh x >& /tmp/f",
	"echo hi 2>&1 > out.txt",
	"rm -rf src",
];

test("readers pass the planning gate", () => {
	for (const cmd of ALLOWED) {
		const v = readOnlyVerdict(cmd);
		assert.equal(v.ok, true, `${cmd} → ${v.reason}`);
	}
});

test("writers and unknown commands stay blocked", () => {
	for (const cmd of DENIED) {
		assert.equal(readOnlyVerdict(cmd).ok, false, cmd);
	}
});
