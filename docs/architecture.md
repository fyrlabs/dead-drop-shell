# Architecture

```text
controller process                           server process (restricted OS account)
┌────────────────────────┐                  ┌──────────────────────────────────────┐
│ ddshell <target>       │                  │ ddshell serve                        │
│  RemoteSession         │   shell.v1       │  ShellServer ── allowControllers     │
│  embedded runtime ─────┼── dead-drop ─────┼─ embedded runtime                    │
│  (own mailbox address) │   workspace      │  JobLedger (one file per job)        │
└────────────────────────┘                  │  ShellSession ── /bin/sh, per session│
                                            └──────────────────────────────────────┘
```

Both ends embed a `DeadDropRuntime` built from the same kind of config file. Nothing needs a separate `ddrop start`. The client runs its runtime under a per-process mailbox address (dead-drop's `sessionId`), so it can share a config with a long-running `ddrop start` on the same machine, while the server still sees the configured peer id as the caller's identity.

## Request path

1. The client sends `{ v: 1, op: "exec", sessionId, jobId, command, open?, close? }` to `shell.v1` with `workspace.call`. `open` is set on a session's first command; `close` makes a one-shot `exec` a single round trip.
2. The server checks `context.identity` against `shell.allowControllers`. It never looks at `context.from`, which is only the reply address.
3. A job id already in flight waits for the first copy. A job id in the ledger is answered from it: `completed` returns the stored result with `replayed: true`, `unknown` returns `state: "unknown"`. A job id owned by another controller is refused.
4. Otherwise the server finds the session keyed by (identity, sessionId), or opens one if `open` is set, or answers `session_lost`.
5. `running` is written to the ledger, the command runs, and `completed` is written with the result before the answer goes back.

A named session's id is derived from its name: sha256 of `ddshell-session\0<name>`, shaped as a version 8 UUID. Every client of one controller derives the same id, so `open` on a live session joins it and on a missing one starts it, with no extra round trip. `open` also carries `name`, which the server keeps beside the session for listing.

`{ v: 1, op: "sessions" }` passes the same identity check and answers `{ home, sessions }`: for each of the caller's own live sessions, its id, name, shell pid, working directory, idle time and whether a command is queued or running. Other controllers' sessions are left out.

`{ v: 1, op: "ping" }` passes the same identity check, then answers `{ version, deadDropVersion, uptimeMs }` without touching sessions or the ledger. A 0.1.0 server refuses it with `BAD_REQUEST`, which the client reports as an older server that is up.

## File transfer

`put-open`, `put-chunk`, `put-commit`, `get-open`, `get-chunk` and `transfer-close` pass the same identity check and then bypass sessions and the ledger. Each carries a client-chosen `transferId`, scoped to the caller's identity, and each is idempotent, so a duplicate delivery or a client retry changes nothing:

- `put-open` declares path, file name, size, sha256 and mode. The server resolves the path against its home, appends the name if the path is a directory, follows a symlink at the destination, checks `transferCapBytes`, and opens `.<name>.ddshell-<transferId>.tmp` (mode 0600) beside the destination. A repeated open returns the first answer, including `chunkBytes`.
- `put-chunk` writes base64 bytes at an offset. Rewriting a piece writes the same bytes again.
- `put-commit` hashes the whole temporary file. On a match it sets the mode, flushes, and renames it over the destination; on a mismatch it deletes it and the destination is untouched. The outcome is kept, so a repeated commit gets the same answer.
- `get-open` opens the file, hashes it, and keeps the handle open, so a rename over the path mid-transfer does not change what is sent. The client writes pieces into its own temporary file, checks size and sha256, and renames. An edit in place during the transfer shows up as a mismatch and nothing is written.

Two more operations serve `-r`, neither with a `transferId` since neither holds state:

- `list` stats a path and, for a directory, returns every entry below it (relative path, kind, mode, size) in one answer, parents first, plus what a copy must skip: special files, broken links, symlinks back to one of their own parents, unreadable directories. At most 100,000 entries.
- `mkdir` creates a directory tree in one request: the root lands at the path as a file would (inside an existing directory, under its name), then each relative path below it. Existing directories are kept. Relative paths with `..`, `.` or empty parts are refused.

Files in the tree then go through the operations above, four at a time. A file no bigger than 64 KiB and the server's `chunkBytes` travels inline: `put-open` carries its `data` and answers `committed`, and `get-open` with `inline` answers with the `data` and releases the transfer at once. A server that ignores these fields gives an ordinary open and the client falls back to pieces.

The client keeps four pieces in flight and retries retryable errors (timeouts, transport errors) up to three tries per request. Transfers live in memory: one idle past `idleTimeoutMs` is dropped with its temporary file, and after a server restart the next request for it is answered `NOT_FOUND`. A temporary file from an upload interrupted by the restart stays beside its destination.

## Sessions

A session is one long-lived shell started in the home directory of the account running the server, in its own process group. Each command is written to its stdin as:

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

A command past `commandTimeoutMs`, a server shutdown, or an idle timeout kills the whole process group, background jobs included. A session never outlives the server process that owns it.

## Ledger

`<ledgerDir>/<jobId>.json`, mode 0600 in a 0700 directory, written to a temporary file, flushed, then renamed. Job ids must be UUIDs because they become file names. Records hold the result for replay but never the command text. At startup every `running` record becomes `unknown`. Finished records are pruned after `ledgerRetentionMs`.

The ledger stores command output for the retention window. That is the price of replaying a duplicate instead of rerunning it. Lower `ledgerRetentionMs` if that output is sensitive, and accept that a duplicate arriving after pruning will run again.

## What is deliberately missing

No streaming, cancellation, PTY, or reconnecting to a session after a server restart. These are phase four in the parent project's [application extension proposal](https://github.com/fyrlabs/dead-drop/blob/main/docs/proposals/0001-application-extensions.md). There is also no generic plugin host here; [upstream-requirements.md](upstream-requirements.md) records what one would need.
