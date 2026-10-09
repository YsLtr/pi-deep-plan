/**
 * Document frontmatter.
 *
 * The extension owns only the small metadata header of a document; the body is the model's
 * work. There is no archiving and no dated history: documents are long-lived project docs
 * and git holds the changes. The header is re-stamped at stage transitions, so a later
 * `write` by the model cannot silently drop it.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

/** `writing` while documents are being refined; `approved` once execution may start. */
export type DocStatus = "writing" | "approved";

export interface DocFrontmatter {
	title?: string;
	status?: DocStatus;
	updated?: string;
	approved?: string;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Minimal `key: value` frontmatter parser — no YAML dependency needed. */
export function parseFrontmatter(body: string): { fm: Record<string, string>; rest: string } {
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
	return { fm, rest: body.slice(m[0].length) };
}

const FIELD_ORDER: (keyof DocFrontmatter)[] = [
	"title",
	"status",
	"updated",
	"approved",
];

export function renderFrontmatter(fm: Record<string, string>, body: string): string {
	if (Object.keys(fm).length === 0) return body.replace(/^\s*\n+/, "");
	const lines: string[] = ["---"];
	for (const key of FIELD_ORDER) {
		const value = fm[key as string];
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
export function upsertFrontmatter(body: string, patch: DocFrontmatter): string {
	const { fm, rest } = parseFrontmatter(body);
	const merged: Record<string, string> = { ...fm };
	for (const [k, v] of Object.entries(patch)) {
		if (v !== undefined && v !== "") merged[k] = String(v);
	}
	return renderFrontmatter(merged, rest);
}

/**
 * The document body without its frontmatter. Existence checks must ignore the header: a
 * document whose body is still empty is not a documented plan, however it is stamped.
 */
export function bodyOf(body: string): string {
	return parseFrontmatter(body).rest.trim();
}

export function isoDate(when = new Date()): string {
	const y = when.getFullYear();
	const m = String(when.getMonth() + 1).padStart(2, "0");
	const d = String(when.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

/**
 * Stamp a document's frontmatter. A missing file is skipped rather than created — an absent
 * document is the caller's problem to report. Returns the new length, or undefined if absent.
 */
export async function stampDoc(
	filePath: string,
	patch: DocFrontmatter,
): Promise<number | undefined> {
	return withFileMutationQueue(filePath, async () => {
		let body: string;
		try {
			body = await fs.readFile(filePath, "utf8");
		} catch {
			return undefined;
		}
		const next = upsertFrontmatter(body, patch);
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, next, "utf8");
		return next.length;
	});
}
