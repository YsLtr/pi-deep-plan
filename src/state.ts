/**
 * Deep Plan — state, phase model, and path resolution.
 *
 * Phase model:
 *   planning  → hard write gate active (only the plan document is writable)
 *   review    → plan written, awaiting user approval; gate still active
 *   executing → gate lifted, full tool access
 *   (inactive → no gate at all; normal Pi behavior)
 */

import * as fs from "node:fs";
import { pathToFileURL } from "node:url";
import * as path from "node:path";

export type Phase = "planning" | "review" | "executing";

export const PLANS_SUBDIR = path.join("docs", "plans");
export const SCRATCH_SUBDIR = path.join(".pi", "tmp");

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
export interface PlanState {
	active: boolean;
	phase: Phase;
	/** Absolute path of the plan document; the only writable file while gated. */
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
}

export const INACTIVE: PlanState = {
	active: false,
	phase: "planning",
	decisions: [],
	variables: [],
	tasks: [],
	taskTitle: undefined,
	taskScope: undefined,
	scratchAllow: true,
};

/** Edit-family tools that mutate the workspace. */
export const FILE_MUTATION_TOOLS = new Set([
	"edit",
	"write",
	"replace",
	"insert",
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
 * Resolve the plan document path. Prefers `<repo-root>/docs/plans/<date>-<slug>.md`.
 * Never returns a path that already exists — appends -2, -3, ... instead.
 */
export function resolvePlanPath(cwd: string, goal: string): string {
	const dir = path.join(cwd, PLANS_SUBDIR);
	fs.mkdirSync(dir, { recursive: true });
	const stem = `${todayStamp()}-${slugify(goal)}`;
	let candidate = path.join(dir, `${stem}.md`);
	let n = 2;
	while (fs.existsSync(candidate)) {
		candidate = path.join(dir, `${stem}-${n}.md`);
		n++;
		if (n > 999) throw new Error("Could not allocate a unique plan path");
	}
	return candidate;
}

/**
 * Markdown link to `target` with a file:// href, so Pi renders it as a clickable OSC 8
 * hyperlink (`terminal.hyperlinks`) instead of a path the user has to copy. Label is
 * relative to `cwd` for readability.
 */
export function planLink(cwd: string, target: string): string {
	const label = path.relative(cwd, target) || target;
	// ponytail: pathToFileURL leaves ")" unencoded, which would close the markdown
	// destination; wrap the href in <> if a cwd containing parentheses ever shows up.
	return `[${label.replace(/\\/g, "/")}](${pathToFileURL(target).href})`;
}

/** Count top-level plan documents (archive excluded) — used to report leftovers. */
export function countTopLevelPlans(cwd: string): number {
	const dir = path.join(cwd, PLANS_SUBDIR);
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return 0;
	}
	let n = 0;
	for (const name of names) {
		if (!name.endsWith(".md")) continue;
		try {
			if (fs.statSync(path.join(dir, name)).isFile()) n++;
		} catch {
			/* ignore */
		}
	}
	return n;
}

export function resolveScratchDir(cwd: string): string {
	const dir = path.join(cwd, SCRATCH_SUBDIR);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * Is `target` allowed to be written while the gate is active?
 * Allowed: the plan document itself, and files under the scratch directory.
 */
export function isWriteAllowed(state: PlanState, target: string, cwd: string): boolean {
	if (!state.active) return true;
	if (state.phase === "executing") return true;
	const resolved = path.resolve(cwd, target);
	if (state.planPath !== undefined && path.resolve(state.planPath) === resolved) return true;
	if (state.scratchAllow) {
		const scratch = path.resolve(cwd, SCRATCH_SUBDIR);
		const rel = path.relative(scratch, resolved);
		if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) return true;
	}
	return false;
}

/** Extract a filesystem path from a tool call's input, or undefined for pathless calls. */
export function extractWriteTarget(toolName: string, input: Record<string, unknown>): string | undefined {
	switch (toolName) {
		case "write":
			return typeof input.path === "string" ? input.path : undefined;
		case "edit":
		case "read":
			return typeof input.file_path === "string"
				? input.file_path
				: typeof input.path === "string"
					? input.path
					: undefined;
		case "replace":
		case "insert":
			return typeof input.file === "string"
				? input.file
				: typeof input.path === "string"
					? input.path
					: undefined;
		case "undo_last_change":
			return typeof input.path === "string" ? input.path : undefined;
		default:
			// Unknown editors cannot be preflighted.
			return undefined;
	}
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
	};
}

export function fromPersisted(data: unknown): PlanState | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const d = data as Partial<PlanState>;
	if (typeof d.active !== "boolean") return undefined;
	const phase: Phase =
		d.phase === "review" || d.phase === "executing" || d.phase === "planning" ? d.phase : "planning";
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
	};
}
