// node --test --experimental-strip-types src/state.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import * as path from "node:path";

import { planLink } from "./state.ts";

// A plan link must be a markdown link with a file:// href, otherwise Pi prints a plain path
// and nothing is clickable in the terminal.
test("planLink builds a clickable markdown link (windows)", { skip: process.platform !== "win32" }, () => {
	assert.equal(
		planLink(String.raw`C:\repo`, String.raw`C:\repo\docs\plans\2026-10-04-x.md`),
		"[docs/plans/2026-10-04-x.md](file:///C:/repo/docs/plans/2026-10-04-x.md)",
	);
});

test("planLink builds a clickable markdown link (posix)", { skip: process.platform === "win32" }, () => {
	assert.equal(planLink("/repo", "/repo/docs/plans/x.md"), "[docs/plans/x.md](file:///repo/docs/plans/x.md)");
});

test("planLink keeps a path outside cwd absolute", () => {
	assert.match(planLink("/repo", "/other/x.md"), /^\[\.\.\/other\/x\.md\]\(file:\/\/\/.*x\.md\)$/);
});

// Regression: pathToFileURL() percent-encodes non-ASCII, and herdr 0.9.3 ignores
// percent-encoded file:// clicks. The href must stay raw.
test("planLink keeps non-ascii hrefs percent-decoded", () => {
	const cwd = path.resolve("/repo");
	const link = planLink(cwd, path.join(cwd, "docs/plans/2026-10-05-修复-卡片丢失.md"));
	assert.match(link, /\(file:\/\/\/.*2026-10-05-修复-卡片丢失\.md\)$/);
	assert.ok(!link.includes("%"), link);
});
