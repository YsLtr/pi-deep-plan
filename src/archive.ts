/**
 * Plan document lifecycle: frontmatter stamping, archiving, and garbage collection.
 *
 * Invariant: `docs/plans/` top level holds only active plans. Finished or
 * abandoned plans are stamped and moved under `docs/plans/archive/<year>/`.
 *
 * The plan body is authored by the model; the extension owns the frontmatter and
 * (re)stamps it at phase transitions, so a later `write` by the model cannot
 * silently drop lifecycle metadata — the next transition restores it.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { PLANS_SUBDIR } from "./state.ts";

export const ARCHIVE_DIRNAME = "archive";

export type PlanStatus = "draft" | "review" | "approved" | "done" | "abandoned";

export interface PlanFrontmatter {
	title?: string;
	status?: PlanStatus;
	/** ISO date (YYYY-MM-DD) the plan was created. */
	created?: string;
	/** Pi session id that produced the plan. */
	session?: string;
	approved?: string;
	completed?: string;
	archived?: string;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Minimal `key: value` frontmatter parser — no YAML dependency needed. */
export function parseFrontmatter(body: string): { fm: PlanFrontmatter; rest: string } {
	const m = FM_RE.exec(body);
	if (m === null) return { fm: {}, rest: body };
	const fm: Record<string, string> = {};
	for (const line of m[1]!.split(/\r?\n/)) {
		const idx = line.indexOf(":");
		if (idx <= 0) continue;
		const key = line.slice(0, idx).trim();
		let value = line.slice(idx + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
			(value.startsWith("'") && value.endsWith("'") && value.length >= 2)
		) {
			value = value.slice(1, -1);
		}
		if (key !== "" && value !== "") fm[key] = value;
	}
	return { fm: fm as PlanFrontmatter, rest: body.slice(m[0].length) };
}

const FIELD_ORDER: (keyof PlanFrontmatter)[] = [
	"title",
	"status",
	"created",
	"session",
	"approved",
	"completed",
	"archived",
];

