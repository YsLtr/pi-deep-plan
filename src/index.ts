/**
 * Pi Deep Plan — extension entry.
 *
 * Wraps the deep-plan skill with harness-level enforcement:
 *   - hard write gate during planning/review (only the plan doc + scratch are writable)
 *   - bash restricted to read-only commands while gated
 *   - deep_plan_* lifecycle tools for phase transitions and decision recording
 *   - one-shot review gate with explicit approval before execution
 */

import * as fsSync from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	FILE_MUTATION_TOOLS,
	INACTIVE,
	collectAnchors,
	countDocs,
	extractWriteTarget,
	fromPersisted,
	isDocPath,
	isWriteAllowed,
	indexFile,
	listEntryFiles,
	listDocs,
	planLink,
	resolveDocPath,
	resolveOverview,
	resolveScratchDir,
	stateEntryType,
	toPersisted,
	type Phase,
	type PlanState,
	type VariableDecision,
} from "./state.ts";
import { matchesGrant, recordBlocked } from "./intercept.ts";
import { readOnlyVerdict } from "./readonly.ts";
import { progressOf, registerTaskTools, renderTaskLines } from "./tasks.ts";
import { bodyOf, isoDate, stampDoc } from "./archive.ts";

const WIDGET_KEY = "deep-plan";
const STATUS_KEY = "deep-plan";

