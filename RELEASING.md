# Releasing Canopy

Canopy uses [release-it](https://github.com/release-it/release-it) with
[Conventional Commits](https://www.conventionalcommits.org/) to automate
version bumping and changelog generation.

---

## Prerequisites

- You are on the `main` branch with a clean working directory.
- All changes intended for the release are committed and passing CI.
- `npm install` has been run so `release-it` and its plugin are available.

---

## Commit message convention

The release tooling reads commit messages to determine the version bump and
what appears in `CHANGELOG.md`. Use these prefixes from the root of every
commit subject line:

| Prefix | What it means | Version bump |
|---|---|---|
| `feat:` | New user-facing feature | **minor** |
| `fix:` | Bug fix | **patch** |
| `perf:` | Performance improvement | **patch** |
| `refactor:` | Internal restructuring, no behaviour change | **patch** |
| `chore:` | Maintenance (deps, tooling, config) | none (hidden) |
| `docs:` | Documentation only | none (hidden) |
| `build:` | Build system / CI changes | none (hidden) |
| `test:` | Tests only | none (hidden) |
| `feat!:` or `BREAKING CHANGE:` in body | Breaking API change | **major** |

> Commits without a recognised prefix are ignored by the changelog. They
> still land in `main` but will not appear in release notes.

### Examples

```
feat: add ty LSP support alongside basedpyright
fix: walk-up venv discovery no longer throws on NFS mounts
perf: replace recursive dir scan with O(depth) walk-up
refactor: extract isUnder() path utility to src/lib/path.ts
chore: bump electron to 41.2.1
```

---

## Making a release

### Interactive (recommended)

```bash
npm run release
```

release-it will:

1. Read commits since the last `vX.Y.Z` tag.
2. Propose the next version (patch / minor / major) based on those commits.
3. Show you a preview of the changelog entries.
4. Ask for confirmation before writing anything.
5. Bump the version in `package.json`.
6. Prepend the new section to `CHANGELOG.md`.
7. Commit both files as `chore: release vX.Y.Z`.
8. Create an annotated git tag `vX.Y.Z`.

You then push the tag manually (see below) so you control when the release becomes public.

### Non-interactive (CI / when you already know the bump)

```bash
npm run release:patch   # 1.2.3 → 1.2.4
npm run release:minor   # 1.2.3 → 1.3.0
npm run release:major   # 1.2.3 → 2.0.0
```

---

## After the release commit is created

```bash
# Push the commit and the tag
git push && git push --tags
```

Then build and distribute the platform binaries:

```bash
npm run build:mac     # → dist-electron/canopy-mac-<arch>-<version>.dmg
npm run build:linux   # → dist-electron/canopy-linux-<arch>-<version>.{AppImage,deb,rpm}
npm run build:win     # → dist-electron/canopy-win-<arch>-<version>.exe
```

Attach the artifacts to the GitHub release created from the tag, or upload
them to your distribution channel of choice.

---

## First-time setup (tagging an existing codebase)

If the repository has never had a `vX.Y.Z` tag, release-it has no baseline
to diff against. Tag the current state before running your first release:

```bash
git tag v1.0.4          # match the version in package.json
git push --tags
```

All subsequent `npm run release` calls will produce changelogs relative to
this tag.

---

## Troubleshooting

| Error | Fix |
|---|---|
| `Working directory must be clean` | Commit or stash all changes first. |
| `Current branch must be main` | Switch to `main` before releasing. |
| `No commits since last tag` | Nothing to release; all commits since the last tag must be ignorable (`chore:` / `docs:` only) or there simply are none. |
| Changelog is empty despite new commits | Commit messages are missing a recognised prefix. Reword with `git rebase -i` before releasing, or accept that those commits stay hidden. |
