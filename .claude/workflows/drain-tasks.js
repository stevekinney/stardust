export const meta = {
	name: 'drain-tasks',
	description:
		'Drain incomplete tasks from the Scrumlord tasks CLI one at a time: claim → implement (TDD) → gate → review → local merge to main → mark complete. Round-based and sequential (merge-before-next) so each task branches from an up-to-date main; trusts the tasks CLI for ordering/blocking/claiming.',
	whenToUse:
		'When you want to autonomously work through `tasks list --incomplete` to merged-on-main, local-only (no GitHub PR/CI).',
	phases: [
		{ title: 'Survey', detail: 'tasks available --json → pick the next claimable task' },
		{ title: 'Drain', detail: 'per task: implement → review → merge to main → complete' },
		{ title: 'Verify', detail: 'confirm the queue is drained' }
	]
};

// ---------------------------------------------------------------------------
// Config (override via the Workflow tool's `args`)
// ---------------------------------------------------------------------------
const cfg = typeof args === 'string' ? JSON.parse(args) : (args ?? {});
const ON_STUCK = cfg.onStuck ?? 'stop'; // 'stop' | 'skip'
const MERGE = cfg.merge ?? true; // true: merge to main + complete; false: stop at committed branch
const REVIEW = cfg.review ?? true; // adversarial diff review before merge
const INCLUDE_E2E = cfg.includeE2E ?? false; // run `bun run test:e2e` (playwright) as a gate
const MAX_TASKS = cfg.maxTasks ?? 0; // 0 = unlimited (capped by ABS_CAP)
const ONLY_TASK = cfg.taskId ?? null; // run exactly one task whose id starts with this (validation run)
const MAX_FIX = cfg.maxFix ?? 2; // fix iterations allowed after a 'changes-needed' review
const INFRA_RETRIES = cfg.infraRetries ?? 3; // attempts when an agent DIES (null result, e.g. API stall) before calling it an infra failure
const INFRA_HALT = cfg.infraHalt ?? 2; // halt the whole drain after this many CONSECUTIVE infra failures (API likely down)
const ABS_CAP = MAX_TASKS > 0 ? MAX_TASKS : 30;

// Standard gates, run inside the task worktree, in order. The per-task gate
// (the "Gate:" line in the task description) is run by the worker IN ADDITION.
const STANDARD_GATES = [
	'bun run format:check',
	'bun run lint',
	'bun run typecheck',
	'bun run test:unit -- --run',
	...(INCLUDE_E2E ? ['bun run test:e2e'] : [])
];

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const SURVEY_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		available: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				properties: {
					id: { type: 'string' },
					title: { type: 'string' },
					priority: { type: 'number' }
				},
				required: ['id', 'title']
			}
		},
		remainingCount: { type: 'number' },
		blocked: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				properties: {
					id: { type: 'string' },
					title: { type: 'string' },
					blockedBy: { type: 'array', items: { type: 'string' } }
				},
				required: ['id', 'title']
			}
		}
	},
	required: ['available', 'remainingCount', 'blocked']
};

const IMPL_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		id: { type: 'string' },
		status: { type: 'string', enum: ['implemented', 'stuck'] },
		branch: { type: 'string' },
		worktreePath: { type: 'string' },
		summary: { type: 'string' },
		filesTouched: { type: 'array', items: { type: 'string' } },
		gatesRun: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				properties: { cmd: { type: 'string' }, passed: { type: 'boolean' } },
				required: ['cmd', 'passed']
			}
		},
		commitSha: { type: 'string' },
		reason: { type: 'string' }
	},
	required: ['id', 'status', 'summary']
};

const REVIEW_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		verdict: { type: 'string', enum: ['approve', 'changes-needed'] },
		blocking: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				properties: { file: { type: 'string' }, issue: { type: 'string' } },
				required: ['issue']
			}
		},
		notes: { type: 'string' }
	},
	required: ['verdict']
};

