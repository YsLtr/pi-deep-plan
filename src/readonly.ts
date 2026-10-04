/**
 * Read-only command gate for the deep-plan planning phases (P1–P3).
 *
 * Why this exists in this shape: the first version tested regexes against the raw
 * command string and split it on `|`, `&&`, `;` without understanding quoting. That
 * broke real recon commands —
 *   grep -rn "a\|b" src/            → split inside the quoted pattern
 *   wc -l $(find src -type f | sort) → left a dangling `sort)` segment
 *   cd <dir> && rg x src/            → `cd` was not allowlisted
 * while still allowing `rtk rm -rf src` and rejecting `grep "rm -rf" src/`.
 *
 * Now the command is tokenized with `shell-quote` (quote/operator aware) and every
 * simple command's argv is checked against an allowlist, following the approach of
 * codex-cli's `is_known_safe_command` (openai/codex, shell-command/command_safety).
 *
 * Contract: `null` means allowed; a string is the human-readable reason for refusal.
 * Fails closed — anything unparsed, unknown, or not provably read-only is refused.
 */
import { parse } from "shell-quote";

/** Nesting guard for `$(a $(b ...))` style recursion. */
const MAX_DEPTH = 5;

/** Stands in for a `$(...)`/backtick body while the outer command is tokenized. */
const SUBST_PLACEHOLDER = "__dp_subst__";

/** Operators that write files or spawn processes. */
const WRITE_OPS = new Set([
	">", ">>", ">|", "<>", ">&", "<&", "&>", "&>>", "<", "<<", "<<-", "<<<", ">(", "<(",
]);

/** Redirect targets that are not files: `> /dev/null` discards instead of writes. */
const NULL_DEVICE = new Set(["/dev/null", "nul"]);

/** Operators that merely separate simple commands, each checked independently. */
const SEQUENCE_OPS = new Set(["|", "|&", "&&", "||", ";", ";;", ";&", ";;&"]);

/** Refused outright: they write, delete, elevate, or execute arbitrary programs. */
const DENIED_BINARIES = new Set([
	"sudo", "doas", "su", "runas", "eval", "exec", "source",
	"rm", "rmdir", "mv", "cp", "mkdir", "touch", "install", "patch", "rsync",
	"chmod", "chown", "chgrp", "ln", "mkfifo", "mknod", "truncate", "dd", "shred", "sponge",
	"tee", "xargs",
	"kill", "pkill", "killall", "reboot", "shutdown", "systemctl", "service", "crontab", "at",
	"mount", "umount", "tar", "zip", "unzip", "gzip", "gunzip",
	"bash", "sh", "zsh", "fish", "cmd", "powershell", "pwsh",
]);


/** Read-only regardless of arguments (write-capable flags are checked in checkArgs). */
const READ_ONLY_BINARIES = new Set([
	// file inspection
	"cat", "head", "tail", "less", "more", "nl", "tac", "wc", "file", "stat", "du", "df",
	"tree", "ls", "pwd", "realpath", "readlink", "basename", "dirname", "strings", "xxd", "od",
	// text processing
	"sort", "uniq", "cut", "tr", "column", "sed", "awk", "jq", "yq", "comm", "join", "paste",
	"diff", "expr", "seq", "test", "[", "true", "false", ":",
	// search
	"rg", "grep", "ag", "ack", "fd", "find", "which", "where", "whereis", "type",
	// environment / system inspection
	"echo", "printf", "env", "printenv", "uname", "whoami", "id", "hostname", "date", "cal",
	"uptime", "ps", "top", "htop", "free", "man", "info", "lesspipe",
	// checksums
	"md5sum", "sha1sum", "sha256sum", "cksum",
	// vcs / package metadata (subcommand-checked in checkArgs)
	"git", "npm", "pnpm", "yarn", "bun", "cargo", "go", "node", "python", "python3", "py",
	// rtk wraps another command; the wrapped one is validated
	"rtk",
	// changing directory is harmless
	"cd",
]);

