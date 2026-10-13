---
name: git-commit-writer
description: Analyzes git diffs and writes structured, concise Conventional Commits and pull request summaries.
---

# Conventional Commit Guidelines

When asked to commit changes or generate commit messages:
1. Run `git status` and `git diff --staged` (or `git diff` if nothing is staged) to understand all changes.
2. Categorize the primary change using standard prefixes:
   - `feat:` New functionality
   - `fix:` Bug fix
   - `refactor:` Code change that neither fixes a bug nor adds a feature
   - `perf:` Performance improvements
   - `test:` Adding or fixing tests
   - `chore:` Tooling, dependencies, or config changes
3. Format output:
   - **First line**: `<type>(<optional-scope>): <imperative summary>` (maximum 72 characters, lowercase, no trailing period).
   - **Body (optional)**: Bullet points explaining *what* and *why*, not *how*.
4. Offer the exact terminal command ready to run (e.g., `git commit -m "..."`).