/**
 * Deep Plan — state, phase model, and path resolution.
 *
 * Two phases, with different write scopes:
 *
 *   writing  → only documents are writable (the whole docs tree); git records history,
 *              so the extension keeps no dated change log of its own
 *   executing → documents are frozen, the repository is writable, gate lifted
 *   (inactive → no gate at all; normal Pi behavior)
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Documents live under `docs/`; the extension owns no other location for them. */
export const DOCS_DIRNAME = "docs";
export const SCRATCH_SUBDIR = path.join(".pi", "tmp");

/** Index of topics, so a plan can be routed to an existing document. */
export const INDEX_BASENAME = "INDEX.md";

export interface Decision {
	/** Stable id, e.g. "D1". */
	id: string;
	title: string;
	conclusion: string;
	evidence: string;
	confidence: "high" | "medium" | "low";
	alternatives?: string;
}

export interface VariableDecision {
	/** Stable id, e.g. "V1". */
	id: string;
	item: string;
	defaultValue: string;
	evidence: string;
	cost: string;
}


export type PlanTaskStatus = "planned" | "active" | "done" | "skipped" | "blocked";

export interface PlanTask {
	/** Stable id, e.g. "T1". */
	id: string;
	/** Action-oriented task title. */
	title: string;
	scope?: string;
	status: PlanTaskStatus;
	note?: string;
	startedAt?: number;
	completedAt?: number;
}
/**
 * The two stages. `writing` covers documenting the plan and ends with the doc-only commit;
 * `executing` is the repository work that follows approval.
 */
export type Phase = "writing" | "executing";

export interface PlanState {
	active: boolean;
	phase: Phase;
	/** Absolute path of the document this run is refining. */
	planPath?: string;
	/** Original request text that started the loop. */
	goal?: string;
	decisions: Decision[];
	variables: VariableDecision[];
	/** Structured execution tasks managed by deep_plan_task / deep_plan_step. */
	tasks: PlanTask[];
	/** Human-facing task title and scope, like pi-plan-build's plan_task metadata. */
	taskTitle?: string;
	taskScope?: string;
	/** Scratch dir granted a write allowance for subagent reports. */
	scratchAllow?: boolean;
	startedAt?: number;
	approvedAt?: number;
	/**
	 * Why the last execution run was stopped early, when a document conflict sent it back to
	 * the documentation stage. Cleared by the next `deep_plan_approve`.
	 */
	haltReason?: string;
}

export const INACTIVE: PlanState = {
	active: false,
	phase: "writing",
	decisions: [],
	variables: [],
	tasks: [],
	taskTitle: undefined,
	taskScope: undefined,
	scratchAllow: true,
};

/** Separator between an anchor and its row content in a served `HASH│content` row. */
const HASH_SEP = "│";

/**
 * Tools that mutate the workspace through the file-anchor family.
 *
 * `replace_match` / `copy` / `move` come from pi-hashline-edit-pro and are registered
 * names, not hypothetical: leaving them out made the gate pass them through untouched.
 */
export const FILE_MUTATION_TOOLS = new Set([
	"edit",
	"write",
	"replace",
	"replace_match",
	"insert",
	"copy",
	"move",
	"undo_last_change",
]);

export function slugify(input: string, maxLen = 48): string {
	const base = input
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, maxLen)
		.replace(/-+$/g, "");
	return base || "plan";
}