// ---------------------------------------------------------------- entry points

export interface ReadOnlyVerdict {
	ok: boolean;
	reason: string;
}

/** Check a shell command; returns whether it may run during the gated phases. */
export function readOnlyVerdict(command: string): ReadOnlyVerdict {
	const trimmed = command.trim();
	if (trimmed === "") return { ok: false, reason: "空命令" };
	const reason = checkCommand(trimmed, 0);
	return reason === null ? { ok: true, reason: "" } : { ok: false, reason };
}

export function isReadOnlyCommand(command: string): boolean {
	return readOnlyVerdict(command).ok;
}

// ------------------------------------------------------------ command recursion

function checkCommand(command: string, depth: number): string | null {
	if (depth > MAX_DEPTH) return "嵌套过深,拒绝判定";
	const split = splitSubstitutions(command);
	if (split === null) return "无法解析命令(引号不闭合或括号不配对)";
	const outer = checkPipeline(split.outer, depth);
	if (outer !== null) return outer;
	for (const body of split.bodies) {
		if (body.trim() === "") return "空的 $() 命令替换";
		const reason = checkCommand(body, depth + 1);
		if (reason !== null) return `命令替换 $() 内含非只读命令(${reason})`;
	}
	return null;
}

function checkPipeline(src: string, depth: number): string | null {
	const groups = groupCommands(src);
	if (typeof groups === "string") return groups;
	for (const argv of groups) {
		const reason = checkArgv(argv, depth);
		if (reason !== null) return reason;
	}
	return null;
}

function groupCommands(src: string): string[][] | string {
	let entries: ReturnType<typeof parse>;
	try {
		entries = parse(src);
	} catch {
		return "无法解析命令(引号不闭合或语法错误)";
	}
	const groups: string[][] = [];
	let current: string[] = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!;
		if (typeof entry === "string") {
			if (entry !== "") current.push(entry);
			continue;
		}
		if (entry === null || typeof entry !== "object") return "无法解析命令片段";
		if ("comment" in entry) break;
		if ("pattern" in entry) {
			current.push((entry as { pattern: string }).pattern);
			continue;
		}
		const op = (entry as { op?: string }).op;
		if (op === undefined) return "无法解析命令片段";
		if (op === "(" || op === ")") return "子 shell 括号无法判定只读性";
		if (op === "&") return "后台执行(&)不允许";
		if (WRITE_OPS.has(op)) {
			if (isHarmlessRedirect(op, entries[i + 1])) continue;
			return `重定向 ${op} 会写文件`;
		}
		if (!SEQUENCE_OPS.has(op)) return `未知操作符 ${op}`;
		if (current.length > 0) {
			groups.push(current);
			current = [];
		}
	}
	if (current.length > 0) groups.push(current);
	return groups;
}

// --------------------------------------------------------------- argv checking

function checkArgv(argv: string[], depth: number): string | null {
	let i = 0;
	while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]!)) i++;
	const head = argv[i];
	// `FOO=bar` on its own spawns nothing, so it cannot write.
	if (head === undefined) return null;
	const bin = binaryName(head);
	const args = argv.slice(i + 1);

	if (DENIED_BINARIES.has(bin)) return `被禁止的命令: ${bin}`;
	if (bin === "rtk") return checkRtk(args, depth);
	if (bin === "env") {
		const rest = skipEnvOptions(args);
		// bare `env` / `env -i` only prints the environment
		return rest.length === 0 ? null : checkWrapped(rest, depth);
	}
	if (bin === "command") return checkCommandBuiltin(args, depth);
	if (bin === "pi") {
		// Spawning another agent could write; only its info flags are allowed.
		return args.every((a) => /^(-h|--help|-V|--version)$/.test(a))
			? null
			: "pi 会启动可写入的 agent,仅允许 --help/--version";
	}
	if (!READ_ONLY_BINARIES.has(bin)) return `不在只读白名单: ${bin}`;
	return checkArgs(bin, args);
}

