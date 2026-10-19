---
name: review
description: Review code or a diff for bugs, risks and quality before committing or finishing. Use when asked to review, or to self-check a change before a commit/PR.
---

# Review changes

Look at the change the way a careful reviewer would, focused on what actually matters.

1. **See the change.** Use `git diff` (or `git diff --staged`) to view exactly what changed, and Read the surrounding code for context.
2. **Correctness first.** Does it do what it should? Look for off-by-one errors, wrong conditions, unhandled errors, null/undefined, edge cases (empty input, large input, concurrency), and resource leaks.
3. **Safety.** No secrets or keys committed. No destructive action without need. Input that comes from outside is validated. No obvious injection or path-traversal.
4. **Fit.** It follows the project's existing style, naming and libraries. It does not duplicate something that already exists. It is not more complex than the problem requires.
5. **Tests.** The change is covered by a test, or you explain why not. Tests assert real behavior, not trivially-true things.
6. **Report.** List findings most-important first, each with the file:line and a concrete fix. If it is clean, say so briefly. Do not invent problems to look thorough.

Keep it proportional: a one-line fix needs a glance, a new module needs real scrutiny.