export function renderFrontmatter(fm: PlanFrontmatter, body: string): string {
	const lines: string[] = ["---"];
	for (const key of FIELD_ORDER) {
		const value = fm[key];
		if (value === undefined || value === "") continue;
		// Quote values that could confuse a YAML reader or contain a colon.
		const needsQuote = /[:#"']/.test(value) || value !== value.trim();
		lines.push(`${key}: ${needsQuote ? JSON.stringify(value) : value}`);
	}
	lines.push("---", "");
	const trimmed = body.replace(/^\s*\n+/, "");
	return `${lines.join("\n")}${trimmed}`;
}

/** Replace existing frontmatter with `patch` merged over whatever is already there. */
export function upsertFrontmatter(body: string, patch: PlanFrontmatter): string {
	const { fm, rest } = parseFrontmatter(body);
	const merged: PlanFrontmatter = { ...fm };
	for (const [k, v] of Object.entries(patch)) {
		if (v !== undefined && v !== "") (merged as Record<string, unknown>)[k] = v;
	}
	return renderFrontmatter(merged, rest);
}

export function isoDate(when = new Date()): string {
	const y = when.getFullYear();
	const m = String(when.getMonth() + 1).padStart(2, "0");
	const d = String(when.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

export function yearOf(when = new Date()): string {
	return String(when.getFullYear());
}

/**
 * Stamp the plan file's frontmatter. Missing files are skipped rather than
 * created — an absent plan is the caller's problem to report.
 * Returns the file content length, or undefined when the file was absent.
 */
export async function stampPlanFile(
	filePath: string,
	patch: PlanFrontmatter,
): Promise<number | undefined> {
	return withFileMutationQueue(filePath, async () => {
		let body: string;
		try {
			body = await fs.readFile(filePath, "utf8");
		} catch {
			return undefined;
		}
		const next = upsertFrontmatter(body, patch);
		await fs.writeFile(filePath, next, "utf8");
		return next.length;
	});
}

/** Destination path for archiving: `<plansRoot>/archive/<year>/<basename>`. */
export function archivePathFor(planPath: string, when = new Date()): string {
	const plansRoot = path.dirname(path.resolve(planPath));
	return path.join(plansRoot, ARCHIVE_DIRNAME, yearOf(when), path.basename(planPath));
}

async function uniquePath(candidate: string): Promise<string> {
	let target = candidate;
	let n = 2;
	for (;;) {
		try {
			await fs.access(target);
		} catch {
			return target;
		}
		const dir = path.dirname(candidate);
		const ext = path.extname(candidate);
		const stem = path.basename(candidate, ext);
		target = path.join(dir, `${stem}-${n}${ext}`);
		if (n++ > 999) throw new Error(`Could not allocate a unique archive path for ${candidate}`);
	}
}

/** Move a plan into the archive. Returns the new path, or undefined if absent. */
export async function archivePlan(planPath: string, when = new Date()): Promise<string | undefined> {
	const source = path.resolve(planPath);
	try {
		await fs.access(source);
	} catch {
		return undefined;
	}
	const target = await uniquePath(archivePathFor(source, when));
	await fs.mkdir(path.dirname(target), { recursive: true });
	try {
		await fs.rename(source, target);
	} catch {
		// Cross-device or locked file: fall back to copy + unlink.
		await fs.copyFile(source, target);
		await fs.unlink(source);
	}
	return target;
}

// ---------------------------------------------------------------------- gc

export interface GcEntry {
	filePath: string;
	status: string;
	/** Whole days since `completed` frontmatter date, else file mtime. */
	ageDays: number;
	title?: string;
	/** True when this entry would be moved by an apply run. */
	eligible: boolean;
	reason: string;
}

export interface GcOptions {
	/** Only move plans finished at least this many days ago. Default 30. */
	retentionDays?: number;
	now?: Date;
}

const TERMINAL: ReadonlySet<string> = new Set(["done", "abandoned"]);

/** Read top-level plans (archive excluded) and classify each one. */
export async function scanPlans(cwd: string, options: GcOptions = {}): Promise<GcEntry[]> {
	const retention = options.retentionDays ?? 30;
	const now = options.now ?? new Date();
	const root = path.join(cwd, PLANS_SUBDIR);
	let names: string[];
	try {
		names = await fs.readdir(root);
	} catch {
		return [];
	}
	const entries: GcEntry[] = [];
	for (const name of names) {
		if (!name.endsWith(".md")) continue;
		const filePath = path.join(root, name);
		const stat = await fs.stat(filePath).catch(() => undefined);
		if (stat === undefined || !stat.isFile()) continue;
		let body = "";
		try {
			body = await fs.readFile(filePath, "utf8");
		} catch {
			continue;
		}
		const { fm } = parseFrontmatter(body);
		const status = fm.status ?? "(无状态)";
		let ageDays: number;
		if (fm.completed !== undefined) {
			const when = new Date(fm.completed);
			ageDays = Number.isNaN(when.getTime())
				? Math.floor((now.getTime() - stat.mtimeMs) / 86_400_000)
				: Math.floor((now.getTime() - when.getTime()) / 86_400_000);
		} else {
			ageDays = Math.floor((now.getTime() - stat.mtimeMs) / 86_400_000);
		}
		let eligible = false;
		let reason: string;
		if (!TERMINAL.has(status)) {
			reason = "仍在活跃状态,保留";
		} else if (ageDays < retention) {
			reason = `完成仅 ${ageDays} 天(< ${retention}),保留`;
		} else {
			eligible = true;
			reason = `已 ${status} ${ageDays} 天,归档`;
		}
		entries.push({ filePath, status, ageDays, title: fm.title, eligible, reason });
	}
	return entries.sort((a, b) => b.ageDays - a.ageDays);
}

export interface GcResult {
	archived: string[];
	failed: { filePath: string; error: string }[];
	kept: number;
}

/** Move every eligible plan into the archive. */
export async function applyGc(entries: GcEntry[], now = new Date()): Promise<GcResult> {
	const archived: string[] = [];
	const failed: { filePath: string; error: string }[] = [];
	let kept = 0;
	for (const entry of entries) {
		if (!entry.eligible) {
			kept++;
			continue;
		}
		try {
			await stampPlanFile(entry.filePath, { archived: isoDate(now) });
			const target = await archivePlan(entry.filePath, now);
			if (target === undefined) {
				kept++;
				continue;
			}
			archived.push(target);
		} catch (error) {
			failed.push({ filePath: entry.filePath, error: String(error) });
		}
	}
	return { archived, failed, kept };
}
