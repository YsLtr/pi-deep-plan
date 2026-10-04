/**
 * Task tracking tools for pi-deep-plan.
 *
 * Modeled on pi-plan-build's plan_task (task metadata) + plan_step_control /
 * plan_step_complete (step lifecycle), but wired into deep-plan's phase machine:
 * during planning/review only structure may change; only the executing phase may
 * advance step status.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PlanState, PlanTask, PlanTaskStatus } from "./state.ts";

export interface TaskToolDeps {
	/** Live state accessor — never cache the object; approve/revise replace it. */
	getState(): PlanState;
	requireActive(): PlanState;
	persist(): void;
	sync(ctx: ExtensionContext): void;
	/** Guard used by step mutations: only the executing phase may advance steps. */
	phaseOf(): string;
}

const STATUS_MARK: Record<PlanTaskStatus, string> = {
	planned: "☐",
	active: "▶",
	done: "☑",
	skipped: "⤼",
	blocked: "⛔",
};

export function renderTaskLines(tasks: PlanTask[], theme: { fg(color: string, text: string): string }): string[] {
	return tasks.map((t) => {
		const mark = STATUS_MARK[t.status] ?? "☐";
		const label = t.status === "done" ? theme.fg("muted", `${t.id} ${t.title}`) : theme.fg("muted", t.id) + " " + t.title;
		if (t.status === "done") return `${theme.fg("success", mark)} ${label}`;
		if (t.status === "active") return `${theme.fg("accent", mark)} ${label}`;
		if (t.status === "blocked") return `${theme.fg("error", mark)} ${label}`;
		return `${mark} ${label}`;
	});
}

export function progressOf(tasks: PlanTask[]): { done: number; total: number } {
	const countable = tasks.filter((t) => t.status !== "skipped");
	const done = countable.filter((t) => t.status === "done").length;
	return { done, total: countable.length };
}

export function summarizeTasks(tasks: PlanTask[]): string {
	if (tasks.length === 0) return "(尚无任务)";
	return tasks
		.map((t) => {
			const note = t.note !== undefined && t.note !== "" ? ` — ${t.note}` : "";
			const scope = t.scope !== undefined && t.scope !== "" ? `\n    范围: ${t.scope}` : "";
			return `${STATUS_MARK[t.status] ?? "☐"} ${t.id} [${t.status}] ${t.title}${scope}${note}`;
		})
		.join("\n");
}