function checkWrapped(args: string[], depth: number): string | null {
	if (args.length === 0) return "包装命令缺少实际命令";
	return checkArgv(args, depth + 1);
}

function skipEnvOptions(args: string[]): string[] {
	let i = 0;
	while (i < args.length) {
		const a = args[i]!;
		if (a === "-u" || a === "--unset") {
			i += 2;
			continue;
		}
		if (a === "--" || (a.startsWith("-") && a !== "-")) {
			i++;
			continue;
		}
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
			i++;
			continue;
		}
		break;
	}
	return args.slice(i);
}

function checkCommandBuiltin(args: string[], depth: number): string | null {
	const first = args[0];
	if (first === "-v" || first === "-V") return null; // `command -v foo` only queries
	const rest = first === "-p" ? args.slice(1) : args;
	if (rest.length === 0) return "command 缺少实际命令";
	return checkArgv(rest, depth + 1);
}

const RTK_INFO_ARGS = new Set(["--version", "-V", "--help", "-h"]);

/**
 * rtk subcommands that read on their own instead of proxying a program, so there
 * is no wrapped argv left to validate. Each one is a pure reader in `rtk --help`;
 * the state-changing ones (`run`, `init`, `trust`, `config`, `learn`, ...) and the
 * proxies (`git`, `npm`, `docker`, `test`, ...) deliberately stay out.
 */
const RTK_NATIVE_READ_ONLY = new Set([
	"gain", "hook-audit", "recall", "read", "smart", "json", "log", "deps",
]);

/**
 * rtk is a transparent proxy: `rtk grep ...` runs grep, `rtk rm -rf x` runs rm.
 * `proxy` and the runners (`test`, `err`, `summary`) take the program as their
 * first argument — `rtk test cargo test` runs cargo test, so validate the tail
 * rather than trusting the subcommand name.
 */
function checkRtk(args: string[], depth: number): string | null {
	const first = args[0];
	if (first === undefined) return "rtk 缺少子命令";
	if (RTK_INFO_ARGS.has(first) || RTK_NATIVE_READ_ONLY.has(first)) return null;
	if (first === "proxy" || first === "test" || first === "err" || first === "summary") {
		return checkWrapped(args.slice(1), depth);
	}
	return checkWrapped(args, depth);
}

// ------------------------------------------------- per-binary argument rules

const FIND_UNSAFE = /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)/;
const FD_UNSAFE = /^(-x|-X|--exec|--exec-batch)/;
const IN_PLACE = /^(--in-place|--inplace|-i)/;
const GIT_UNSAFE_GLOBAL = /^(-C|--git-dir|--work-tree|--exec-path|--namespace|--super-prefix|--config-env)/;

const GIT_READ_ONLY_SUBCOMMANDS = new Set([
	"status", "diff", "log", "show", "blame", "grep", "rev-parse", "rev-list", "describe",
	"ls-files", "ls-tree", "ls-remote", "shortlog", "show-ref", "for-each-ref", "cat-file",
	"name-rev", "whatchanged", "reflog", "count-objects", "verify-pack", "diff-tree",
	"diff-index", "diff-files", "cherry", "merge-base", "symbolic-ref", "check-ignore",
	"check-attr", "var", "version", "help",
]);

const GIT_BRANCH_READ_ONLY_FLAG =
	/^(-l|--list|-a|--all|-r|--remotes|-v|-vv|--verbose|--show-current|--contains|--no-contains|--merged|--no-merged|--points-at|--sort|--format|--column|--no-column)(=.*)?$/;

const PM_READ_ONLY_SUBCOMMANDS = new Set([
	"ls", "list", "ll", "la", "view", "info", "show", "outdated", "why", "explain",
	"doctor", "ping", "root", "prefix", "bin", "licenses", "fund",
]);

const CARGO_READ_ONLY_SUBCOMMANDS = new Set([
	"tree", "metadata", "search", "info", "pkgid", "locate-project", "verify-project", "list",
]);

const GO_READ_ONLY_SUBCOMMANDS = new Set(["env", "version", "list", "doc", "help", "tool"]);

