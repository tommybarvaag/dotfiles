---
name: git-pr-summary
description: Create a concise pull request summary in markdown format based on the provided git diff context. Use when generating pull request summaries, summarizing code changes, or when the user needs to communicate the purpose of their changes effectively.
---

# PR Summary

Create a concise pull request summary in markdown format based on the provided git diff context.

## Guidelines

- Follow instructions carefully.
- Focus on the "why" behind the changes, not just the "what".
- Keep it concise: 1-5 bullet points are ideal.
- Use clear, simple language.
- Avoid generic terms; be specific about the changes made.
- Review the summary to ensure it accurately reflects the changes and their purpose.
- Never add 🤖 Generated with Claude Code to the summary or any other Claude-related metadata to the summary.

## Analysis Steps

1. List commits since diverging from the main branch.
2. Summarize the nature of the changes (e.g., new feature, bug fix, refactoring).
3. Brainstorm the motivation behind these changes.
4. Assess the impact on the overall project.
5. Do not use tools to explore code, beyond what is available in the git context.
6. Check for any sensitive information that shouldn't be committed.
7. Draft the pull request summary.
8. Draft a concise (1-5 bullet points) pull request summary that focuses on the "why" rather than the "what"
9. Ensure the summary accurately reflects all changes since diverging from the main branch
10. Ensure your language is clear, concise, and to the point
11. Ensure the summary accurately reflects the changes and their purpose (ie. "add" means a wholly new feature, "update" means an enhancement to an existing feature, "fix" means a bug fix, etc.)
12. Ensure the summary is not generic (avoid words like "Update" or "Fix" without context)
13. Review the draft summary to ensure it accurately reflects the changes and their purpose
14. Remember to be concise, focus on the message, but keep it simple and as short as possible without losing context.

## Output

- Use Title Case for the summary title, keep the title short and descriptive
- No nested lists
- Keep the markdown simple
- Avoid using big words like "enhance"—and instead use developer-friendly terms like "add", "update", "fix", "remove" or "refactor" etc.
- Nice to point out fixing typos in this format: Fix typos in Swedish table headers (\`Benamning\` -> \`Benämning\`).
- Nice to point out removing unused code in this format: Remove the \`Profil-ID\` field from the power trade details section in the product page.

## Steps

1. Run `git diff main --diff-algorithm=minimal` to review the changes
2. Analyze the changes and determine the appropriate conventional commit type:
3. Draft the pull request summary based on the analysis steps above
4. Review the draft summary to ensure it accurately reflects the changes and their purpose
5. Output the summary in markdown format for easy copy/paste
6. Pipe the output to your clipboard using `pbcopy` (macOS) or `xclip` (Linux) — no need to prompt for confirmation add it automatically to ``pbcopy` or `xclip` at the end of your command chain.