const MERGE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		id: { type: 'string' },
		status: { type: 'string', enum: ['merged', 'conflict', 'failed'] },
		mergeCommit: { type: 'string' },
		completedMarked: { type: 'boolean' },
		worktreeCleaned: { type: 'boolean' },
		reason: { type: 'string' }
	},
	required: ['id', 'status']
};

const VERIFY_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		remainingCount: { type: 'number' },
		completedCount: { type: 'number' },
		mainGatesGreen: { type: 'boolean' },
		notes: { type: 'string' }
	},
	required: ['remainingCount']
};

// ---------------------------------------------------------------------------
// Prompts (every shell/git/tasks interaction lives INSIDE an agent — the
// script body has no filesystem or shell access of its own)
// ---------------------------------------------------------------------------
const RULES = `
Hard rules (from the project's engineering standards — non-negotiable):
- NO silent deferral. Never weaken, skip, .skip/.only/xfail, or comment out a test; never bump a timeout/retry/polling cap; never use --no-verify or bypass hooks; never delete or weaken an assertion to go green. A red gate is a STUCK signal — return status "stuck" with the root-cause reason. Do not paper over it.
- TDD by default: write/extend tests first where practical, then implement until green. Every fix gets a regression test.
- Surgical changes only: touch what the task requires; match existing codebase conventions (TypeScript, kebab-case filenames, bun runtime, Svelte 5 runes). Do not refactor unrelated code.
- Cap your own retry loops at 5 attempts, then surface the blocker as "stuck" rather than looping.
`.trim();

const surveyPrompt = `
You are surveying a Scrumlord task queue. Working directory is the git repo root.

Run these and parse their JSON:
- \`tasks available --json\`  (ready, UNBLOCKED tasks — this is the authoritative claim order; do NOT re-sort)
- \`tasks remaining\`         (count of incomplete tasks)
- \`tasks list --incomplete\` (to identify which incomplete tasks are blocked, i.e. "blocked": true)

Return:
- available: the tasks from \`tasks available\` IN THE ORDER GIVEN (id, title, priority).
- remainingCount: the \`tasks remaining\` number.
- blocked: incomplete tasks with "blocked": true (id, title, and their blockedBy ids).

Do not start, claim, edit, or modify anything. Read-only survey.
`.trim();

function implementPrompt(task) {
	const short = task.id.slice(0, 8);
	return `
You are an autonomous engineer implementing ONE task to a mergeable state on its own branch. Working directory is the git repo root (local-only repo: there is NO GitHub remote, NO CI, NO PRs — work lands by a LOCAL merge into main, which a later step performs. You do NOT merge.).

TASK ID: ${task.id}
TITLE: ${task.title}

${RULES}

Steps — follow exactly:

1. Read full task context: \`tasks get ${task.id}\`. The description names files to "Read first" (e.g. ARCHITECTURE.md sections) and exact code locations / audit findings. Read every cited file and location before writing code. Verify each audit claim at its cited location — fix the real defect, not a guess.

2. Plan: write a concise implementation plan to \`tmp/plans/${short}.md\` (problem, approach, files, test strategy, the task's acceptance gate). Then:
   - \`tasks update ${task.id} --plan tmp/plans/${short}.md\`
   - \`tasks update ${task.id} --status in-progress\`

3. Claim a worktree + branch (manual path — do NOT use \`tasks start\`, it launches a nested agent CLI):
   - Ensure main is current: from the repo root, \`git fetch\` is a no-op (no remote) — just confirm you are based on the latest local \`main\`.
   - Create the worktree fresh from the latest local \`main\`: \`git worktree add tmp/worktrees/tasks/${short} -b task/${short} main\`
     If the branch \`task/${short}\` OR the path \`tmp/worktrees/tasks/${short}\` already exists, it is leftover from a FAILED prior attempt — do NOT reuse its partial/uncommitted state. Wipe it for a clean slate: \`git worktree remove tmp/worktrees/tasks/${short} --force\` (ignore errors), then \`git worktree prune\`, then \`git branch -D task/${short}\` (ignore errors), then re-run the \`git worktree add ... -b task/${short} main\`. (Policy blocks \`git reset --hard\` and \`git checkout --\`; use worktree-remove + branch -D for the clean slate, never a hard reset.)
   - \`tasks update ${task.id} --branch task/${short}\`
   - Do ALL implementation work inside \`tmp/worktrees/tasks/${short}\`.

4. Implement the task in the worktree. Record meaningful milestones with \`tasks progress add --message "..."\`.

5. Run gates INSIDE the worktree (cd into it). ALL must pass:
   a. The task's own gate from its "Gate:" line. If it reads like \`bun run vitest run <path>\`, run it as \`bunx vitest run <path>\` (there is no \`vitest\` npm script; \`bunx vitest\` is correct). This is the scoped test for the area you changed — add/extend those tests.
   b. Then the standard gates, in order: ${STANDARD_GATES.map((g) => `\`${g}\``).join(', ')}.
   If a gate fails: diagnose and fix the ROOT CAUSE (max 5 attempts). If you genuinely cannot make a gate pass without weakening it, STOP and return status "stuck" with the failing gate output summarized in reason. Never weaken the gate.