export function registerTaskTools(pi: ExtensionAPI, deps: TaskToolDeps): void {
	pi.registerTool({
		name: "deep_plan_task",
		label: "Manage Plan Tasks",
		description:
			"管理任务的识别信息与结构化任务清单。action=title 确立/修正任务标题与范围(整个方案只做一次);" +
			"action=add 追加一个可独立验收的任务;action=list 查看清单与进度;" +
			"action=update 修正已规划任务的标题/范围;action=remove 删除尚未开始的任务。" +
			"规划与审查阶段可用它做任务拆解,但不能推进状态;推进状态用 deep_plan_step。",
		promptSnippet: "Decompose the plan into independently verifiable tasks",
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("title"),
					Type.Literal("add"),
					Type.Literal("list"),
					Type.Literal("update"),
					Type.Literal("remove"),
				],
				{ description: "要执行的操作" },
			),
			title: Type.Optional(Type.String({ description: "action=title/add/update:动作开头的单句标题" })),
			scope: Type.Optional(Type.String({ description: "action=title/add/update:详细范围(做什么、不做什么)" })),
			taskId: Type.Optional(Type.String({ description: "action=update/remove:目标任务 id,如 T2" })),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const s = deps.requireActive();

			if (params.action === "list") {
				const p = progressOf(s.tasks);
				return {
					content: [
						{
							type: "text",
							text: [
								`任务标题: ${s.taskTitle ?? "(未确立)"}`,
								s.taskScope !== undefined ? `范围: ${s.taskScope}` : "",
								`阶段: ${s.phase}  进度: ${p.done}/${p.total}`,
								"",
								summarizeTasks(s.tasks),
							]
								.filter((l) => l !== "")
								.join("\n"),
						},
					],
					details: undefined,
				};
			}

			if (params.action === "title") {
				if (params.title === undefined || params.title.trim() === "") {
					throw new Error("action=title 需要 title");
				}
				const first = s.taskTitle === undefined;
				s.taskTitle = params.title.trim();
				if (params.scope !== undefined) s.taskScope = params.scope.trim();
				deps.persist();
				return {
					content: [
						{
							type: "text",
							text:
								`任务标题${first ? "已确立" : "已修正"}: ${s.taskTitle}` +
								(s.taskScope !== undefined ? `\n范围: ${s.taskScope}` : ""),
						},
					],
					details: undefined,
				};
			}

			if (params.action === "add") {
				if (params.title === undefined || params.title.trim() === "") {
					throw new Error("action=add 需要 title");
				}
				const task: PlanTask = {
					id: `T${s.tasks.length + 1}`,
					title: params.title.trim(),
					scope: params.scope?.trim(),
					status: "planned",
				};
				s.tasks.push(task);
				deps.persist();
				return {
					content: [
						{
							type: "text",
							text: `已加入任务 ${task.id}: ${task.title}${task.scope !== undefined ? `\n范围: ${task.scope}` : ""}`,
						},
					],
					details: undefined,
				};
			}

			// update / remove
			if (params.taskId === undefined) throw new Error(`action=${params.action} 需要 taskId`);
			const target = s.tasks.find((t) => t.id === params.taskId);
			if (target === undefined) {
				throw new Error(`找不到任务 ${params.taskId}。现有: ${s.tasks.map((t) => t.id).join(", ") || "(空)"}`);
			}

			if (params.action === "remove") {
				if (target.status !== "planned") {
					throw new Error(`任务 ${target.id} 状态为 ${target.status},只能删除尚未开始(planned)的任务。`);
				}
				s.tasks = s.tasks.filter((t) => t.id !== params.taskId);
				deps.persist();
				return {
					content: [{ type: "text", text: `已删除任务 ${target.id}` }],
					details: undefined,
				};
			}

			if (params.title !== undefined) target.title = params.title.trim();
			if (params.scope !== undefined) target.scope = params.scope.trim();
			deps.persist();
			return {
				content: [{ type: "text", text: `已更新任务 ${target.id}: ${target.title}` }],
				details: undefined,
			};
		},
	});

	pi.registerTool({
		name: "deep_plan_step",
		label: "Advance Task Step",
		description:
			"推进单个任务的状态。action=start 开始;action=done 完成;action=skip 跳过;action=block 标记受阻(需 note);action=unblock 解除受阻。" +
			"只有执行阶段(批准后)才能推进状态;规划与审查阶段调用会被拒绝。" +
			"不传 taskId 时 start/done 作用于第一个 queued/active 任务。",
		promptSnippet: "Advance one task step (executing phase only)",
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("start"),
					Type.Literal("done"),
					Type.Literal("skip"),
					Type.Literal("block"),
					Type.Literal("unblock"),
				],
				{ description: "要执行的操作" },
			),
			taskId: Type.Optional(Type.String({ description: "目标任务 id;省略时 start/done 自动选第一个待办" })),
			note: Type.Optional(Type.String({ description: "备注;import block 时必填" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const s = deps.requireActive();

			// The phase guard is the whole point: structure may be planned while
			// gated, but nothing may claim execution progress before approval.
			if (deps.phaseOf() !== "executing") {
				throw new Error(
					`当前阶段是 ${deps.phaseOf()},不能推进任务状态。` +
						"规划/审查阶段只做任务拆解(deep_plan_task);" +
						"用户批准后调用 deep_plan_approve 进入执行阶段,才能用 deep_plan_step。",
				);
			}

			function pick(): PlanTask {
				if (params.taskId !== undefined) {
					const t = s.tasks.find((x) => x.id === params.taskId);
					if (t === undefined) {
						throw new Error(
							`找不到任务 ${params.taskId}。现有: ${s.tasks.map((x) => x.id).join(", ") || "(空)"}`,
						);
					}
					return t;
				}
				const candidate =
					s.tasks.find((x) => x.status === "active") ?? s.tasks.find((x) => x.status === "planned");
				if (candidate === undefined) {
					throw new Error("没有可推进的任务。先用 deep_plan_task action=add 建立任务清单。");
				}
				return candidate;
			}

			const task = pick();
			const now = Date.now();

			switch (params.action) {
				case "start": {
					if (task.status === "done") throw new Error(`任务 ${task.id} 已完成。`);
					const other = s.tasks.find((x) => x.status === "active" && x.id !== task.id);
					if (other !== undefined) {
						throw new Error(
							`任务 ${other.id} 仍在进行中。先 deep_plan_step action=done 收尾,再开始 ${task.id}。`,
						);
					}
					task.status = "active";
					task.startedAt = task.startedAt ?? now;
					task.note = params.note?.trim() ?? task.note;
					break;
				}
				case "done": {
					if (task.status === "planned") task.startedAt = now;
					task.status = "done";
					task.completedAt = now;
					task.note = params.note?.trim() ?? task.note;
					break;
				}
				case "skip": {
					task.status = "skipped";
					task.completedAt = now;
					if (params.note !== undefined) task.note = params.note.trim();
					break;
				}
				case "block": {
					if (params.note === undefined || params.note.trim() === "") {
						throw new Error("action=block 需要 note 说明受阻原因。");
					}
					task.status = "blocked";
					task.note = params.note.trim();
					break;
				}
				case "unblock": {
					if (task.status !== "blocked") throw new Error(`任务 ${task.id} 当前不是受阻状态。`);
					task.status = "active";
					task.note = params.note?.trim() ?? task.note;
					break;
				}
			}

			deps.persist();
			deps.sync(ctx);

			const p = progressOf(s.tasks);
			const remaining = s.tasks.filter((t) => t.status === "planned").map((t) => t.id);
			const allSettled = p.done === p.total && p.total > 0;
			return {
				content: [
					{
						type: "text",
						text: [
							`${STATUS_MARK[task.status]} ${task.id} → ${task.status}: ${task.title}`,
							task.note !== undefined ? `备注: ${task.note}` : "",
							`进度: ${p.done}/${p.total}`,
							remaining.length > 0 ? `未开始: ${remaining.join(", ")}` : "",
							allSettled
								? "全部任务已完成。做完整体验证后调用 deep_plan_finish 收尾。"
								: "继续下一个任务: deep_plan_step action=start",
						]
							.filter((l) => l !== "")
							.join("\n"),
					},
				],
				details: undefined,
			};
		},
	});
}