export function todayStamp(now = new Date()): string {
	const y = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, "0");
	const d = String(now.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

/**
 * The docs directory for this repo.
 *
 * Deliberately fixed: documents are long-lived project docs, not per-run artifacts.
 * There is no date in the name and no archive — git holds the history.
 */
export function docsDir(cwd: string): string {
	return path.join(cwd, DOCS_DIRNAME);
}

export function indexFile(cwd: string): string {
	return path.join(docsDir(cwd), INDEX_BASENAME);
}

/** A document path is anything under `docs/`, so `..` cannot escape the tree. */
export function isDocPath(cwd: string, target: string): boolean {
	const docs = path.resolve(docsDir(cwd));
	const rel = path.relative(docs, path.resolve(cwd, target));
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Resolve which document a run should work on.
 *
 * An explicit `requested` path wins (relative paths resolve against cwd) as long as it
 * stays inside `docs/`. Otherwise the slug of the goal names the file, so re-planning the
 * same topic lands on the same document instead of creating a sibling.
 */
export function resolveDocPath(cwd: string, goal: string, requested?: string): string {
	fs.mkdirSync(docsDir(cwd), { recursive: true });
	if (requested !== undefined && requested.trim() !== "") {
		const wanted = path.resolve(cwd, requested.trim());
		if (!isDocPath(cwd, wanted)) {
			throw new Error(`文档必须位于 docs/ 下: ${requested}`);
		}
		if (path.extname(wanted) === "") return `${wanted}.md`;
		return wanted;
	}
	return path.join(docsDir(cwd), `${slugify(goal)}.md`);
}

/** Existing topic documents, for routing a plan to the right one. */
export function listDocs(cwd: string): string[] {
	const root = docsDir(cwd);
	const found: string[] = [];
	const walk = (dir: string): void => {
		let names: string[];
		try {
			names = fs.readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			if (name.startsWith(".")) continue;
			const full = path.join(dir, name);
			let stat: fs.Stats;
			try {
				stat = fs.statSync(full);
			} catch {
				continue;
			}
			if (stat.isDirectory()) walk(full);
			else if (name.endsWith(".md")) found.push(path.relative(cwd, full));
		}
	};
	walk(root);
	return found.sort();
}

/**
 * Markdown link to `target` with a raw (unencoded) file:// href, so Pi renders it as a
 * clickable OSC 8 hyperlink (`terminal.hyperlinks`) instead of a path to copy. The href
 * must stay percent-decoded or herdr ignores the click; label is relative to `cwd`.
 */
export function planLink(cwd: string, target: string): string {
	const label = path.relative(cwd, target) || target;
	// Raw (percent-decoded) href on purpose: herdr 0.9.3 activates raw file:// OSC 8
	// URIs but silently ignores percent-encoded ones, and pathToFileURL() encodes
	// every non-ASCII byte. ponytail: a literal "%" or ")" in a plan path would need
	// escaping; plan names are slugs, so skip it until one shows up.
	const slash = path.resolve(target).replace(/\\/g, "/");
	return `[${label.replace(/\\/g, "/")}](file://${slash.startsWith("/") ? "" : "/"}${slash})`;
}

/** How many topic documents exist — reported at startup so the index can be kept honest. */
export function countDocs(cwd: string): number {
	return listDocs(cwd).length;
}

export function resolveScratchDir(cwd: string): string {
	const dir = path.join(cwd, SCRATCH_SUBDIR);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * Is `target` allowed to be written in the current phase?
 *
 * Stage one (writing) is scoped to documents: anything under `docs/`, so the whole doc set
 * can be refined, plus the scratch directory for subagent reports. Stage two (executing) is
 * scoped to the repository and freezes `docs/` — that is what keeps the two commits clean,
 * and it is the same rule whether the phase gate is armed or not.
 */
export function isWriteAllowed(state: PlanState, target: string, cwd: string): boolean {
	if (!state.active) return true;
	const resolved = path.resolve(cwd, target);
	if (state.scratchAllow) {
		const scratch = path.resolve(cwd, SCRATCH_SUBDIR);
		const rel = path.relative(scratch, resolved);
		if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) return true;
	}
	if (state.phase === "executing") return !isDocPath(cwd, resolved);
	return isDocPath(cwd, resolved);
}

/**
 * Fields that carry a resolver-owned file path instead of an anchor.
 *
 * The self-owned tools take an explicit `path`. The hashline editor family
 * (`replace` / `replace_match` / `insert` / `copy` / `move`) resolves the file from
 * the anchor registry, and its `path` field is *optional and rejected* unless
 * require-path mode is on — so it must never be trusted as the target.
 */
const PATH_FIELDS = ["path", "file", "file_path"] as const;

/** Anchor-ish fields, in the order each tool family prefers them. */
const ANCHOR_FIELDS: Record<string, readonly string[]> = {
	replace: ["remove_from", "remove_to"],
	replace_match: ["replace_from", "replace_to"],
	insert: ["anchor"],
	copy: ["source_from", "source_to", "insert_after"],
	move: ["source_from", "source_to", "insert_after"],
};

function firstString(input: Record<string, unknown>, fields: readonly string[]): string | undefined {
	for (const field of fields) {
		const value = input[field];
		if (typeof value === "string" && value !== "") return value;
	}
	return undefined;
}

/**
 * Extract the target path of a file-mutating tool call.
 *
 * Returns:
 *   - the file path when the call carries one,
 *   - `""` when the tool resolves its target from anchors (`resolveTarget` is required),
 *   - `undefined` when the call is foreign or carries no usable identifier.
 *
 * `resolveTarget` is how a host that owns the anchor registry lets the gate see the
 * path of an anchor-addressed edit. Without it those tools report `""` and the caller
 * must decide whether to block or stay out of the way.
 */
export function extractWriteTarget(
	toolName: string,
	input: Record<string, unknown>,
	resolveTarget?: (anchor: string) => string | undefined,
): string | undefined {
	const explicit = firstString(input, PATH_FIELDS);
	if (explicit !== undefined) return explicit;

	const anchors = ANCHOR_FIELDS[toolName];
	if (anchors === undefined) return undefined; // foreign tool: no path field, no anchors
	if (resolveTarget === undefined) return "";

	// Every supplied anchor must resolve, and all to the same file. The editor itself
	// refuses a mixed or stale set, so returning a partial match would let a call whose
	// real target is unproven look like a write to the one file that did resolve.
	const owners = new Set<string>();
	for (const field of anchors) {
		const anchor = firstString(input, [field]);
		if (anchor === undefined) continue;
		// Anchors arrive either bare or as a served `HASH│content` row.
		const resolved = resolveTarget(anchor.split(HASH_SEP)[0]!.trim());
		if (resolved === undefined || resolved === "") return "";
		owners.add(path.resolve(resolved));
	}
	return owners.size === 1 ? [...owners][0]! : "";
}

const STATE_ENTRY_TYPE = "pi-deep-plan-state";

export function stateEntryType(): string {
	return STATE_ENTRY_TYPE;
}

/** Serialize only plain data so appendEntry stays safe across reloads. */
export function toPersisted(state: PlanState): PlanState {
	return {
		active: state.active,
		phase: state.phase,
		planPath: state.planPath,
		goal: state.goal,
		decisions: state.decisions,
		variables: state.variables,
		tasks: state.tasks,
		taskTitle: state.taskTitle,
		taskScope: state.taskScope,
		scratchAllow: state.scratchAllow,
		startedAt: state.startedAt,
		approvedAt: state.approvedAt,
		haltReason: state.haltReason,
	};
}

export function fromPersisted(data: unknown): PlanState | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const d = data as Partial<PlanState>;
	if (typeof d.active !== "boolean") return undefined;
	// Old sessions used planning/review/executing. Both document stages collapse into
	// `writing`; a half-documented plan resumes as documentation work, which is safe.
	const phase: Phase = d.phase === "executing" ? "executing" : "writing";
	return {
		active: d.active,
		phase,
		planPath: typeof d.planPath === "string" ? d.planPath : undefined,
		goal: typeof d.goal === "string" ? d.goal : undefined,
		decisions: Array.isArray(d.decisions) ? (d.decisions as Decision[]) : [],
		variables: Array.isArray(d.variables) ? (d.variables as VariableDecision[]) : [],
		tasks: Array.isArray(d.tasks) ? (d.tasks as PlanTask[]) : [],
		taskTitle: typeof d.taskTitle === "string" ? d.taskTitle : undefined,
		taskScope: typeof d.taskScope === "string" ? d.taskScope : undefined,
		scratchAllow: d.scratchAllow !== false,
		startedAt: typeof d.startedAt === "number" ? d.startedAt : undefined,
		approvedAt: typeof d.approvedAt === "number" ? d.approvedAt : undefined,
		haltReason: typeof d.haltReason === "string" ? d.haltReason : undefined,
	};
}

/** Served rows are `aBcD│content`; diff rows are `+aBcD│` / `-aBcD│`. */
const SERVED_ROW_RE = /^\s*[+-]?([A-Za-z]{4})│/;

/**
 * Collect `anchor -> file` from a read result's text, so the gate can tell which file an
 * anchor-addressed edit (`replace` / `insert` / ...) is about to write.
 *
 * Pi gives every package its own module root, so reaching into the anchor editor's
 * registry is not possible; the served rows in the transcript are the available signal.
 */
export function collectAnchors(text: string, filePath: string, into: Map<string, string>): void {
	for (const line of text.split("\n")) {
		const match = SERVED_ROW_RE.exec(line);
		if (match !== null) into.set(match[1]!, filePath);
	}
}