function checkArgs(bin: string, args: string[]): string | null {
	switch (bin) {
		case "git":
			return checkGit(args);
		case "npm":
		case "pnpm":
		case "yarn":
		case "bun":
			return checkPackageManager(args);
		case "cargo":
		case "go":
			return checkToolchain(bin, args);
		case "node":
		case "python":
		case "python3":
		case "py":
			return args.some((a) => a === "-e" || a === "--eval" || a === "-c" || a === "-")
				? `${bin} 的内联执行参数会运行任意代码`
				: null;
		case "sed":
		case "yq":
			return args.some((a) => IN_PLACE.test(a)) ? `${bin} 的原地写参数 ${args.find((a) => IN_PLACE.test(a))}` : null;
		case "sort":
			return args.some((a) => a === "-o" || a.startsWith("--output"))
				? "sort 的 -o/--output 会写文件"
				: null;
		case "find":
			return args.some((a) => FIND_UNSAFE.test(a))
				? `find 的 ${args.find((a) => FIND_UNSAFE.test(a))} 会执行或删除`
				: null;
		case "fd":
			return args.some((a) => FD_UNSAFE.test(a))
				? `fd 的 ${args.find((a) => FD_UNSAFE.test(a))} 会执行命令`
				: null;
		case "rg":
		case "grep":
			return args.some((a) => a === "--pre" || a.startsWith("--pre="))
				? "grep/rg 的 --pre 会执行命令"
				: null;
		default:
			return null;
	}
}

function checkGit(args: string[]): string | null {
	let i = 0;
	// Global options sit before the subcommand; a few of them can point git at
	// another repo or make it write (see codex-cli's git global option rules).
	while (i < args.length && args[i]!.startsWith("-")) {
		const a = args[i]!;
		if (GIT_UNSAFE_GLOBAL.test(a) || a === "-c" || /^-c[A-Za-z]/.test(a)) {
			return `git 全局参数 ${a} 可改写目标或配置`;
		}
		i++;
	}
	const sub = args[i];
	if (sub === undefined) return null; // bare `git` prints usage
	if (sub === "--version" || sub === "-v" || sub === "--help") return null;
	if (args.some((a) => /^--output(=|$)/.test(a))) return "git 的 --output 会写文件";

	const rest = args.slice(i + 1);
	switch (sub) {
		case "branch":
			return rest.every((a) => GIT_BRANCH_READ_ONLY_FLAG.test(a))
				? null
				: "git branch 只有列举形式是只读的";
		case "tag":
			return rest.every((a) => /^(-l|--list|-n\d*|--contains|--no-contains|--merged|--no-merged|--points-at|--sort|--format|--column|--no-column)(=.*)?$/.test(a))
				? null
				: "git tag 只有列举形式是只读的";
		case "stash":
			return rest[0] === "list" || rest[0] === "show" ? null : "git stash 会改动工作区";
		case "worktree":
			return rest[0] === "list" ? null : "git worktree 只有 list 是只读的";
		case "remote":
			return rest.length === 0 || /^(-v|--verbose|show|get-url)$/.test(rest[0]!)
				? null
				: "git remote 只有查询形式是只读的";
		case "config":
			return /^(-l|--list|--get|--get-all|--get-regexp|--get-urlmatch)$/.test(rest[0] ?? "-l")
				? null
				: "git config 只有读取形式是只读的";
		case "reflog":
			return rest.some((a) => a === "delete" || a === "expire")
				? "git reflog delete/expire 会改动引用"
				: null;
		default:
			return GIT_READ_ONLY_SUBCOMMANDS.has(sub) ? null : `git ${sub} 不在只读白名单`;
	}
}

function checkPackageManager(args: string[]): string | null {
	const sub = firstNonOption(args);
	if (sub === undefined) return null; // bare `npm` prints usage
	if (sub === "config" || sub === "pkg") {
		const next = firstNonOption(args.slice(args.indexOf(sub) + 1));
		return next === "get" || next === "list" || next === "ls"
			? null
			: `${sub} 只有读取形式是只读的`;
	}
	return PM_READ_ONLY_SUBCOMMANDS.has(sub) ? null : `包管理器子命令 ${sub} 会修改或执行脚本`;
}

