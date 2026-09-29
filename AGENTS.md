# Notes for coding agents

`@fyrlabs/dead-drop-shell` (binary `ddshell`): a line-oriented remote shell over `@fyrlabs/dead-drop`. Read [docs/architecture.md](docs/architecture.md) first.

## Commands

```bash
npm install
npm run verify      # format:check, lint, typecheck, then test (which builds first); must pass before every commit
npm test            # vitest; the session suite runs under every shell in /bin/sh, /bin/bash, /bin/dash that exists
npm run format      # prettier --write
```

## Layout

| Path              | Contents                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `src/session.ts`  | `ShellSession`: one long-lived child shell, nonce-delimited command trailer, output cap, timeouts    |
| `src/ledger.ts`   | `JobLedger`: one JSON file per job id, atomic writes, `running` becomes `unknown` on open            |
| `src/protocol.ts` | `shell.v1` request and response types, `parseRequest`                                                |
| `src/keys.ts`     | key pairs (Ed25519 + X25519), `ddshell-key` lines, fingerprints, `KnownHosts`                        |
| `src/envelope.ts` | `shell.v2`: hello, sealed and signed calls and answers, `ReplayGuard`                                |
| `src/transfer.ts` | `ServerTransfers` (put/get state, temp file, commit, list, mkdir), `hashFile`, `destination`, `walk` |
| `src/version.ts`  | `VERSION` and `DEAD_DROP_VERSION`, read from the package manifests                                   |
| `src/limits.ts`   | `RateLimiter`: token bucket per controller for `shell.requestsPerMinute`                             |
| `src/audit.ts`    | `AuditLog`: JSON lines per session, command, transfer and refusal; never command text or paths       |
| `src/config.ts`   | `shell` config section, defaults, `loadConfig`                                                       |
| `src/server.ts`   | `ShellServer`: embedded runtime, authorisation, sessions, ledger, idle sweep                         |
| `src/client.ts`   | `ShellClient`, `RemoteSession`                                                                       |
| `src/check.ts`    | `ddshell check`: config, secret file modes, server shell and ledger, transports, target beacons      |
| `src/cli.ts`      | argument parsing, interactive loop, `exec`, exit codes                                               |
| `test/`           | unit tests plus integration tests over dead-drop's filesystem transport                              |

## Invariants: do not break these

- Over `shell.v2`, authorise on the key that signed the request; the caller's identity is `key:<fingerprint>`. Over `shell.v1`, authorise on `context.identity`, never `context.from`. `from` is a reply address.
- `shell.v1` stays refused unless `allowV1`. Never let a dead-drop peer id stand in for a key.
- Never answer a v2 request unsealed once it has been opened: errors after that point go back sealed and signed too. Never change the wire format or a signature transcript without a new protocol version.
- Never overwrite a key file without `--force`, and never read a private key file other users can read.
- Never rerun a job the ledger says is `running` or `unknown`. Unknown means unknown; do not report it as "not run".
- Persist `running` before a command starts and `completed` before the answer is sent.
- Never log or persist command text. Output may be persisted in the ledger only, never logged. The audit log follows the same rule and holds no paths either.
- Check per-controller limits before anything runs or is written to the ledger: a refused request must have had no effect.
- The client must not pass `idempotencyKey` to dead-drop. The mailbox would drop a deliberate re-ask of the same job; the ledger handles duplicates.
- A command for a session that no longer exists is answered `session_lost` and not run.
- Never change how `namedSessionId` derives an id from a name: clients of different versions must find the same session.
- A transferred file reaches its destination only by rename after its size and sha256 match. Every transfer step stays idempotent; that is what makes client retries safe.
- Never hard-code the version. `VERSION` comes from `package.json`.
- The server is POSIX only. Anything shell-specific must work under `dash`, not just `bash`.
- Use only dead-drop's public exports. Anything dead-drop is missing goes in [docs/upstream-requirements.md](docs/upstream-requirements.md), not in a workaround that reaches into its internals.

## Conventions

- Angular commits: `type(scope): subject`, imperative, lowercase, no trailing period.
- Markdown prose is never hard-wrapped. No em dashes; sentence-case headings.
- Tests that wait for processes use `waitFor` from `test/helpers.ts`, not fixed sleeps.
