// node --test --experimental-strip-types src/intercept.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { blockedLogFile, matchesGrant, recordBlocked } from "./intercept.ts";

test("matchesGrant accepts the identical command only", () => {
	assert.equal(matchesGrant("rm -rf x", "rm -rf x"), true, "identical text");
	assert.equal(matchesGrant("rm -rf x", "  rm -rf x  "), true, "surrounding whitespace is not part of the command");
	assert.equal(matchesGrant("rm -rf x", "rm -rf x && ls"), false, "a longer command is a different command");
	assert.equal(matchesGrant("rm -rf x", "rm -rf X"), false, "a different command is not covered");
	assert.equal(matchesGrant(undefined, "rm -rf x"), false, "no grant approves nothing");
});

test("recordBlocked appends one JSON line per refusal under .pi", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dp-blocked-"));
	try {
		recordBlocked(cwd, {
			at: "2026-01-01T00:00:00.000Z",
			phase: "writing",
			tool: "bash",
			command: "rm -rf x\necho y",
			reason: "被禁止的命令: rm",
		});
		recordBlocked(cwd, {
			at: "2026-01-01T00:01:00.000Z",
			phase: "writing",
			tool: "powershell",
			command: "git commit -m x",
			reason: "不在只读白名单: git",
		});

		assert.equal(blockedLogFile(cwd), path.join(cwd, ".pi", "deep-plan-blocked.log"));
		const lines = fs.readFileSync(blockedLogFile(cwd), "utf8").trimEnd().split("\n");
		assert.equal(lines.length, 2, "a multi-line command still occupies exactly one line");
		assert.deepEqual(JSON.parse(lines[0]!), {
			at: "2026-01-01T00:00:00.000Z",
			phase: "writing",
			tool: "bash",
			command: "rm -rf x\necho y",
			reason: "被禁止的命令: rm",
		});
		assert.equal(JSON.parse(lines[1]!).tool, "powershell", "the second refusal is appended, not overwritten");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
