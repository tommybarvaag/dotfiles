---
name: git-pr-summary
description: Create a concise pull request summary in markdown format based on the provided git diff context. Use when generating pull request summaries, summarizing code changes, or when the user needs to communicate the purpose of their changes effectively.
---

# PR Summary

Create a concise pull request summary in markdown format based on the provided git diff context.

## Repository template

Look for the repository's pull request template before drafting: `.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE.md`, a file under `.github/PULL_REQUEST_TEMPLATE/`, or `pull_request_template.md` at the root or in `docs/`. When one exists, it is the output format:

- Keep its headings, in order, and fill every section from the diff and the verification that was run.
- Replace each HTML comment with the content it asks for.
- Read the contributing guide the template or `AGENTS.md` points to, and meet what it asks of a PR, such as before and after screenshots or a list of the checks run and what could not be checked.
- Write no heading of your own above the template's sections. GitHub can use the body's first line as the squash-merge title, so the PR title stays the conventional commit title.

The guidelines below still shape the wording. The default format under Output applies only when the repository has no template.

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
5. Do not use tools to explore code, beyond what is available in the git context. The PR template and the contributing guide count as git context.
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

This default format applies only when the repository has no PR template.

- Use Title Case for the summary title, keep the title short and descriptive
- No nested lists
- Keep the markdown simple
- Avoid using big words like "enhance"—and instead use developer-friendly terms like "add", "update", "fix", "remove" or "refactor" etc.
- Nice to point out fixing typos in this format: Fix typos in Swedish table headers (\`Benamning\` -> \`Benämning\`).
- Nice to point out removing unused code in this format: Remove the \`Profil-ID\` field from the power trade details section in the product page.

## Steps

1. Find the repository template (see Repository template) and run `git diff main --diff-algorithm=minimal` to review the changes
2. Analyze the changes and determine the appropriate conventional commit type:
3. Draft the pull request summary based on the analysis steps above
4. Review the draft summary to ensure it accurately reflects the changes and their purpose
5. Output the summary in markdown format for easy copy/paste
6. Pipe the output to your clipboard using `pbcopy` (macOS) or `xclip` (Linux) — no need to prompt for confirmation add it automatically to ``pbcopy` or `xclip` at the end of your command chain.
