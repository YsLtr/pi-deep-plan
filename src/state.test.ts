// node --test --experimental-strip-types src/state.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import * as path from "node:path";

import { FILE_MUTATION_TOOLS, collectAnchors, INACTIVE, extractWriteTarget, isWriteAllowed, planLink } from "./state.ts";
import type { PlanState } from "./state.ts";

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

// Regression: `replace_match` / `copy` / `move` are real registered tools from
// pi-hashline-edit-pro. Leaving them out let a planning-phase call through untouched.
test("gate covers the whole anchored editor family", () => {
	for (const name of ["edit", "write", "replace", "replace_match", "insert", "copy", "move", "undo_last_change"]) {
		assert.ok(FILE_MUTATION_TOOLS.has(name), `${name} must be gated`);
	}
});

// Regression: these tools resolve their file from the anchor registry and their `path`
// field is optional/rejected, so the gate must ask the registry instead of returning
// "unknown target" — that block is what a user hit on a `replace <plan-doc>` call.
test("extractWriteTarget resolves anchored edits through the resolver", () => {
	const plan = path.resolve("/repo/docs/plans/p.md");
	const resolve = (anchor: string) => (anchor === "ryax" ? plan : undefined);

	// Both anchors own the same file.
	const ownBoth = (anchor: string) => (anchor === "zzzz" || anchor === "ryax" ? plan : undefined);
	assert.equal(extractWriteTarget("replace", { remove_from: "ryax", remove_to: "zzzz", text: "x" }, ownBoth), plan);
	assert.equal(extractWriteTarget("insert", { anchor: "ryax", direction: "after", text: "x" }, resolve), plan);
	// Served rows carry `HASH│content`; only the anchor half is meaningful.
	assert.equal(extractWriteTarget("replace", { remove_from: "ryax│some text", remove_to: "zzzz" }, ownBoth), plan);
	// A partly-unresolvable or mixed set must not borrow the one anchor that resolved:
	// the real target is unproven, so the gate has to fail closed.
	assert.equal(extractWriteTarget("replace", { remove_from: "ryax", remove_to: "zzzz" }, resolve), "");
	assert.equal(
		extractWriteTarget(
			"copy",
			{ source_from: "ryax", source_to: "zzzz", insert_after: "aaaa" },
			(a) => (a === "aaaa" ? path.resolve("/repo/other.md") : plan),
		),
		"",
	);
	// Explicit path wins: this is the self-owned tools' shape.
	assert.equal(extractWriteTarget("write", { path: "/other/x.md" }), "/other/x.md");
});

test("extractWriteTarget reports unidentifiable and foreign calls distinctly", () => {
	// A stale/unknown anchor must not be mistaken for an allowed target.
	assert.equal(extractWriteTarget("replace", { remove_from: "ryax", remove_to: "zzzz" }, () => undefined), "");
	assert.equal(extractWriteTarget("replace", { text: "x" }, () => undefined), "");
	// No resolver (host without the anchor editor) must not crash or fail open.
	assert.equal(extractWriteTarget("replace", { remove_from: "ryax" }), "");
	// Foreign tools stay unknown so the gate leaves them alone.
	assert.equal(extractWriteTarget("anchor_grep", { pattern: "x" }), undefined);
});

// Stage one is scoped to documents, stage two to everything but documents. That split is
// what keeps the doc-only commit and the repo commit from overlapping.
test("isWriteAllowed scopes each stage to its own side of docs/", () => {
	const cwd = path.resolve("/repo");
	const state: PlanState = { ...INACTIVE, active: true, phase: "writing" };
	const docs = path.join(cwd, "docs");
	const src = path.join(cwd, "src/index.ts");

	// Stage one: the whole docs tree, nested included, plus scratch.
	assert.ok(isWriteAllowed(state, path.join(docs, "README.md"), cwd));
	assert.ok(isWriteAllowed(state, path.join(docs, "plans/p.md"), cwd));
	assert.ok(isWriteAllowed(state, path.join(cwd, ".pi/tmp/report.md"), cwd));
	assert.ok(!isWriteAllowed(state, src, cwd));
	assert.ok(!isWriteAllowed(state, path.join(cwd, "README.md"), cwd));
	assert.ok(!isWriteAllowed(state, path.join(cwd, "AGENTS.md"), cwd));
	// A sibling directory whose name merely starts with "docs" is not the docs tree.
	assert.ok(!isWriteAllowed(state, path.join(cwd, "docsite/x.md"), cwd));

	// Stage two: the repo, with docs frozen so the second commit stays code-only.
	const exec: PlanState = { ...state, phase: "executing" };
	assert.ok(isWriteAllowed(exec, src, cwd));
	assert.ok(isWriteAllowed(exec, path.join(cwd, "AGENTS.md"), cwd));
	assert.ok(!isWriteAllowed(exec, path.join(docs, "plans/p.md"), cwd));
	assert.ok(isWriteAllowed(exec, path.join(cwd, ".pi/tmp/report.md"), cwd));
});

// The gate learns anchor->file from read output. If the row format drifts, every
// anchored edit silently becomes "unknown target" again, so pin it here.
test("collectAnchors reads served and diff rows, ignores prose", () => {
	const SEP = "\u2502";
	const map = new Map<string, string>();
	const out = [
		"some preamble",
		`ryax${SEP}content here`,
		`  abCD${SEP}indented row`,
		`+EFgh${SEP}added`,
		`-IJkl${SEP}removed`,
		"line 12: 12 " + SEP + " not an anchor",
		`ab1c${SEP}digits are not anchors`,
		`abc${SEP}too short`,
	].join("\n");
	collectAnchors(out, "/repo/a.md", map);

	assert.deepEqual(
		[...map.entries()].sort(),
		[
			["EFgh", "/repo/a.md"],
			["IJkl", "/repo/a.md"],
			["abCD", "/repo/a.md"],
			["ryax", "/repo/a.md"],
		].sort(),
	);
});
