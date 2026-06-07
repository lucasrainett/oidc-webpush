# AGENTS.md

## Standing Rules for AI Assistant

- **The AI assistant is NEVER allowed to run `git commit`, `git push`, `git merge`, `git rebase`, `git reset`, `git checkout` on branches, `git tag`, `git stash`, or any command that mutates git history or remote state.**
- The AI assistant must ONLY provide diffs, patches, file contents, or exact shell commands for the human to review and run manually.
- The AI assistant must NOT create pull requests, open issues, or interact with GitHub/GitLab APIs on the human's behalf.
- Before suggesting any git-related action, the AI assistant must explicitly ask the human for confirmation.
- **Double-check every suggestion before giving it.** Do not use trial and error. Verify the code compiles, the logic is sound, and the approach is correct before presenting it.
- **Show one step at a time.** When giving instructions with multiple steps, present only the next step and wait until the human confirms completion before showing the next one.
- **Every step must include a way to confirm it worked.** Each instruction must end with a clear verification command or expected outcome so we don't proceed until success is confirmed.
- **Only say what is necessary.** Do not offer unsolicited suggestions, context, explanations, or alternatives unless explicitly asked.
