---
name: debug
description: Debug a bug, crash, failing test or error systematically instead of guessing. Use when something does not work and the cause is not obvious.
---

# Debug systematically

Guessing and changing random things is slow and makes a mess. Work from evidence.

1. **Reproduce it.** Find the exact command, input or steps that trigger the problem, and confirm you can make it happen. If you cannot reproduce it, you cannot fix it — gather more information first.
2. **Read the actual error.** The full message, the stack trace, the first failure (not the last line). The real cause is usually the first error, not the cascade after it.
3. **Locate the source.** Use Grep/Glob to find the code named in the error, and Read it and its callers. Understand what the code actually does before changing it.
4. **Form one hypothesis.** State what you think is wrong and why. Confirm it cheaply — add a log line, read a value, check an assumption — before editing.
5. **Make the smallest fix** that addresses the root cause, not the symptom. One change at a time.
6. **Verify it.** Reproduce again: the problem is gone and nothing else broke (see the verify skill). If it is not gone, your hypothesis was wrong — go back to step 4 with what you learned.

Never "fix" by deleting the check that reports the problem. If you are stuck after a few focused attempts, explain what you found and ask the user.
