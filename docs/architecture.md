# Architecture

```text
controller process                           agent process (restricted OS account)
┌────────────────────────┐                  ┌──────────────────────────────────────┐
│ ddshell <target>       │                  │ ddshell agent                        │
│  RemoteSession         │   shell.v1       │  ShellAgent ── allowControllers      │
│  embedded runtime ─────┼── dead-drop ─────┼─ embedded runtime                    │
│  (own mailbox address) │   workspace      │  JobLedger (one file per job)        │
└────────────────────────┘                  │  ShellSession ── /bin/sh, per session│
                                            └──────────────────────────────────────┘
```

Both ends embed a `DeadDropRuntime` built from the same kind of config file. Nothing needs a separate `ddrop start`. The client runs its runtime under a per-process mailbox address (dead-drop's `sessionId`), so it can share a config with a long-running `ddrop start` on the same machine, while the agent still sees the configured peer id as the caller's identity.

## Request path

1. The client sends `{ v: 1, op: "exec", sessionId, jobId, command, open?, close? }` to `shell.v1` with `workspace.call`. `open` is set on a session's first command; `close` makes a one-shot `exec` a single round trip.
2. The agent checks `context.identity` against `shell.allowControllers`. It never looks at `context.from`, which is only the reply address.
3. A job id already in flight waits for the first copy. A job id in the ledger is answered from it: `completed` returns the stored result with `replayed: true`, `unknown` returns `state: "unknown"`. A job id owned by another controller is refused.
4. Otherwise the agent finds the session keyed by (identity, sessionId), or opens one if `open` is set, or answers `session_lost`.
5. `running` is written to the ledger, the command runs, and `completed` is written with the result before the answer goes back.

## Sessions

A session is one long-lived shell started in the agent account's home directory, in its own process group. Each command is written to its stdin as:

```sh
__ddshell_cmd='<command, single-quoted>'
eval "$__ddshell_cmd" </dev/null
__ddshell_status=$?
printf '\n%s:%s:%s:%s\n' <nonce> "$__ddshell_status" "$PWD" <nonce>
printf '\n%s:end:%s\n' <nonce> <nonce> >&2
```

- `eval` in the shell itself is what makes `cd`, `export`, functions and aliases persist.
- Passing the command as a quoted variable means an unterminated quote or heredoc in it cannot swallow the trailer.
- The nonce is 16 random bytes per command, so output that imitates a trailer cannot end a command early.
- `</dev/null` stops a command from reading the control stream.
- A syntax error inside `eval` makes a POSIX non-interactive shell exit, so each command is first checked with `<shell> -n -c`.

Output is split from the trailer by a scanner that holds back just enough bytes to catch a trailer straddling two chunks, and keeps at most `outputCapBytes` across stdout and stderr.

A command past `commandTimeoutMs`, an agent shutdown, or an idle timeout kills the whole process group, background jobs included. A session never outlives the agent process that owns it.

## Ledger

`<ledgerDir>/<jobId>.json`, mode 0600 in a 0700 directory, written to a temporary file, flushed, then renamed. Job ids must be UUIDs because they become file names. Records hold the result for replay but never the command text. At startup every `running` record becomes `unknown`. Finished records are pruned after `ledgerRetentionMs`.

The ledger stores command output for the retention window. That is the price of replaying a duplicate instead of rerunning it. Lower `ledgerRetentionMs` if that output is sensitive, and accept that a duplicate arriving after pruning will run again.

## What is deliberately missing

No streaming, cancellation, PTY, or reconnecting to a session after an agent restart. These are phase four in the parent project's [application extension proposal](https://github.com/fyrlabs/dead-drop/blob/main/docs/proposals/0001-application-extensions.md). There is also no generic plugin host here; [upstream-requirements.md](upstream-requirements.md) records what one would need.
