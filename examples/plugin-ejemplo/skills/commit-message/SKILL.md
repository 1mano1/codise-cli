---
name: commit-message
description: Writes a Conventional Commits message from the staged changes. Use when the user asks for a commit message or to commit.
---
1. Run `git diff --staged` (or `git diff` if nothing is staged).
2. Write one commit message in English following Conventional Commits:
   - `type(scope): summary` in imperative mood, max 72 characters.
   - Optional body with the why, wrapped at 72 characters.
3. Show the message and ask before running `git commit`.
