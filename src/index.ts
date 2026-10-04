/**
 * Pi Deep Plan — extension entry.
 *
 * Wraps the deep-plan skill with harness-level enforcement:
 *   - hard write gate during planning/review (only the plan doc + scratch are writable)
 *   - bash restricted to read-only commands while gated
 *   - deep_plan_* lifecycle tools for phase transitions and decision recording
 *   - one-shot review gate with explicit approval before execution
 */

import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	FILE_MUTATION_TOOLS,
	INACTIVE,
	countTopLevelPlans,
	extractWriteTarget,
	fromPersisted,
	isWriteAllowed,
	planLink,
	resolvePlanPath,
	resolveScratchDir,
	stateEntryType,
	toPersisted,
	type Decision,
	type Phase,
	type PlanState,
	type VariableDecision,
} from "./state.ts";
import { readOnlyVerdict } from "./readonly.ts";
import { progressOf, registerTaskTools, renderTaskLines } from "./tasks.ts";
import {
	applyGc,
	archivePlan,
	isoDate,
	scanPlans,
	stampPlanFile,
} from "./archive.ts";

const WIDGET_KEY = "deep-plan";
const STATUS_KEY = "deep-plan";

export default function deepPlan(pi: ExtensionAPI): void {
	let state: PlanState = { ...INACTIVE };
	/**
	 * Set when a `deep_plan_start` call is observed *before* its execute() runs.
	 * Pi evaluates the write gate for every tool in a batch before executing any of
	 * them, so `deep_plan_start` + a write command in one message would otherwise let
	 * the write through ungated (reproducible 3/3). Lives exactly one batch.
	 */
	let armPending = false;

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
			state.phase === "planning"
				? ctx.ui.theme.fg("warning", `◐ deep-plan: 规划中 (写保护)${progress}`)
				: state.phase === "review"
					? ctx.ui.theme.fg("accent", `◑ deep-plan: 待审查 (写保护)${progress}`)
					: ctx.ui.theme.fg("success", `▶ deep-plan: 执行中${progress}`);
		ctx.ui.setStatus(STATUS_KEY, label);

		// Task panel: visible from review onward so the user sees the decomposition
		// they are being asked to approve, then live progress during execution.
		if (state.tasks.length > 0 && state.phase !== "planning") {
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

	function summary(): string {
		const lines: string[] = [];
		lines.push(`phase: ${state.phase}`);
		if (state.goal !== undefined) lines.push(`goal: ${state.goal}`);
		if (state.planPath !== undefined) lines.push(`plan: ${state.planPath}`);
		lines.push(`decisions: ${state.decisions.length}, variables: ${state.variables.length}`);
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
	});

	// --------------------------------------------------------------- the gate

	pi.on("tool_call", async (event, ctx) => {
		// Arm on sight of deep_plan_start so sibling calls in the same batch are gated.
		if (event.toolName === "deep_plan_start") {
			armPending = true;
			return;
		}
		const gated = state.active ? state.phase !== "executing" : armPending;
		if (!gated) return;

		if (FILE_MUTATION_TOOLS.has(event.toolName)) {
			const target = extractWriteTarget(event.toolName, event.input as Record<string, unknown>);
			if (target === undefined) {
				return {
					block: true,
					reason:
						`deep-plan 写保护:${event.toolName} 的目标路径无法确定,已阻止。` +
						`\n当前只允许写方案文档: ${state.planPath ?? "(未分配)"}` +
						`\n需要进入执行阶段请调用 deep_plan_approve。`,
				};
			}
			if (!isWriteAllowed(state, target, ctx.cwd)) {
				return {
					block: true,
					reason:
						`deep-plan 写保护:规划阶段不得修改工作区文件。\n被阻止: ${target}` +
						`\n唯一允许写的是方案文档: ${state.planPath ?? "(未分配)"}` +
						`\n(子代理报告可写 .pi/tmp/ 下的 scratch 文件)` +
						`\n批准执行请调用 deep_plan_approve。`,
				};
			}
			return;
		}

		if (event.toolName === "bash" || event.toolName === "powershell") {
			const command = (event.input as Record<string, unknown>).command;
			if (typeof command !== "string") return;
			const verdict = readOnlyVerdict(command);
			if (!verdict.ok) {
				return {
					block: true,
					reason:
						`deep-plan 写保护:规划阶段只允许只读命令。\n被阻止: ${command}` +
						`\n原因: ${verdict.reason}` +
						`\n批准执行请调用 deep_plan_approve。`,
				};
			}
		}
	});

	// --------------------------------------------------- prompt injection

	pi.on("before_agent_start", async (_event, ctx) => {
		// Safety net: the pending flag must never outlive the batch that set it.
		armPending = false;
		if (!state.active) return;
		if (state.phase === "planning") {
			return {
				message: {
					customType: "deep-plan-context",
					display: false,
					content: [
						"[DEEP PLAN ACTIVE — 规划阶段]",
						"HARD GATE: 编辑器工具只能写方案文档,其余写入会被 harness 拦截;",
						"bash/powershell 只允许只读命令。不要尝试绕过。",
						"",
						`方案文档: ${state.planPath !== undefined ? planLink(ctx.cwd, state.planPath) : "(调用 deep_plan_start 分配)"}`,
						state.goal !== undefined ? `目标: ${state.goal}` : "",
						"",
						"纪律:",
						"1. 自问自答:建设计树,每个 frontier 问题自己给推荐答案,绝不问用户。",
						"2. 事实派子代理查(researcher/scout),不等、不猜、不问用户。",
						"3. 每条决策用 deep_plan_record_decision 记录(附证据与置信度)。",
						"4. 用户可能有不同偏好的项,用 deep_plan_record_variable 记录(必须带已生效的默认值)。",
						"5. 写方案文档 → deep_plan_review 提交审查。",
						"6. 审查后停住,等批准。批准后 deep_plan_approve 解锁并执行。",
					]
						.filter((l) => l !== "")
						.join("\n"),
				},
			};
		}
		if (state.phase === "review") {
			return {
				message: {
					customType: "deep-plan-context",
					display: false,
					content:
						"[DEEP PLAN ACTIVE — 待审查]\n" +
						"方案已提交。现在只做一件事:向用户呈现方案文档路径 + 可变决策表全文 + 任务清单," +
						"给出三个选项(批准执行 / 修改可变决策 / 打回重做),然后停住等回话。\n" +
						"**不要把方案正文贴进对话** —— 正文只存在于文档里,已写过一次就够了。\n" +
						"方案文档一律写成 markdown 链接(形如 [docs/plans/x.md](file:///C:/repo/docs/plans/x.md)),纯路径或反引号在终端里点不开。\n" +
						"不要开始实现,不要修改任何文件。",
				},
			};
		}
		return {
			message: {
				customType: "deep-plan-context",
				display: false,
				content:
					"[DEEP PLAN — 执行阶段]\n方案已批准,写保护已解除,可正常使用全部工具。\n" +
					"按方案的执行步骤推进,每步做完对照验收方式确认;" +
					"若新决策改变了已批准范围,停下来重新走审查。",
			},
		};
	});

	// ------------------------------------------------------------- commands

	pi.registerCommand("deep-plan", {
		description: "开始一次自主规划(deep-plan):自问自答 + 自派子代理查证 + 单一审查",
		handler: async (args, ctx) => {
			const goal = (args ?? "").trim();
			if (goal === "") {
				ctx.ui.notify("用法: /deep-plan <要规划的目标>", "warning");
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
					pi.sendUserMessage(`继续当前 deep-plan(${state.phase})。目标:${state.goal ?? goal}`);
					return;
				}
			}
			const planPath = resolvePlanPath(ctx.cwd, goal);
			state = {
				active: true,
				phase: "planning",
				planPath,
				goal,
				decisions: [],
				variables: [],
				tasks: [],
				scratchAllow: true,
				startedAt: Date.now(),
			};
			persist();
			sync(ctx);
			const leftovers = countTopLevelPlans(ctx.cwd);
			ctx.ui.notify(
				`deep-plan 已启动,写保护生效。\n方案文档: ${planPath}` +
					(leftovers > 1
						? `\n注意: docs/plans/ 顶层还有 ${leftovers - 1} 个旧方案,可用 /deep-plan-gc 归档。`
						: ""),
				"info",
			);
			pi.sendUserMessage(
				[
					`开始 deep-plan。目标:${goal}`,
					"",
					`方案文档(唯一可写文件): ${planPath}`,
					`scratch 目录(子代理报告可写): ${resolveScratchDir(ctx.cwd)}`,
					"",
					"按 deep-plan 纪律执行 P1(自问自答)→ P2(派子代理查证)→ P3(写方案)→ P4(审查)。",
					"全程不要问我任何问题,事实自己查,偏好自己定默认值并记入可变决策表。",
				].join("\n"),
			);
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

	pi.registerCommand("deep-plan-gc", {
		description: "归档 docs/plans/ 中已完成/已放弃的旧方案,使顶层只留活跃(默认保留 30 天)",
		handler: async (args, ctx) => {
			// Args: [days] [apply] — "apply" skips the confirmation prompt.
			const tokens = (args ?? "").trim().split(/\s+/).filter((t) => t !== "");
			const force = tokens.some((t) => t.toLowerCase() === "apply");
			const dayToken = tokens.find((t) => /^\d+$/.test(t));
			const badToken = tokens.find((t) => t.toLowerCase() !== "apply" && !/^\d+$/.test(t));
			if (badToken !== undefined) {
				ctx.ui.notify(`无法识别的参数: ${badToken}。用法: /deep-plan-gc [天数] [apply]`, "warning");
				return;
			}
			const retentionDays = dayToken === undefined ? 30 : Number(dayToken);

			const entries = await scanPlans(ctx.cwd, { retentionDays });
			if (entries.length === 0) {
				ctx.ui.notify(`docs/plans/ 顶层没有方案文档。`, "info");
				return;
			}

			const preview = entries
				.map((e) => `${e.eligible ? "→ 归档" : "  保留"}  ${path.basename(e.filePath)}  [${e.status}]  ${e.ageDays}天  ${e.reason}`)
				.join("\n");
			const eligible = entries.filter((e) => e.eligible);

			if (eligible.length === 0) {
				ctx.ui.notify(`没有需要归档的方案(阈值 ${retentionDays} 天):\n\n${preview}`, "info");
				return;
			}

			// Never mutate without a yes: no UI means dry-run unless "apply" was passed.
			if (!force) {
				if (!ctx.hasUI) {
					ctx.ui.notify(
						`[dry-run] 将归档 ${eligible.length} 个方案:\n\n${preview}` +
							`\n\n当前无交互 UI,未改动任何文件。`,
						"info",
					);
					return;
				}
				const ok = await ctx.ui.confirm(
					`归档 ${eligible.length} 个方案?`,
					`将移动到 docs/plans/archive/<年>/(不删除):\n\n${preview}`,
				);
				if (ok !== true) {
					ctx.ui.notify("已取消,未改动任何文件。", "info");
					return;
				}
			}

			const result = await applyGc(entries);
			const failed = result.failed.map((f) => `  ${path.basename(f.filePath)}: ${f.error}`).join("\n");
			ctx.ui.notify(
				[
					`已归档 ${result.archived.length} 个,保留 ${result.kept} 个。`,
					...result.archived.map((a) => `  → ${a}`),
					failed !== "" ? `失败:\n${failed}` : "",
				]
					.filter((l) => l !== "")
					.join("\n"),
				result.failed.length > 0 ? "warning" : "info",
			);
		},
	});

	// ---------------------------------------------------------------- tools

	pi.registerTool({
		name: "deep_plan_start",
		label: "Start Deep Plan",
		description:
			"启动一次 deep-plan:分配方案文档路径并开启硬写保护。仅在用户要求规划但命令入口不可用时使用;正常入口是 /deep-plan <目标>。",
		promptSnippet: "Start a deep-plan loop with hard write protection",
		parameters: Type.Object({
			goal: Type.String({ description: "要规划的目标,一句话" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (state.active) {
				return {
					content: [{ type: "text", text: `deep-plan 已在进行中(${state.phase})。\n${summary()}` }],
					details: undefined,
				};
			}
			const planPath = resolvePlanPath(ctx.cwd, params.goal);
			// Real state now owns the gate; the pending flag has done its job.
			armPending = false;
			state = {
				active: true,
				phase: "planning",
				planPath,
				goal: params.goal,
				decisions: [],
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
							"deep-plan 已启动,硬写保护生效。",
							`方案文档(唯一可写文件): ${planPath}`,
							`scratch 目录: ${resolveScratchDir(ctx.cwd)}`,
							"现在开始 P1:自问自答建设计树,不要问用户。",
						].join("\n"),
					},
				],
				details: undefined,
			};
		},
	});

	pi.registerTool({
		name: "deep_plan_record_decision",
		label: "Record Decision",
		description:
			"记录一条自问自答得到的设计决策。每条决策必须带证据(文件路径:行号 或 URL)与置信度。低置信度的决策同时要用 deep_plan_record_variable 暴露给用户。",
		promptSnippet: "Record one self-answered design decision with evidence",
		parameters: Type.Object({
			title: Type.String({ description: "决策标题" }),
			conclusion: Type.String({ description: "选定的做法" }),
			evidence: Type.String({ description: "证据:文件路径:行号 或 URL" }),
			confidence: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")], {
				description: "置信度",
			}),
			alternatives: Type.Optional(Type.String({ description: "被否决的备选方案与理由" })),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			requireActive();
			const decision: Decision = {
				id: `D${state.decisions.length + 1}`,
				title: params.title,
				conclusion: params.conclusion,
				evidence: params.evidence,
				confidence: params.confidence,
				alternatives: params.alternatives,
			};
			state.decisions.push(decision);
			persist();
			return {
				content: [{ type: "text", text: `已记录 ${decision.id}: ${decision.title}` }],
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
		label: "Submit Plan For Review",
		description:
			"提交方案进入审查阶段。会校验方案文档存在且非空、可变决策表在 3-8 条之间。提交后进入 review 阶段,写保护仍然生效。",
		promptSnippet: "Submit the written plan for the single user review",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const s = requireActive();
			if (s.phase !== "planning") {
				return {
					content: [{ type: "text", text: `当前阶段是 ${s.phase},不能重复提交审查。` }],
					details: undefined,
				};
			}
			if (s.planPath === undefined) throw new Error("方案文档路径未分配");
			let body = "";
			const fs = await import("node:fs/promises");
			try {
				body = await fs.readFile(s.planPath, "utf8");
			} catch (error) {
				throw new Error(`无法读取方案文档 ${s.planPath}: ${String(error)}`);
			}
			if (body.trim() === "") throw new Error(`方案文档为空: ${s.planPath}`);

			const problems: string[] = [];
			if (s.variables.length < 3) {
				problems.push(`可变决策只有 ${s.variables.length} 条(要求 3-8 条):自问深度不足。`);
			}
			if (s.variables.length > 8) {
				problems.push(`可变决策有 ${s.variables.length} 条(要求 3-8 条):应当拆分为多个方案。`);
			}
			if (s.decisions.length === 0) problems.push("没有记录任何决策(deep_plan_record_decision)。");
			if (s.tasks.length === 0) {
				problems.push("没有任务拆解(deep_plan_task action=add)。方案必须拆成可独立验收的任务。");
			}
			if (problems.length > 0) {
				return {
					content: [{ type: "text", text: `方案未达审查条件:\n- ${problems.join("\n- ")}` }],
					details: undefined,
				};
			}

			// Stamp lifecycle metadata the moment the plan becomes reviewable.
			await stampPlanFile(s.planPath, {
				title: s.taskTitle ?? s.goal,
				status: "review",
				created: isoDate(s.startedAt !== undefined ? new Date(s.startedAt) : new Date()),
				session: ctx.sessionManager.getSessionId(),
			});
			setPhase("review", ctx);
			const table = s.variables.map((v) => `| ${v.id} | ${v.item} | **${v.defaultValue}** | ${v.evidence} | ${v.cost} |`).join("\n");
			return {
				content: [
					{
						type: "text",
						text: [
							`方案已提交审查: ${planLink(ctx.cwd, s.planPath)}`,
							"",
							"可变决策表:",
							"| # | 决策项 | 默认值 | 依据 | 改动代价 |",
							"|---|--------|--------|------|----------|",
							table,
							"",
							`任务清单 (${s.taskTitle ?? "未命名"}) — 进度 ${progressOf(s.tasks).done}/${progressOf(s.tasks).total}:`,
							...s.tasks.map((t) => `  ${t.id} [${t.status}] ${t.title}`),
							"现在向用户呈现:上面的方案文档路径 + 上表 + 任务清单,给出三个选项",
							"(批准执行 / 修改可变决策 / 打回重做),然后停住等回话。",
							"不要把方案正文贴进对话 —— 正文只存在于文档里,用户自己打开看。",
							"方案文档路径请把上面的 markdown 链接原样写进回复(可点击),不要改成反引号或纯路径。",
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
			"用户批准方案后调用:校验方案未被改动,解除写保护,进入执行阶段。必须先经过 deep_plan_review 且用户明确同意。若用户要求修改,先用 deep_plan_revise 回到规划阶段。",
		promptSnippet: "Lift the write gate after explicit user approval",
		parameters: Type.Object({
			approvalNote: Type.Optional(Type.String({ description: "用户批准的原话或要点" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const s = requireActive();
			if (s.phase !== "review") {
				throw new Error(`深度规划当前阶段是 ${s.phase},只有 review 阶段可以批准执行。`);
			}
			if (s.planPath === undefined) throw new Error("方案文档路径未分配");
			const fs = await import("node:fs/promises");
			let body = "";
			try {
				body = await fs.readFile(s.planPath, "utf8");
			} catch (error) {
				throw new Error(`无法读取方案文档,拒绝批准: ${String(error)}`);
			}
			if (body.trim() === "") throw new Error("方案文档为空,拒绝批准");
			s.approvedAt = Date.now();
			await stampPlanFile(s.planPath, { status: "approved", approved: isoDate() });
			setPhase("executing", ctx);
			return {
				content: [
					{
						type: "text",
						text: [
							"已批准,写保护解除,进入执行阶段。",
							`方案: ${planLink(ctx.cwd, s.planPath)}`,
							params.approvalNote !== undefined ? `批准要点: ${params.approvalNote}` : "",
							"按方案执行步骤推进,每步对照验收方式确认。",
							"若新决策改变了已批准范围,调用 deep_plan_revise 重新走审查。",
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
			"用户要求修改可变决策、或执行中需要改变已批准范围时调用:重新开启写保护,回到规划阶段。方案文档保留,可按用户要求修订后再次 deep_plan_review。",
		promptSnippet: "Re-open the write gate to revise the plan",
		parameters: Type.Object({
			reason: Type.String({ description: "为什么要回到规划阶段" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const s = requireActive();
			if (s.phase === "planning") {
				return {
					content: [{ type: "text", text: "已在规划阶段,写保护本就生效。" }],
					details: undefined,
				};
			}
			setPhase("planning", ctx);
			return {
				content: [
					{
						type: "text",
						text: [
							"已回到规划阶段,写保护重新生效。",
							`原因: ${params.reason}`,
							`方案文档仍为: ${s.planPath !== undefined ? planLink(ctx.cwd, s.planPath) : "(未分配)"}`,
							"修订后用 deep_plan_review 重新提交审查。",
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
			"结束当前 deep-plan(执行完成或用户叫停)。定稿方案状态并清除写保护。默认把方案归档到 docs/plans/archive/<年>/,使 docs/plans/ 顶层只保留活跃方案;keepInPlace=true 留在原地。方案文档不会被删除。",
		promptSnippet: "End the deep-plan loop, finalize status, and archive the plan",
		parameters: Type.Object({
			outcome: Type.String({ description: "结果说明(完成了什么 / 为什么停下)" }),
			status: Type.Optional(
				Type.Union([Type.Literal("done"), Type.Literal("abandoned")], {
					description: "done=完成;abandoned=放弃。默认 done。",
				}),
			),
			keepInPlace: Type.Optional(
				Type.Boolean({ description: "true 则留在 docs/plans/ 顶层不归档。默认 false(归档)。" }),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			requireActive();
			const planPath = state.planPath;
			const status = params.status ?? "done";

			// Finalize the plan BEFORE clearing state, so a failure leaves the loop
			// resumable instead of stranding an unstamped file.
			const notes: string[] = [];
			if (planPath !== undefined) {
				const stamped = await stampPlanFile(planPath, {
					status,
					completed: isoDate(),
					title: state.taskTitle ?? state.goal,
				});
				if (stamped === undefined) {
					notes.push(`方案文档不存在,跳过定稿: ${planPath}`);
				} else if (params.keepInPlace === true) {
					notes.push(`方案保留在: ${planPath}`);
				} else {
					try {
						const archived = await archivePlan(planPath);
						notes.push(
							archived !== undefined ? `方案已归档到: ${archived}` : `方案文档不存在,未归档: ${planPath}`
						);
					} catch (error) {
						notes.push(`归档失败(方案仍在原地): ${planPath}\n  ${String(error)}`);
					}
				}
			}

			state = { ...INACTIVE };
			persist();
			sync(ctx);

			const leftover = countTopLevelPlans(ctx.cwd);
			return {
				content: [
					{
						type: "text",
						text: [
							`deep-plan 已结束(${status}),写保护清除。`,
							`结果: ${params.outcome}`,
							...notes,
							leftover > 0
								? `docs/plans/ 顶层仍有 ${leftover} 个文件;跑 /deep-plan-gc 可归档已完成的旧方案。`
								: "docs/plans/ 顶层已清空。",
						]
							.filter((l) => l !== "")
							.join("\n"),
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
