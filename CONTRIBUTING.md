# Contributing

## Setup

Node.js 20.11 or newer on a POSIX system. Tests start real shells, so they do not run on Windows.

```bash
npm install
npm run verify
```

`verify` checks formatting, lints, typechecks, builds and runs the tests. It must pass before a change is merged.

## Tests

- `test/session.test.ts` runs the session suite once per shell found among `/bin/sh`, `/bin/bash` and `/bin/dash`. Install `dash` to cover the strictest one.
- `test/integration.test.ts` starts real server and controller runtimes over dead-drop's filesystem transport in a temporary folder. No network, no GitHub.
- Anything that touches delivery (duplicates, restarts, timeouts) needs a test that proves a command does not run twice.

## Commits

[Angular convention](https://github.com/angular/angular/blob/main/CONTRIBUTING.md#commit): `type(scope): subject` with types `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`. Scopes in use: `session`, `ledger`, `server`, `cli`, `config`, `examples`. One logical change per commit. User-visible changes get a short line in [CHANGELOG.md](CHANGELOG.md).

## Style

Prettier and ESLint decide code style. In markdown, one paragraph per line, no hard wrapping.

## Before proposing a feature

Read "What it is not" in the [README](README.md). PTY support, streaming and cancellation are planned as a separate phase; a pull request for them should start as an issue describing the protocol change.
