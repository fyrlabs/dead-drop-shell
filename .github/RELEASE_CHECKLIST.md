# Release checklist

Work top to bottom. The tag name and GitHub release title are both `vX.Y.Z`, matching `package.json`; the release workflow refuses a mismatch.

## Versioning

The version moves once per release, not per commit. Between releases, `CHANGELOG.md` collects changes under `## Unreleased`. While the major version is 0, a breaking change bumps the minor version and anything else bumps the patch version.

## 1. Before you touch the version

- [ ] `main` is green in CI.
- [ ] `npm ci && npm run verify` passes from a clean checkout.
- [ ] `npm pack --dry-run` lists only `dist/`, `docs/`, `examples/`, `README.md`, `SECURITY.md`, `CHANGELOG.md`, `LICENSE`, `package.json`, and nothing left over from renamed source files.
- [ ] No tracked file contains a home path: `git ls-files -z | grep -zv '^\.github/RELEASE_CHECKLIST\.md$' | xargs -0 grep -nlI -e '/Users/' -e '/home/runner'` prints nothing.
- [ ] `docs/configuration.md` matches `src/config.ts`.

## 2. Cut the release

- [ ] Set `version` in `package.json` and run `npm install` so `package-lock.json` follows.
- [ ] Rename `## Unreleased` in `CHANGELOG.md` to `## X.Y.Z`. Breaking changes are called out.
- [ ] Commit as `chore(release): vX.Y.Z` and push.

```bash
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z                                       # a marker, nothing published yet
gh release create vX.Y.Z --title "vX.Y.Z" --notes-file notes.md   # publishes to npm
gh run watch $(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status
```

If the release exists but the run failed, rerun it with `gh workflow run release.yml -f ref=vX.Y.Z` instead of re-tagging.

The workflow needs an `NPM_TOKEN` repository secret: an npm automation token with publish rights on the `@fyrlabs` scope.

## 3. Verify the published package

- [ ] In an empty folder: `npm install -g @fyrlabs/dead-drop-shell@X.Y.Z --prefix ./p && ./p/bin/ddshell --version` prints `X.Y.Z`.
- [ ] Provenance shows on the npm package page.
- [ ] Open a new `## Unreleased` section in `CHANGELOG.md`.

Deprecate a version only when it is actually bad, never merely superseded. Never unpublish; a version number can never be reused.