function checkToolchain(bin: string, args: string[]): string | null {
	const sub = firstNonOption(args);
	if (sub === undefined) return null;
	const allowed = bin === "cargo" ? CARGO_READ_ONLY_SUBCOMMANDS : GO_READ_ONLY_SUBCOMMANDS;
	return allowed.has(sub) ? null : `${bin} ${sub} 会写入构建产物或缓存`;
}

// ------------------------------------------------------------------- utilities


/**
 * `2>&1`, `>&2`, `2>&-` only duplicate or close a descriptor and `> /dev/null`
 * throws the bytes away, so none of them touches a real file. Every other
 * redirection — including bash's file-writing shorthand `>& file` — still writes.
 */
function isHarmlessRedirect(op: string, target: unknown): boolean {
	if (typeof target !== "string" || target === "") return false;
	if (op === ">&" || op === "<&") return /^\d+$/.test(target) || target === "-";
	if (op === ">" || op === ">>") return NULL_DEVICE.has(target.toLowerCase());
	return false;
}
function firstNonOption(args: string[]): string | undefined {
	for (const a of args) {
		if (a === "--" || a.startsWith("-")) continue;
		return a;
	}
	return undefined;
}

function binaryName(head: string): string {
	const base = head.replace(/\\/g, "/").split("/").pop() ?? head;
	return base.replace(/\.(exe|cmd|bat|ps1)$/i, "");
}

/**
 * Replace `$(...)` and backtick bodies with a placeholder word and return them.
 * Quoting is respected, so `"a|b"` and `'$(x)'` are left alone, while nested
 * substitutions inside a body are handled when that body is checked recursively.
 * Returns null when quotes/brackets do not balance.
 */
function splitSubstitutions(src: string): { outer: string; bodies: string[] } | null {
	const bodies: string[] = [];
	const out: string[] = [];
	let i = 0;
	let depth = 0;
	let bodyStart = 0;
	let quote: "'" | '"' | null = null;

	while (i < src.length) {
		const ch = src[i]!;

		if (ch === "\\" && quote !== "'") {
			if (depth === 0) out.push(src.slice(i, i + 2));
			i += 2;
			continue;
		}
		if (quote === "'") {
			if (ch === "'") quote = null;
			if (depth === 0) out.push(ch);
			i++;
			continue;
		}
		if (ch === "'") {
			quote = "'";
			if (depth === 0) out.push(ch);
			i++;
			continue;
		}
		if (ch === '"') {
			quote = quote === '"' ? null : '"';
			if (depth === 0) out.push(ch);
			i++;
			continue;
		}
		if (ch === "$" && src[i + 1] === "(") {
			if (depth === 0) {
				out.push(` ${SUBST_PLACEHOLDER} `);
				bodyStart = i + 2;
			}
			depth++;
			i += 2;
			continue;
		}
		if (ch === "`") {
			let j = i + 1;
			while (j < src.length && src[j] !== "`") j += src[j] === "\\" ? 2 : 1;
			if (j >= src.length) return null; // unterminated
			if (depth === 0) {
				out.push(` ${SUBST_PLACEHOLDER} `);
				bodies.push(src.slice(i + 1, j).replace(/\\([`\\])/g, "$1"));
			}
			i = j + 1;
			continue;
		}
		// A `)` only closes a substitution outside quotes.
		if (ch === ")" && quote === null) {
			if (depth === 0) return null; // stray `)`
			depth--;
			if (depth === 0) bodies.push(src.slice(bodyStart, i));
			i++;
			continue;
		}
		if (depth === 0) out.push(ch);
		i++;
	}

	if (depth !== 0) return null; // unbalanced `$(`
	if (quote !== null) return null; // unterminated quote
	return { outer: out.join(""), bodies };
}