6. Commit on the branch (in the worktree). Stage your changes and commit with a clear message describing what shipped. End the commit message with this exact trailer line:
   Claude-Session: https://claude.ai/code/session_01SJiUfaJTZEv1dvJ49LB7Tt
   Do NOT use --no-verify. Do NOT merge to main. Do NOT mark the task completed.

Return: id, status ("implemented" if every gate passed and you committed; "stuck" otherwise), branch, worktreePath, summary (what you changed and why), filesTouched, gatesRun (each cmd + passed), commitSha, and reason (only if stuck — the specific blocker + root-cause read).
`.trim();
}

function reviewPrompt(task, impl) {
	const short = task.id.slice(0, 8);
	return `
You are an adversarial reviewer. A task was implemented on branch \`${impl.branch}\` (worktree \`${impl.worktreePath}\`). Decide whether it is correct and complete enough to merge into main.

TASK ID: ${task.id}
TITLE: ${task.title}
IMPLEMENTER SUMMARY: ${impl.summary}

Do this:
1. \`tasks get ${task.id}\` — re-read the acceptance criteria and every audit finding/cited location in the description.
2. Inspect the diff: \`git -C ${impl.worktreePath} diff main...task/${short}\` (and read changed files in full where needed).
3. Verify, concretely:
   - Each acceptance criterion / audit finding in the description is actually addressed at the cited location — not stubbed, faked, or partially done.
   - No placeholder/TODO/dummy data, no weakened/skipped tests, no silenced warnings or bypassed gates.
   - The change is surgical and matches codebase conventions; no unrelated churn.
   - Tests genuinely exercise the new behavior (a regression test exists for any bug fixed).
4. Optionally re-run the task's scoped gate (\`bunx vitest run <path>\`) inside the worktree if you doubt a claim.

VERDICT RULE — the verdict is driven ONLY by BLOCKING issues, not by taste:
- An issue is BLOCKING only if it is one of: (a) an acceptance criterion / audit finding in the description is NOT genuinely addressed at its cited location (stubbed, faked, partial, or fixed in the wrong place); (b) a test was weakened, skipped, deleted, or a gate bypassed; (c) a real correctness or security defect was introduced; (d) placeholder/TODO/dummy/lorem data shipped in non-test code.
- NON-BLOCKING (note only, NEVER block): style/naming nits, subjective approach preferences that still meet the criteria, speculative-but-harmless values, possible future improvements.
- Put every blocking issue in the \`blocking\` array (file + issue). Put non-blocking observations in \`notes\`.
- If \`blocking\` would be EMPTY, you MUST return "approve" — even if you would have built it differently. Return "changes-needed" only when \`blocking\` is non-empty. Do not edit code yourself.
`.trim();
}

