# Paperclip Development — Agent Rules

## Branch & Worktree Discipline

**Never commit directly to `master`.** All work goes on feature branches.

### Parallel Work
- Use `git worktree` or the `EnterWorktree` tool to isolate your work from other agents.
- Never assume you own the shared working directory at `/home/openclaw/paperclip`. Other agents may be using it.
- If you must work in the main checkout, check `git status` first and never discard uncommitted changes that aren't yours.

### Branch Naming
- Features: `feat/<ISSUE-ID>-short-description`
- Fixes: `fix/<ISSUE-ID>-short-description`
- Always include the Paperclip issue identifier (e.g., `LAS-142`).

### Commits
- Commit early and often. Uncommitted changes are invisible to other agents and will be lost on branch switches.
- Never leave work as uncommitted modifications overnight. If the work is incomplete, commit to a WIP branch.
- Use conventional commit prefixes: `feat:`, `fix:`, `chore:`, `docs:`.

### PRs and Merging
- Push feature branches to the `fork` remote (`https://github.com/lazmo88/paperclip.git`).
- Open PRs against `origin/master` (`https://github.com/paperclipai/paperclip.git`).
- After a PR is merged upstream, the local master must be updated: `git pull origin master`.
- Delete merged feature branches locally to reduce clutter.

## Dev Service

The `paperclip.service` systemd unit runs from the main checkout on `master`. To pick up merged PRs:

```bash
cd /home/openclaw/paperclip && git pull origin master && systemctl --user restart paperclip.service
```

Never switch the service checkout to a feature branch. If you need to test a feature branch, use a separate worktree or run the dev server manually in that worktree.

## Patches to Upstream Code

If you need to patch a file that will be overwritten by `pnpm install` or upstream merges, use `pnpm patch`:

```bash
pnpm patch <package-name>
# edit files in the temp directory
pnpm patch-commit <temp-dir>
```

This creates entries in `package.json` under `pnpm.patchedDependencies` and a `patches/` directory that survives installs.

For patches to Paperclip's own source (not node_modules), always commit to a branch. Never leave patches as uncommitted edits.
