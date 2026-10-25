# Delegating conflict resolution

Use this when step 3 has more than about 30 open files. You stay the coordinator: you dispatch, stage, verify and commit; the agents only edit files.

## Routing

The triage report (`$S/triage.txt`) already tiers every open file by its riskiest hunk. Dispatch each tier to that model with the Agent tool (`subagent_type: "general-purpose"`, `model` set per tier). Forks always run on the parent's model, so use fresh agents with the brief below.

| Tier          | Model    | What lands there                                                                                                                                                                            | Batch size                                                    |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `opus`        | `opus`   | Server orchestration, persistence, contracts, provider packages, hunks with control flow, Effect layers or schemas, hunks over 40 lines, and files whose fork feature upstream restructured | about 20 files, split by area                                 |
| `sonnet`      | `sonnet` | Both sides edited the same lines independently: UI, settings, mobile screens, tests                                                                                                         | about 25 files, split by area (web, mobile, server, packages) |
| `haiku`       | `haiku`  | The sides differ only in string or number literals, usually identity values                                                                                                                 | one agent for the lot                                         |
| modify/delete | `opus`   | Re-homing a fork change into code upstream moved or deleted                                                                                                                                 | with the opus batch for that area                             |

Keep files that share a feature in one batch, even across tiers (raise the batch to the higher tier): a fork feature split across two agents gets re-homed twice, differently. In particular, a fork change to a file upstream deleted goes in the same batch as every file that consumes it.

After the merge compiles, two more jobs go out the same way:

- **Compile errors (step 4):** send each package's errors back to the agent that resolved that area, with `SendMessage`, so it fixes them with its context intact.
- **Comment-length lint (step 6):** one `haiku` agent with the file:line list and the rule "shorten to four lines or fewer, keeping the constraint and any Kinako command or path names".

## Review

Before step 4, dispatch one `opus` agent to review the `sonnet` and `haiku` resolutions. Give it the file list and ask it to read `git diff MERGE_HEAD -- <file>` and `git diff HEAD -- <file>` for each, and report only defects: a dropped `break` or `return` where two sides' cases meet, a fork guard or feature lost, an upstream change lost, a `FORK_*` value replaced by an upstream literal. It edits nothing; you fix or re-dispatch what it reports.

## Brief

Each agent knows only its brief. Fill in the bracketed parts:

```text
You are resolving part of an in-progress git merge of upstream T3 Code (pingdotgg/t3code) into Kinako, a fork that must stay installable next to upstream. Other agents are resolving other files in the same working tree at the same time.

Read first: FORK.md ("Rebrand seams") and .agents/skills/merge-upstream/SKILL.md (step 3 and its known cases). Fork identity comes from packages/shared/src/forkBrand.ts (FORK_* constants).

Your files: [list]
Area notes: [what upstream changed in this area, from the scan or git log; fork features you know live here; files another agent owns that yours depend on]

Rules:
- Edit only your files, plus new files you must create to re-home fork code. Delete a file with plain `rm` and say so.
- The coordinator stages. Leave the index alone: no git add, rm, mv, commit, checkout, merge, stash, and no installs.
- Read-only git is yours: `git show :1:<f>` (base), `:2:<f>` (fork), `:3:<f>` (upstream), `git log`, `git diff`.
- Conflicts are in diff3 form, with the base between `|||||||` and `=======`.
- Resolve by intent: keep upstream's change and the fork's identity and features. Where both sides add cases, entries or handlers side by side, take both and check the seam between them.
- Skip typecheck and tests until the coordinator says the tree is resolved.

Finish when none of your files contains a conflict marker. Report: per file, one sentence on the resolution; anything you re-homed and where; files outside your list you edited; anything needing a human decision.
```