function fixPrompt(task, impl, review) {
	const blockers = (review.blocking ?? [])
		.map((b) => `- ${b.file ? b.file + ': ' : ''}${b.issue}`)
		.join('\n');
	return `
You are fixing review-blocking issues on branch \`${impl.branch}\` (worktree \`${impl.worktreePath}\`) for task ${task.id} (${task.title}).

${RULES}

A reviewer blocked the merge. Address EVERY item below at its root cause, in the worktree:
${blockers || review.notes || '(see reviewer notes)'}
Reviewer notes: ${review.notes ?? '(none)'}

Then re-run the FULL gate set inside the worktree (the task's scoped \`bunx vitest run <path>\` gate, then ${STANDARD_GATES.map((g) => `\`${g}\``).join(', ')}). All must pass. Commit the fixes on the same branch with the trailer:
Claude-Session: https://claude.ai/code/session_01SJiUfaJTZEv1dvJ49LB7Tt
Do NOT merge. Do NOT mark completed. If you cannot resolve a blocker without weakening a gate, return status "stuck" with the reason.

Return the same shape as the implement step (id, status, branch, worktreePath, summary, filesTouched, gatesRun, commitSha, reason).
`.trim();
}

function mergePrompt(task, impl) {
	const short = task.id.slice(0, 8);
	return `
You are landing an approved task into local main. Working directory is the git repo root. Branch \`task/${short}\` (worktree \`${impl.worktreePath}\`) is committed and review-approved.

TASK ID: ${task.id}
TITLE: ${task.title}

Steps:
1. From the repo root, confirm you are on \`main\` and the working tree is clean (\`git status\`). If dirty with unrelated changes, STOP and return status "failed" with reason.
   IDEMPOTENCY: if \`git branch --merged main\` already lists \`task/${short}\`, a prior merge attempt already landed it — SKIP step 2, set mergeCommit to the existing merge commit (\`git log --oneline -5\`), and go straight to step 5 (complete) and step 6 (cleanup). Return status "merged".
2. Merge the branch (mirror the repo's existing history style — a no-ff merge commit named like prior "merge task ..." commits):
   \`git merge --no-ff task/${short} -m "merge task ${short}: ${task.title.replace(/"/g, "'")}"\`
   Do NOT use --no-verify.
3. If the merge conflicts: attempt a clean resolution ONLY if trivial and obviously correct. If non-trivial, abort (\`git merge --abort\`) and return status "conflict" with the conflicting files in reason — do not force it.
4. After a clean merge, sanity-check main still builds: run \`bun run typecheck\` at the repo root. If it fails because of the merge, return status "failed" with reason (do not leave main broken — but do not weaken anything).
5. Mark the task done: \`tasks complete ${task.id}\` (local-only repo; this is the right call, NOT \`--sync\`).
6. Clean up: \`git worktree remove tmp/worktrees/tasks/${short} --force\` and \`git branch -d task/${short}\` (keep the branch if delete fails; note it).

Return: id, status ("merged" on success), mergeCommit (the merge commit sha), completedMarked, worktreeCleaned, and reason (if conflict/failed).
`.trim();
}

const verifyPrompt = `
You are confirming a task-drain run landed. Working directory is the git repo root. Run and report:
- \`tasks remaining\` → remainingCount
- \`tasks completed\` → completedCount (length of the list)
- \`bun run typecheck && bun run lint\` at the repo root → mainGatesGreen (true only if both pass)
Add a short notes line. Read-only except for running the gates.
`.trim();

// ---------------------------------------------------------------------------
// Per-task lifecycle: implement → review (+bounded fixes) → merge
// ---------------------------------------------------------------------------
// Run an agent, retrying ONLY on death (null result — e.g. an API stall mid-stream).
// A non-null result (including a real {status:'stuck'} verdict) is returned as-is.
// Returns null only if the agent died on every attempt → an infra failure.
async function resilientAgent(prompt, opts) {
	for (let attempt = 1; attempt <= INFRA_RETRIES; attempt++) {
		const r = await agent(
			prompt,
			attempt > 1 ? { ...opts, label: `${opts.label}#${attempt}` } : opts
		);
		if (r) return r;
		if (attempt < INFRA_RETRIES)
			log(`  agent ${opts.label} died (attempt ${attempt}/${INFRA_RETRIES}) — retrying`);
	}
	return null;
}

