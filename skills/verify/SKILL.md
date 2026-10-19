---
name: verify
description: Verify your changes actually work before telling the user you are done. Use after editing code, fixing a bug, or adding a feature.
---

# Verify your work

Do not claim something works until you have checked it. A change that looks right but was never run is not finished.

1. **Find how this project checks itself.** Look for test, build, lint or typecheck commands (package.json scripts, Makefile, README, pyproject, etc.) with Glob/Read.
2. **Run them** on the part you changed (the whole suite if it is fast). Use the Bash tool.
3. **Read the result honestly.** If it fails, read the actual error, find the root cause, fix it, and run again. Do not paper over a failure or disable a test to make it pass.
4. **Check you did not break anything else** that depends on what you touched.
5. **For code with no tests,** at least run the file or a small reproduction to confirm it behaves as intended, and consider adding a test.
6. **Report truthfully.** Tell the user what you verified and how (which command, what result). If something still fails or you could not verify it, say so plainly instead of implying success.

If a verification command is missing a tool or needs the user, say what they must do rather than guessing.
