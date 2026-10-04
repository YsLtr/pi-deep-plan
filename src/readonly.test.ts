// node --test --experimental-strip-types src/readonly.test.ts
import assert from "node:assert/strict";
import test from "node:test";

import { readOnlyVerdict } from "./readonly.ts";

// The rtk extension rewrites `cat x` to `rtk read x` before this gate sees the
// command, so rtk-native readers and harmless redirections must pass.
const ALLOWED = [
	`cd /repo && rtk ls -la && echo "---" && rtk read package.json`,
	"rtk ls -la docs/adr 2>&1 | head -60",
	"rtk recall e831a674692e",
	"rtk read todo && rtk read CONTEXT.md",
	"rtk grep -rn todo src/",
	"rtk git status",
	"du -sh docs legacy dist 2>/dev/null",
	"du -sh dist 2>&1 >/dev/null",
	"cat x 2>&-",
];

const DENIED = [
	"echo x > out.txt",
	"echo x >> /dev/null.bak",
	"du -sh x >& file",
	"du -sh x >& /tmp/f",
	"echo hi 2>&1 > out.txt",
	"rm -rf src",
	"rtk rm -rf src",
	"rtk init -g",
	"rtk config set a b",
	"rtk run 'rm -rf src'",
	"rtk test cargo test",
	"rtk err cargo test",
	"rtk summary cargo test",
	"rtk read x && rtk rm -rf y",
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