async function drainOne(task) {
	const short = task.id.slice(0, 8);

	const impl = await resilientAgent(implementPrompt(task), {
		schema: IMPL_SCHEMA,
		phase: 'Drain',
		label: `impl:${short}`,
		effort: 'high'
	});
	if (!impl)
		return {
			task,
			outcome: 'infra',
			stage: 'implement',
			detail: `implement agent died/stalled ${INFRA_RETRIES}× (transient API failure)`
		};
	if (impl.status !== 'implemented')
		return {
			task,
			outcome: 'stuck',
			stage: 'implement',
			detail: impl.reason ?? 'implement returned stuck',
			impl
		};

	let current = impl;
	if (REVIEW) {
		let review = await resilientAgent(reviewPrompt(task, current), {
			schema: REVIEW_SCHEMA,
			phase: 'Drain',
			label: `review:${short}`
		});
		if (!review)
			return {
				task,
				outcome: 'infra',
				stage: 'review',
				detail: `review agent died/stalled ${INFRA_RETRIES}×`,
				impl: current
			};
		let fixes = 0;
		while (review.verdict === 'changes-needed' && fixes < MAX_FIX) {
			fixes++;
			log(`  ${short}: review wants changes (fix ${fixes}/${MAX_FIX})`);
			const fixed = await resilientAgent(fixPrompt(task, current, review), {
				schema: IMPL_SCHEMA,
				phase: 'Drain',
				label: `fix${fixes}:${short}`,
				effort: 'high'
			});
			if (!fixed)
				return {
					task,
					outcome: 'infra',
					stage: 'fix',
					detail: `fix agent died/stalled ${INFRA_RETRIES}×`,
					impl: current
				};
			if (fixed.status !== 'implemented')
				return {
					task,
					outcome: 'stuck',
					stage: 'fix',
					detail: fixed.reason ?? 'fix agent could not resolve review blockers',
					impl: current
				};
			current = fixed;
			review = await resilientAgent(reviewPrompt(task, current), {
				schema: REVIEW_SCHEMA,
				phase: 'Drain',
				label: `review${fixes + 1}:${short}`
			});
			if (!review)
				return {
					task,
					outcome: 'infra',
					stage: 'review',
					detail: `review agent died/stalled ${INFRA_RETRIES}×`,
					impl: current
				};
		}
		if (review.verdict === 'changes-needed') {
			const blockers = (review.blocking ?? [])
				.map((b) => `${b.file ? b.file + ': ' : ''}${b.issue}`)
				.join(' | ');
			return {
				task,
				outcome: 'stuck',
				stage: 'review',
				detail: `review unresolved after ${MAX_FIX} fixes — blocking: ${blockers || review.notes || '(none cited)'}`,
				impl: current
			};
		}
	}

	if (!MERGE)
		return { task, outcome: 'implemented-no-merge', branch: current.branch, impl: current };

	const merged = await resilientAgent(mergePrompt(task, current), {
		schema: MERGE_SCHEMA,
		phase: 'Drain',
		label: `merge:${short}`
	});
	if (!merged)
		return {
			task,
			outcome: 'infra',
			stage: 'merge',
			detail: `merge agent died/stalled ${INFRA_RETRIES}×`,
			impl: current
		};
	if (merged.status !== 'merged')
		return {
			task,
			outcome: 'stuck',
			stage: 'merge',
			detail: merged.reason ?? `merge returned ${merged.status}`,
			impl: current,
			merged
		};
	return { task, outcome: 'merged', mergeCommit: merged.mergeCommit, impl: current };
}

// ---------------------------------------------------------------------------
// Main drain loop — strictly sequential, forward-progress, merge-before-next
// ---------------------------------------------------------------------------
const results = [];
const handled = new Set();
let round = 0;
let consecutiveInfra = 0;