export default function deepPlan(pi: ExtensionAPI): void {
	let state: PlanState = { ...INACTIVE };
	// ---------------------------------------------------------------- helpers

	function sync(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!state.active) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const p = progressOf(state.tasks);
		const progress = state.tasks.length > 0 ? ` ${p.done}/${p.total}` : "";
		const label =
			state.phase === "writing"
				? ctx.ui.theme.fg("warning", `◐ deep-plan: 文档阶段 (仅 docs/ 可写)${progress}`)
				: ctx.ui.theme.fg("success", `▶ deep-plan: 执行阶段 (docs/ 冻结)${progress}`);
		ctx.ui.setStatus(STATUS_KEY, label);

		// Task panel: shown once execution is under way, where step progress is the point.
		if (state.tasks.length > 0 && state.phase === "executing") {
			try {
				const header = ctx.ui.theme.fg("muted", state.taskTitle ?? "任务清单");
				ctx.ui.setWidget(WIDGET_KEY, [header, ...renderTaskLines(state.tasks, ctx.ui.theme)]);
			} catch {
				// setWidget can be unavailable outside the interactive TUI.
			}
		} else {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		}
	}

	function persist(): void {
		pi.appendEntry(stateEntryType(), toPersisted(state));
	}

	function requireActive(): PlanState {
		if (!state.active) throw new Error("deep-plan 未启动。先用 deep_plan_start 开始一次规划。");
		return state;
	}

	function fileExists(target: string): boolean {
		try {
			return fsSync.statSync(target).isFile();
		} catch {
			return false;
		}
	}

	function summary(): string {
		const lines: string[] = [];
		lines.push(`phase: ${state.phase}`);
		if (state.goal !== undefined) lines.push(`goal: ${state.goal}`);
		if (state.planPath !== undefined) lines.push(`plan: ${state.planPath}`);
		lines.push(`variables: ${state.variables.length}`);
		return lines.join("\n");
	}

	function setPhase(next: Phase, ctx: ExtensionContext): void {
		state.phase = next;
		persist();
		sync(ctx);
	}

	// ------------------------------------------------------------ lifecycle

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const last = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === stateEntryType())
			.pop() as { data?: unknown } | undefined;
		const restored = fromPersisted(last?.data);
		if (restored !== undefined) state = restored;
		sync(ctx);
	});

	pi.on("session_shutdown", async () => {
		state = { ...INACTIVE };
		anchorPaths.clear();
		grantedCommand = undefined;
		grantedRun = undefined;
	});


	/**
	 * Anchor -> owning file, so the gate can see the target of an anchor-addressed edit
	 * (`replace` / `insert` / `replace_match` / `copy` / `move`).
	 *
	 * The map is learned from `read` results: every served row is `HASH│content`, and the
	 * call's own input says which file those rows came from. Importing the anchor editor's
	 * registry is not an option — Pi loads each package with its own module root, so one
	 * package cannot reach another's dependency instance.
	 *
	 * Only anchors minted by a `read` in this session resolve. Anything else is unknown,
	 * which is the honest answer, and a stale anchor fails inside the editor anyway.
	 */
	const anchorPaths = new Map<string, string>();

	pi.on("tool_result", async (event) => {
		if (event.toolName !== "read" || event.isError) return;
		const requested = event.input.path ?? event.input.file_path ?? event.input.file;
		if (typeof requested !== "string" || requested === "") return;
		for (const part of event.content) {
			if (part.type === "text") collectAnchors(part.text, requested, anchorPaths);
		}
	});

	function planTargetFor(anchor: string): string | undefined {
		return anchorPaths.get(anchor);
	}

	// --------------------------------------------------------------- the gate

	/**
	 * Command the user approved once through `deep_plan_request_allow`. Consumed by the next call
	 * that matches it verbatim, so the same command meets the wall again. In memory only — a grant
	 * must not survive the session that granted it.
	 */
	let grantedCommand: string | undefined;

	/**
	 * The run the grant was approved in. A later run in the same session must not inherit the
	 * approval, so the gate requires the id to match the current run's `startedAt`.
	 */
	let grantedRun: number | undefined;


	pi.on("tool_call", async (event, ctx) => {
		// The file gate runs in both stages: stage one allows only `docs/`, stage two only the
		// repository. Keeping it armed during execution is what freezes the documents, which is
		// what keeps the doc commit and the code commit from ever overlapping.
		if (!state.active) return;
		if (FILE_MUTATION_TOOLS.has(event.toolName)) {
			const target = extractWriteTarget(event.toolName, event.input as Record<string, unknown>, planTargetFor);
			if (target === undefined) {
				return {
					block: true,
					reason:
						`deep-plan 写保护:${event.toolName} 的目标路径无法确定,已阻止。` +
						`\n文档阶段只允许写 docs/ 下的文档;执行阶段只允许写 docs/ 外的仓库文件。` +
						`\n当前文档: ${state.planPath ?? "(未指定)"}`
				};
			}
			if (target === "") {
				// An anchored editor whose anchor this gate never saw served cannot be
				// attributed to a file. Fails closed: passing it through would let a model
				// edit any freshly-read file, since the served rows may not have matched.
				return {
					block: true,
					reason:
						`deep-plan 写保护:${event.toolName} 的锚点无法定位到文件,已阻止。` +
						`\n(先 read 目标文件让锚点可解析,或改用 write 整篇覆盖)`,
				};
			}
			if (!isWriteAllowed(state, target, ctx.cwd)) {
				return {
					block: true,
					reason:
						(state.phase === "writing"
							? `deep-plan 文档阶段:只能修改 docs/ 下的文档。\n被阻止: ${target}` +
								`\n(子代理报告可写 .pi/tmp/ 下的 scratch 文件)`
							: `deep-plan 执行阶段:docs/ 已冻结,随文档一起提交。\n被阻止: ${target}` +
								`\n要改文档请用 deep_plan_revise 回到文档阶段。`),
				};
			}
			return;
		}

		// Shell restriction is a documentation-stage rule: the point of stage one is that
		// nothing changes but the documents, and `git commit` is included in that "nothing".
		if (state.phase === "executing") return;
		if (event.toolName === "bash" || event.toolName === "powershell") {
			const command = (event.input as Record<string, unknown>).command;
			if (typeof command !== "string") return;
			const verdict = readOnlyVerdict(command);
			if (verdict.ok) return;
			// A command the user approved once passes here exactly once: the grant is consumed
			// before the call runs, so the identical text is refused again on the next call.
			if (grantedRun === state.startedAt && matchesGrant(grantedCommand, command)) {
				grantedCommand = undefined;
				grantedRun = undefined;
				return;
			}
			try {
				recordBlocked(ctx.cwd, {
					at: new Date().toISOString(),
					phase: state.phase,
					tool: event.toolName,
					command,
					reason: verdict.reason,
				});
			} catch (error) {
				// The refusal must not depend on the log: a failed append still blocks.
				ctx.ui.notify(`deep-plan:拦截记录写入失败 ${String(error)}`, "warning");
			}
			return {
				block: true,
				reason:
					`deep-plan 文档阶段:只允许只读命令(改动交给 git 与编辑器)。\n被阻止: ${command}` +
					`\n原因: ${verdict.reason}` +
					`\n如该命令实际只读、只是未通过白名单,可调 deep_plan_request_allow 申请一次性放行(需用户确认)。`,
			};
		}
	});

	// --------------------------------------------------- prompt injection

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!state.active) return;
		if (state.phase === "writing") {
			return {
				message: {
					customType: "deep-plan-context",
					display: false,
					content: [
						"[DEEP PLAN — 第一阶段:文档]",
						"范围: 只有 docs/ 下的文档可写(以及 .pi/tmp/ 的 scratch)。仓库代码、README、AGENTS.md 都不可写。",
						"bash/powershell 只允许只读命令。不要尝试绕过。实际只读而未被识别的命令,可用 deep_plan_request_allow 申请一次性放行(需用户同意);写类命令不得申请。",
						"",
						`本次文档: ${state.planPath !== undefined ? planLink(ctx.cwd, state.planPath) : "(未指定)"}`,
						`docs/ 现有文档(${countDocs(ctx.cwd)}): ${listDocs(ctx.cwd).slice(0, 20).join(", ") || "(空)"}`,
						state.goal !== undefined ? `目标: ${state.goal}` : "",
						state.haltReason !== undefined
							? `\n**本次执行因文档冲突被中止**: ${state.haltReason}\n先把冲突解决掉再收尾。`
							: "",
						"",
						"纪律:",
						"1. 自问自答:建设计树,每个 frontier 问题**先写出现,再写出你的推荐答案**,绝不问用户。",
						"2. 事实派子代理查(researcher/scout),不等、不猜、不问用户。",
						"3. 用户可能有不同偏好的项,用 deep_plan_record_variable 记录(必须带已生效的默认值)。",
						"4. 文档只留**结果**:术语、目标 / 非目标、风险、计划。**不要写决策记录** ——",
						"   「为什么这么定」写进 git commit message,因为决策是变值,会改。",
						"5. 文档写给未来的读者,不是写给这一次的执行。",
						"",
						"文档怎么写(重要):",
						"- **不要写按日期排布的变化记录。** 变化由 git 记录,git diff 就是本次计划。",
						"- **不要写一次性计划表或待办清单。** 文档是长期维护的项目开发文档。",
						"- 维护完整:没有留白、没有 TBD、不与文档其余部分或现有 docs/ 相互矛盾。",
						"- 已有的目标文档要**就地完善**(改、补、删),不要新建一份平行文档。",
						"- 话题是文件夹:总纲 `docs/<topic>/<topic>.md`,计划条目 `docs/<topic>/plan/NNNN-<slug>.md`。",
						"  一个文件一个条目,不要塞回总纲的子标题。",
						"- **不写决策记录、不建 decisions/、不建 docs/adr/。** 决策是变值,会改;",
						"  「为什么这么定」写进 git commit message。文档只留结果:术语 / 目标与非目标 / 风险 / 计划。",
						"- 建话题文件夹用 write 写第一个文件(write 会自动建父目录);**不要用 bash mkdir**,",
						"  它被写作阶段的只读门禁拒绝,试图绕过同样会被拦。",
						"- 术语放进总纲自己的术语小节。",
						"- 新增或新开话题时,同步更新 docs/INDEX.md(一行一个话题,指向它的总纲)。",
						"- 改已有文档请用 write 整篇覆盖,或带上 path 的按行编辑。",
						"",
						"收尾: 先 deep_plan_task 把执行阶段要做的事拆成可独立验收的任务,",
						"再调 deep_plan_review。提交审查前确保文档已写完 —— 之后文档会被冻结。",
						"",
						"提交: **由你执行,两段分开。** 本阶段结束先提文档(例如 `git add docs/ && git commit`),",
						"再问是否批准进入执行阶段;进入执行阶段后的代码另起一个 commit。用户可能改这条委托,",
						"以本轮对话的指令为准。",
					]
						.filter((l) => l !== "")
						.join("\n"),
				},
			};
		}
		return {
			message: {
				customType: "deep-plan-context",
				display: false,
				content: [
					"[DEEP PLAN — 第二阶段:执行]",
					"文档阶段已结束,`docs/` 已冻结 —— 文档改动要与代码分开提交,所以这里不再改文档。",
					"仓库其余部分可正常写,全部工具可用。",
					"",
					`已定稿的文档: ${state.planPath !== undefined ? planLink(ctx.cwd, state.planPath) : "(未指定)"}`,
					"",
					"1. 按 deep_plan_task 定下的任务逐条推进,每条做完对照验收方式确认。",
					"2. **提交只针对仓库代码。** 文档已经在第一阶段提交过,不要混进代码提交里。",
					"3. 提交由你执行(除非本轮对话另有指令):代码单独成一个 commit,和文档那次分开。",
					"4. 全部完成后调 deep_plan_finish 收尾。",
					"",
					"**发现文档冲突时(硬要求):停止执行,不要绕过。**",
					"冲突包括:文档描述与实际代码不符、文档内部自相矛盾、文档漏掉了你正需要的事实、",
					"或按文档做下去会与文档的其它部分打架。遇到任一种:",
					"",
					"- 立即停下当前任务,不要「照实际代码改」来迁就过时的文档,也不要把冲突记进代码注释。",
					"- 调 `deep_plan_revise conflict=true reason=<具体冲突>`,它会把进行中的任务标为受阻、",
					"  冻结仓库、放开 docs/。",
					"- 在文档阶段把文档改对,`deep_plan_review` 重新收尾,等用户批准后再继续执行。",
					"  受阻的任务修完后用 `deep_plan_step action=unblock` 恢复,不要当成已完成。",
					"- 只是文档措辞小瑕疵、不影响执行正确性 → 不值得中止,记下来等收尾时一并处理。",
				]
					.filter((l) => l !== "")
					.join("\n"),
			},
		};
	});

	// ------------------------------------------------------------- commands

	pi.registerCommand("deep-plan", {
		description:
			"开始一次 deep-plan:第一阶段完善文档(仅 docs/ 可写),提交文档后第二阶段执行代码",
		handler: async (args, ctx) => {
			// `--doc <path>` routes the run to a specific document; without it the goal's
			// slug names the file, so the same topic reuses the same document.
			const raw = (args ?? "").trim();
			const docMatch = /--doc(?:=|\s+)(\S+)/.exec(raw);
			const requestedDoc = docMatch?.[1];
			const goal = raw.replace(/--doc(?:=|\s+)\S+/, "").trim();
			if (goal === "") {
				ctx.ui.notify(
					"用法: /deep-plan <要规划的目标> [--doc docs/<路径>.md]\n" +
						"不带 --doc 时,按目标的 slug 定位 docs/<slug>.md。",
					"warning",
				);
				return;
			}
			if (state.active) {
				const choice = ctx.hasUI
					? await ctx.ui.select("已有进行中的 deep-plan", ["继续当前规划", "放弃并重新开始", "取消"])
					: "继续当前规划";
				if (choice === "取消" || choice === undefined) return;
				if (choice === "放弃并重新开始") {
					state = { ...INACTIVE };
				} else {
					pi.sendUserMessage(`继续当前 deep-plan(${state.phase})。`);
					return;
				}
			}
			let planPath: string;
			try {
				planPath = resolveDocPath(ctx.cwd, goal, requestedDoc);
			} catch (error) {
				ctx.ui.notify(String(error instanceof Error ? error.message : error), "warning");
				return;
			}
			state = {
				active: true,
				phase: "writing",
				planPath,
				goal,
				variables: [],
				tasks: [],
				scratchAllow: true,
				startedAt: Date.now(),
			};
			persist();
			sync(ctx);
			const existing = state.planPath !== undefined && fileExists(planPath);
			ctx.ui.notify(
				`deep-plan 已启动 — 第一阶段:文档(仅 docs/ 可写)。\n` +
					`${existing ? "完善已有文档" : "新建文档"}: ${planPath}\n` +
					`docs/ 现有文档 ${countDocs(ctx.cwd)} 份。\n` +
					`文档写完并提交后,再进入执行阶段 —— 两段提交是分开的。`,
				"info",
			);
			// One line only: state and every discipline live in the before_agent_start
			// injection, so nothing here duplicates what the hook says.
			pi.sendUserMessage(`开始 deep-plan。目标:${goal}`);
		},
	});

	pi.registerCommand("deep-plan-status", {
		description: "显示当前 deep-plan 状态(不触发模型调用)",
		handler: async (_args, ctx) => {
			if (!state.active) {
				ctx.ui.notify("当前没有 deep-plan 在进行。用 /deep-plan <目标> 开始。", "info");
				return;
			}
			const vars =
				state.variables.length === 0
					? "  (尚无)"
					: state.variables
							.map((v) => `  ${v.id} ${v.item} → ${v.defaultValue}`)
							.join("\n");
			ctx.ui.notify(`${summary()}\n\n可变决策:\n${vars}`, "info");
		},
	});

	pi.registerCommand("deep-plan-docs", {
		description: "列出 docs/ 下的文档与索引状态(不触发模型调用)",
		handler: async (_args, ctx) => {
			const docs = listDocs(ctx.cwd);
			if (docs.length === 0) {
				ctx.ui.notify("docs/ 下还没有文档。用 /deep-plan <目标> 开始。", "info");
				return;
			}
			const index = indexFile(ctx.cwd);
			const hasIndex = fileExists(index);
			// Show which documents are topic overviews (one per folder) versus standalone
			// single-file topics, so the layout is visible from the command itself. `listDocs`
			// returns cwd-relative paths, so strip the `docs/` prefix by hand.
			const rows = docs.map((d) => {
				const rel = d.replace(/^docs[\\/]/, "").replace(/\\/g, "/");
				const parts = rel.split("/");
				if (parts.length === 2 && parts[0] === parts[1].replace(/\.md$/, "")) {
					return `  话题 ${parts[0]}/  → ${d}`;
				}
				if (parts.length >= 3) return `    条目      ${d}`;
				if (rel === "INDEX.md") return `  索引      ${d}`;
				return `  单文件    ${d}`;
			});
			ctx.ui.notify(
				`docs/ 下 ${docs.length} 份文档:\n${rows.join("\n")}` +
					`\n\n索引 ${hasIndex ? "存在" : "缺失"}: ${path.relative(ctx.cwd, index)}` +
					(hasIndex ? "" : "\n(规划时要求模型同步维护索引)"),
				hasIndex ? "info" : "warning",
			);
		},
	});

	// ---------------------------------------------------------------- tools


	pi.registerTool({
		name: "deep_plan_start",
		label: "Start Deep Plan",
		description:
			"启动一次 deep-plan:第一阶段只写 docs/ 下的文档。仅在用户要求规划但命令入口不可用时使用;正常入口是 /deep-plan <目标> [--doc <路径>]。",
		promptSnippet: "Start the deep-plan documentation stage (docs/ only)",
		parameters: Type.Object({
			goal: Type.String({ description: "要规划的目标,一句话" }),
			doc: Type.Optional(
				Type.String({ description: "目标文档路径(docs/ 下)。省略时按目标的 slug 定位。" }),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (state.active) {
				return {
					content: [{ type: "text", text: `deep-plan 已在进行中(${state.phase})。\n${summary()}` }],
					details: undefined,
				};
			}
			let planPath: string;
			try {
				planPath = resolveDocPath(ctx.cwd, params.goal, params.doc);
			} catch (error) {
				return {
					content: [{ type: "text", text: String(error instanceof Error ? error.message : error) }],
					details: undefined,
				};
			}
			state = {
				active: true,
				phase: "writing",
				planPath,
				goal: params.goal,
				variables: [],
				tasks: [],
				scratchAllow: true,
				startedAt: Date.now(),
			};
			persist();
			sync(ctx);
			return {
				content: [
					{
						type: "text",
						text: [
							"deep-plan 已启动 — 第一阶段:文档。",
							`本次文档: ${planPath}`,
							`可写范围: docs/ 下任意文档 + .pi/tmp/ 的 scratch`,
							`docs/ 现有文档: ${listDocs(ctx.cwd).join(", ") || "(空)"}`,
							"开始自问自答建设计树,不要问用户。",
						].join("\n"),
					},
				],
				details: undefined,
			};
		},
	});


	pi.registerTool({
		name: "deep_plan_record_variable",
		label: "Record Variable Decision",
		description:
			"记录一条「可变决策」——用户可能有不同偏好、因而需要在最终审查时逐项过目的选择。必须给出已生效的默认值(方案按此默认值即可直接执行)、依据、以及改动代价。",
		promptSnippet: "Expose one user-reviewable decision with a live default",
		parameters: Type.Object({
			item: Type.String({ description: "这是什么选择,一句话" }),
			defaultValue: Type.String({ description: "已生效的默认值" }),
			evidence: Type.String({ description: "为什么选它(证据)" }),
			cost: Type.String({ description: "改动代价(低/中/高 + 说明改了会怎样)" }),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			requireActive();
			const v: VariableDecision = {
				id: `V${state.variables.length + 1}`,
				item: params.item,
				defaultValue: params.defaultValue,
				evidence: params.evidence,
				cost: params.cost,
			};
			state.variables.push(v);
			persist();
			const warn =
				state.variables.length > 8
					? "\n注意:可变决策已超过 8 条。按 deep-plan 纪律,超过 8 条说明该拆成多个方案或自问深度不足。"
					: "";
			return {
				content: [{ type: "text", text: `已记录 ${v.id}: ${v.item} → ${v.defaultValue}${warn}` }],
				details: undefined,
			};
		},
	});

	pi.registerTool({
		name: "deep_plan_review",
		label: "Finish Documentation Stage",
		description:
			"第一阶段收尾:校验文档已写完,并给出只提交文档的 git 边界。提交后进入审查,由用户决定是否批准执行。",
		promptSnippet: "Close the documentation stage and hand the plan to the user",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const s = requireActive();
			if (s.phase !== "writing") {
				return {
					content: [{ type: "text", text: `当前阶段是 ${s.phase},文档阶段已收尾。` }],
					details: undefined,
				};
			}
			if (s.planPath === undefined) throw new Error("文档路径未分配");
			// A topic that moved into its folder is still this run's document; stamping the
			// recorded path would silently skip it.
			s.planPath = resolveOverview(ctx.cwd, s.planPath);
			const fs = await import("node:fs/promises");
			let body = "";
			try {
				body = await fs.readFile(s.planPath, "utf8");
			} catch (error) {
				throw new Error(`无法读取文档 ${s.planPath}: ${String(error)}`);
			}
			if (bodyOf(body) === "") throw new Error(`文档正文为空(只有 frontmatter): ${s.planPath}`);

			const problems: string[] = [];
			if (s.variables.length < 3) {
				problems.push(`可变决策只有 ${s.variables.length} 条(要求 3-8 条):自问深度不足。`);
			}
			if (s.variables.length > 8) {
				problems.push(`可变决策有 ${s.variables.length} 条(要求 3-8 条):应当拆分为多个文档。`);
			}
			if (s.tasks.length === 0) {
				problems.push("没有任务拆解(deep_plan_task action=add):执行阶段需要可独立验收的任务。");
			}
			// Entries are files in the topic folder. An empty one is a heading with nothing under
			// it — the file-per-entry split only pays off if each file actually says something.
			// Sequence gaps are not checked: the task list, not the file numbering, owns completeness.
			for (const { label, path: file } of await listEntryFiles(ctx.cwd, s.planPath)) {
				let entryBody = "";
				try {
					entryBody = await fs.readFile(file, "utf8");
				} catch (error) {
					problems.push(`条目文件读不到(${label}): ${String(error)}`);
					continue;
				}
				if (bodyOf(entryBody) === "") problems.push(`条目文件是空的(${label}): ${file}`);
			}
			if (problems.length > 0) {
				return {
					content: [{ type: "text", text: `文档阶段未达收尾条件:\n- ${problems.join("\n- ")}` }],
					details: undefined,
				};
			}

			await stampDoc(s.planPath, {
				title: s.taskTitle ?? s.goal,
				updated: isoDate(),
			});
			persist();
			sync(ctx);
			const table = s.variables.map((v) => `| ${v.id} | ${v.item} | **${v.defaultValue}** | ${v.evidence} | ${v.cost} |`).join("\n");
			return {
				content: [
					{
						type: "text",
						text: [
							`文档阶段完成: ${planLink(ctx.cwd, s.planPath)}`,
							"",
							"可变决策表:",
							"| # | 决策项 | 默认值 | 依据 | 改动代价 |",
							"|---|--------|--------|------|----------|",
							table,
							"",
							`执行阶段任务 (${s.taskTitle ?? "未命名"}) — ${progressOf(s.tasks).total} 条:`,
							...s.tasks.map((t) => `  ${t.id} ${t.title}`),
							"",
							"现在向用户呈现:文档路径 + 上表 + 任务清单,并说明接下来的两步:",
							"1) **先只提交文档**(示例: `git add docs/ && git commit -m \"docs: ...\"`)。",
							"   提交由你执行;若本轮对话把提交委托给了用户,就交给用户做。",
							"2) 提交完成后,再问是否批准进入执行阶段。",
							"呈现后停住等回话,不要自己往下开工,也不要把文档正文贴进对话。",
						].join("\n"),
					},
				],
				details: undefined,
			};
		},
	});

	pi.registerTool({
		name: "deep_plan_approve",
		label: "Approve And Execute",
		description:
			"用户批准后调用:进入第二阶段,冻结 docs/,放开仓库其余部分。必须先经过 deep_plan_review,且文档已提交。若用户要求修改,先用 deep_plan_revise。",
		promptSnippet: "Start the execution stage (docs frozen, repo writable)",
		parameters: Type.Object({
			approvalNote: Type.Optional(Type.String({ description: "用户批准的原话或要点" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const s = requireActive();
			if (s.phase !== "writing") {
				throw new Error(`当前阶段是 ${s.phase},已经在执行阶段。`);
			}
			if (s.planPath === undefined) throw new Error("文档路径未分配");
			s.planPath = resolveOverview(ctx.cwd, s.planPath);
			const fs = await import("node:fs/promises");
			let body = "";
			try {
				body = await fs.readFile(s.planPath, "utf8");
			} catch (error) {
				throw new Error(`无法读取文档,拒绝批准: ${String(error)}`);
			}
			if (bodyOf(body) === "") throw new Error("文档正文为空,拒绝批准");
			s.approvedAt = Date.now();
			// The conflict that halted the last run is settled by approving the fixed document.
			s.haltReason = undefined;
			await stampDoc(s.planPath, { status: "approved", approved: isoDate() });
			setPhase("executing", ctx);
			return {
				content: [
					{
						type: "text",
						text: [
							"已批准,进入第二阶段:执行。",
							`文档(已冻结): ${planLink(ctx.cwd, s.planPath)}`,
							params.approvalNote !== undefined ? `批准要点: ${params.approvalNote}` : "",
							"现在可写仓库其余部分;docs/ 已被冻结,文档改动请走 deep_plan_revise。",
							"提交只针对仓库代码 —— 文档改动属于第一阶段的那次提交。",
							"按 deep_plan_task 的任务推进,每步对照验收方式确认,全部完成后 deep_plan_finish。",
						]
							.filter((l) => l !== "")
							.join("\n"),
					},
				],
				details: undefined,
			};
		},
	});


	pi.registerTool({
		name: "deep_plan_revise",
		label: "Revise Plan",
		description:
			"停止本次执行并回到第一阶段(文档):执行中发现文档与实际冲突、过时或自相矛盾时调用。" +
			"会把进行中的任务标为受阻,冻结仓库,放开 docs/。改完用 deep_plan_review 重新收尾。",
		promptSnippet: "Halt execution on a document conflict and re-open the documentation stage",
		parameters: Type.Object({
			reason: Type.String({ description: "为什么回到文档阶段(冲突/过时/矛盾的具体内容)" }),
			conflict: Type.Optional(
				Type.Boolean({
					description: "true 表示因为文档冲突而中止本次执行(会记录中止原因并标记进行中的任务)。默认 false。",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const s = requireActive();
			if (s.phase === "writing") {
				return {
					content: [{ type: "text", text: "已在文档阶段,docs/ 本就可写。" }],
					details: undefined,
				};
			}

			// Halt first: an in-flight task must not stay "active" while its premise is being
			// rewritten, or the doc fix silently reads as completed work.
			const interrupted: string[] = [];
			for (const task of s.tasks) {
				if (task.status !== "active") continue;
				task.status = "blocked";
				task.note = `文档冲突,执行已中止: ${params.reason}`;
				interrupted.push(task.id);
			}
			if (params.conflict === true) s.haltReason = params.reason;

			await stampDoc(
				s.planPath !== undefined ? resolveOverview(ctx.cwd, s.planPath) : "",
				{ status: "writing", updated: isoDate() },
			);
			setPhase("writing", ctx);
			return {
				content: [
					{
						type: "text",
						text: [
							params.conflict === true
								? "已**中止本次执行**,回到第一阶段:文档。"
								: "已回到第一阶段:文档。",
							`原因: ${params.reason}`,
							`文档: ${s.planPath !== undefined ? planLink(ctx.cwd, s.planPath) : "(未指定)"}`,
							interrupted.length > 0
								? `已把进行中的任务标为受阻: ${interrupted.join(", ")}(修完文档后用 ` +
									`deep_plan_step action=unblock 恢复,不要当作已完成)`
								: "没有进行中的任务。",
							"现在 docs/ 可写、仓库被冻结。改完用 deep_plan_review 重新收尾,再申请批准执行。",
							"不要在执行阶段直接改仓库去迁就过时的文档 —— 先把文档改对。",
						].join("\n"),
					},
				],
				details: undefined,
			};
		},
	});


	pi.registerTool({
		name: "deep_plan_finish",
		label: "Finish Deep Plan",
		description:
			"结束当前 deep-plan(执行完成或用户叫停)。把文档定稿并清除阶段限制。文档留在 docs/ 原地 —— 不归档、不按日期重命名,历史由 git 记录。",
		promptSnippet: "End the deep-plan loop and finalize the document",
		parameters: Type.Object({
			outcome: Type.String({ description: "结果说明(完成了什么 / 为什么停下)" }),
			status: Type.Optional(
				Type.Union([Type.Literal("done"), Type.Literal("abandoned")], {
					description: "done=完成;abandoned=放弃。默认 done。",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			requireActive();
			const planPath = state.planPath !== undefined ? resolveOverview(ctx.cwd, state.planPath) : undefined;
			const status = params.status ?? "done";

			// Finalize the plan BEFORE clearing state, so a failure leaves the loop
			// resumable instead of stranding an unstamped file.
			const notes: string[] = [];
			if (planPath !== undefined) {
				const stamped = await stampDoc(planPath, {
					status: status === "done" ? "approved" : "writing",
					updated: isoDate(),
					title: state.taskTitle ?? state.goal,
				});
				notes.push(
					stamped === undefined
						? `文档不存在,跳过定稿: ${planPath}`
						: `文档定稿在: ${planPath}(原地保留,不归档)`,
				);
			}

			state = { ...INACTIVE };
			persist();
			sync(ctx);

			return {
				content: [
					{
						type: "text",
						text: [
							`deep-plan 已结束(${status})。`,
							`结果: ${params.outcome}`,
							...notes,
							"",
							"两段提交应当是分开的:文档改动属于第一阶段,代码改动属于第二阶段。",
							`当前 docs/ 下 ${countDocs(ctx.cwd)} 份文档。`,
						]
							.filter((l) => l !== "")
							.join("\n"),
					},
				],
				details: undefined,
			};
		},
	});
	pi.registerTool({
		name: "deep_plan_request_allow",
		label: "Request One-Time Allow",
		description:
			"被只读墙拦下、但**实际只读**的命令可申请一次性放行(命令本身不写文件、不删除、不执行任意代码,只是未通过白名单或未被解析识别):" +
			"用户同意后该命令的下一次调用被放行,用完即失效 —— 同一命令再次调用仍会被拦。" +
			"命令须与拦截文案里的「被阻止」逐字一致;理由须给出该命令实际只读的依据,并说明有无只读替代。不得为写类命令申请。",
		promptSnippet: "Ask the user to allow one blocked read-only command once",
		parameters: Type.Object({
			command: Type.String({ description: "被拦下的完整命令,须与拦截文案里的「被阻止」逐字一致" }),
			readOnly: Type.Boolean({
				description: "确认该命令实际只读:不写文件、不删除、不执行任意代码,只是未被只读墙识别",
			}),
			reason: Type.String({ description: "该命令实际只读的依据,以及它在文档阶段为何必要、有无只读替代" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const s = requireActive();
			if (s.phase !== "writing") {
				return {
					content: [{ type: "text", text: "当前是执行阶段,没有只读墙,直接执行即可。" }],
					details: undefined,
				};
			}
			if (!params.readOnly) {
				return {
					content: [
						{
							type: "text",
							text: "未确认为实际只读的命令,不予申请。写类命令在文档阶段一律不做;请改用只读替代。",
						},
					],
					details: undefined,
				};
			}
			const command = params.command.trim();
			if (command === "") {
				return { content: [{ type: "text", text: "命令为空,无法申请放行。" }], details: undefined };
			}
			if (readOnlyVerdict(command).ok) {
				return {
					content: [{ type: "text", text: "这条命令本来就通过只读墙,无需申请。" }],
					details: undefined,
				};
			}
			if (!ctx.hasUI) {
				return {
					content: [
						{ type: "text", text: "当前环境没有可交互 UI,取不到用户同意 —— 该命令仍会被拦。" },
					],
					details: undefined,
				};
			}
			const choice = await ctx.ui.select(
				`申请一次性放行以下命令(仅这一次;之后同一命令仍会被拦):\n${command}\n\n自述实际只读,依据: ${params.reason}`,
				["放行一次", "拒绝"],
			);
			if (choice !== "放行一次") {
				return {
					content: [{ type: "text", text: "用户未批准,该命令仍被只读墙拦截。" }],
					details: undefined,
				};
			}
			grantedCommand = command;
			grantedRun = s.startedAt;
			return {
				content: [
					{
						type: "text",
						text:
							"已获准一次性放行。现在可执行该命令,放行机会在这一次调用后失效;" +
							"同一命令再次调用仍需重新申请。",
					},
				],
				details: undefined,
			};
		},
	});

	// ------------------------------------------------------- task tracking
	registerTaskTools(pi, {
		getState: () => state,
		requireActive,
		persist,
		sync,
		phaseOf: () => state.phase,
	});

}
