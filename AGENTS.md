# Notes for coding agents

`@fyrlabs/dead-drop-shell` (binary `ddshell`): a line-oriented remote shell over `@fyrlabs/dead-drop`. Read [docs/architecture.md](docs/architecture.md) first.

## Commands

```bash
npm install
npm run verify      # format:check, lint, typecheck, build, test; must pass before every commit
npm test            # vitest; the session suite runs under every shell in /bin/sh, /bin/bash, /bin/dash that exists
npm run format      # prettier --write
```

## Layout

| Path              | Contents                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `src/session.ts`  | `ShellSession`: one long-lived child shell, nonce-delimited command trailer, output cap, timeouts |
| `src/ledger.ts`   | `JobLedger`: one JSON file per job id, atomic writes, `running` becomes `unknown` on open         |
| `src/protocol.ts` | `shell.v1` request and response types, `parseRequest`                                             |
| `src/config.ts`   | `shell` config section, defaults, `loadConfig`                                                    |
| `src/server.ts`   | `ShellServer`: embedded runtime, authorisation, sessions, ledger, idle sweep                      |
| `src/client.ts`   | `ShellClient`, `RemoteSession`                                                                    |
| `src/cli.ts`      | argument parsing, interactive loop, `exec`, exit codes                                            |
| `test/`           | unit tests plus integration tests over dead-drop's filesystem transport                           |

## Invariants: do not break these

- Authorise on `context.identity`, never `context.from`. `from` is a reply address.
- Never rerun a job the ledger says is `running` or `unknown`. Unknown means unknown; do not report it as "not run".
- Persist `running` before a command starts and `completed` before the answer is sent.
- Never log or persist command text. Output may be persisted in the ledger only, never logged.
- The client must not pass `idempotencyKey` to dead-drop. The mailbox would drop a deliberate re-ask of the same job; the ledger handles duplicates.
- A command for a session that no longer exists is answered `session_lost` and not run.
- Never hard-code the version. `VERSION` comes from `package.json`.
- The server is POSIX only. Anything shell-specific must work under `dash`, not just `bash`.
- Use only dead-drop's public exports. Anything dead-drop is missing goes in [docs/upstream-requirements.md](docs/upstream-requirements.md), not in a workaround that reaches into its internals.

## Conventions

- Angular commits: `type(scope): subject`, imperative, lowercase, no trailing period.
- Markdown prose is never hard-wrapped. No em dashes; sentence-case headings.
- Tests that wait for processes use `waitFor` from `test/helpers.ts`, not fixed sleeps.