while (round < ABS_CAP) {
	phase('Survey');
	const survey = await agent(surveyPrompt, {
		schema: SURVEY_SCHEMA,
		phase: 'Survey',
		label: `survey:${round + 1}`
	});
	if (!survey) {
		log('Survey agent failed — stopping.');
		break;
	}

	const candidate = (survey.available || []).find(
		(t) => !handled.has(t.id) && (!ONLY_TASK || t.id.startsWith(ONLY_TASK))
	);

	if (!candidate) {
		const avail = (survey.available || []).length;
		if (ONLY_TASK) log(`Task ${ONLY_TASK} not in the available queue (done, blocked, or unknown).`);
		else if (avail === 0)
			log(
				`Queue drained of claimable work. remaining=${survey.remainingCount}, blocked=${(survey.blocked || []).length}.`
			);
		else log('All remaining available tasks were already handled (stuck) this run — stopping.');
		break;
	}

	round++;
	handled.add(candidate.id);
	phase('Drain');
	log(`Round ${round}/${ABS_CAP}: ${candidate.id.slice(0, 8)} — ${candidate.title}`);

	const r = await drainOne(candidate);
	results.push(r);

	if (r.outcome === 'merged') {
		log(`  ✓ merged ${candidate.id.slice(0, 8)} (${r.mergeCommit ?? 'sha?'})`);
		consecutiveInfra = 0;
	} else if (r.outcome === 'implemented-no-merge') {
		log(`  ✓ implemented (no merge) ${candidate.id.slice(0, 8)} on ${r.branch}`);
		consecutiveInfra = 0;
	} else if (r.outcome === 'infra') {
		consecutiveInfra++;
		log(
			`  ⚠ INFRA-FAIL ${candidate.id.slice(0, 8)} at ${r.stage}: ${r.detail} (consecutive=${consecutiveInfra}/${INFRA_HALT})`
		);
		if (consecutiveInfra >= INFRA_HALT) {
			log(
				`${INFRA_HALT} consecutive infra failures — infrastructure looks unstable. Halting; re-launch later to retry the skipped tasks (they remain ready).`
			);
			break;
		}
		log('Transient agent death — skipping this task and continuing with the next.');
	} else {
		consecutiveInfra = 0;
		log(`  ✗ STUCK ${candidate.id.slice(0, 8)} at ${r.stage}: ${r.detail}`);
		if (ON_STUCK === 'stop') {
			log('on_stuck=stop — halting the drain so the blocker can be triaged.');
			break;
		}
		log('on_stuck=skip — moving to the next task.');
	}

	if (ONLY_TASK) break;
}

// ---------------------------------------------------------------------------
// Verify + summarize
// ---------------------------------------------------------------------------
phase('Verify');
const verification = MERGE
	? await agent(verifyPrompt, { schema: VERIFY_SCHEMA, phase: 'Verify', label: 'verify' })
	: null;

const merged = results.filter((r) => r.outcome === 'merged');
const implementedOnly = results.filter((r) => r.outcome === 'implemented-no-merge');
const stuck = results.filter((r) => r.outcome === 'stuck');
const infra = results.filter((r) => r.outcome === 'infra');

log(
	`Done. merged=${merged.length} implemented-only=${implementedOnly.length} stuck=${stuck.length} infra-failed=${infra.length} rounds=${round}`
);

return {
	config: {
		onStuck: ON_STUCK,
		merge: MERGE,
		review: REVIEW,
		includeE2E: INCLUDE_E2E,
		maxTasks: MAX_TASKS,
		onlyTask: ONLY_TASK
	},
	rounds: round,
	merged: merged.map((r) => ({ id: r.task.id, title: r.task.title, mergeCommit: r.mergeCommit })),
	implementedOnly: implementedOnly.map((r) => ({
		id: r.task.id,
		title: r.task.title,
		branch: r.branch
	})),
	stuck: stuck.map((r) => ({
		id: r.task.id,
		title: r.task.title,
		stage: r.stage,
		detail: r.detail
	})),
	infraFailed: infra.map((r) => ({
		id: r.task.id,
		title: r.task.title,
		stage: r.stage,
		detail: r.detail
	})),
	verification
};
