/**
 * The two facilities around the read-only command wall, both scoped to the documentation stage.
 *
 *   - interception log: every refused command is appended to `.pi/deep-plan-blocked.log`, one
 *     JSON object per line, so the allowlist can be tuned from commands that were actually
 *     refused instead of guessed
 *   - one-time grant: a command the user approved through `deep_plan_request_allow` passes the
 *     wall exactly once; `matchesGrant` is the whole decision
 *
 * Contract: the log is append-only and never decides anything — the caller blocks whether or not
 * the append succeeds. A grant matches the command text verbatim, so a near-miss never inherits
 * an approval.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Under the project's own `.pi/`, and covered by `.gitignore`'s `*.log`. */
const BLOCKED_LOG = path.join(".pi", "deep-plan-blocked.log");

export interface BlockedRecord {
	/** ISO 8601. */
	at: string;
	/** Phase the wall was armed in. The wall exists only in the documentation stage. */
	phase: string;
	/** Tool that carried the command, `bash` or `powershell`. */
	tool: string;
	/** Command text as submitted, verbatim. */
	command: string;
	/** Refusal reason, as returned by the read-only verdict. */
	reason: string;
}

export function blockedLogFile(cwd: string): string {
	return path.join(cwd, BLOCKED_LOG);
}

/**
 * Append one refusal as a single JSON line. Newlines in the command are escaped by
 * `JSON.stringify`, so one refusal is always one line.
 *
 * Throws on I/O failure: a silent loss of the record is not distinguishable from "nothing was
 * refused". The gate catches, reports, and still refuses the command.
 */
export function recordBlocked(cwd: string, record: BlockedRecord): void {
	const file = blockedLogFile(cwd);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
}

/** A grant is bound to the exact command, so a longer or altered command is a different command. */
export function matchesGrant(grant: string | undefined, command: string): boolean {
	return grant !== undefined && grant === command.trim();
}
