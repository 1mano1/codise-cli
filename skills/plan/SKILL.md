---
name: plan
description: Plan before acting on a non-trivial or multi-step task. Use for anything that touches several files, needs installs/builds, or is not obvious in one step.
---

# Plan before you act

For any task that is not a one-liner, make a short plan first. This keeps you from wandering and from making changes that cancel each other out.

1. **Understand the goal.** Restate, in one sentence, what "done" looks like. If it is ambiguous, ask the user one focused question before starting.
2. **Look before you leap.** Use Glob and Grep to find the relevant files and Read to understand them. Never guess file contents or APIs.
3. **Write the plan.** Create a short task list with TodoWrite: 3-7 concrete steps, each one verifiable. Order them so each step builds on the last.
4. **Check feasibility.** If a step needs a program that is not installed, an Administrator action, a login, or a paid resource, note it now and tell the user — do not discover it halfway and get stuck.
5. **Execute one step at a time.** Do the step, mark it done, then move on. Keep the list updated so the user can see progress.
6. **Stop and reconsider** if two attempts at the same step fail: the plan or the assumption is wrong, not the number of tries.

Keep the plan lightweight — it is a map, not a document. Spend your effort on the work, not on describing it.
