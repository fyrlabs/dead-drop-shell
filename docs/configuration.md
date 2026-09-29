# Configuration

One JSON file per machine. Everything except `shell` is an ordinary dead-drop runtime config, parsed by dead-drop's own `parseRuntimeConfig`: workspace, peer id, secret references, transports, polling and request timeout all work exactly as in the [dead-drop configuration reference](https://github.com/fyrlabs/dead-drop/blob/main/docs/configuration.md). dead-drop ignores top-level keys it does not know, so the `shell` section lives beside `workspaces` in the same file.

Found at `--config <file>`, else `$DDSHELL_CONFIG`, else `~/.deaddrop/ddshell.json`.

Never put a secret in the file. Reference it: `"secrets": ["${file:~/.deaddrop/ddshell.secret}"]` or `"${env:DEADDROP_SECRET}"`.

## `shell`

| Field                | Used by    | Default                                 | Notes                                                                                                                                                                                                                   |
| -------------------- | ---------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace`          | both       | first workspace                         | Which workspace carries shell traffic. Must name a configured workspace.                                                                                                                                                |
| `authorizedKeys`     | server     | `[]`                                    | Public key lines of the controllers allowed to run commands, as `ddshell keygen` prints them: `ddshell-key <base64> [comment]`. With `authorizedKeysFile` also empty, the server refuses everyone and warns at startup. |
| `authorizedKeysFile` | server     | none                                    | A file of more such lines, one per line; blank lines and `#` comments are skipped. Read at startup, so restart the server after editing it. A missing file adds no keys.                                                |
| `hostKey`            | server     | `ddshell_host_key` beside the config    | The server's key pair, made on first start, mode 600. `ddshell hostkey` prints its public line for controllers' `knownHosts`. Replacing it makes every controller that pinned the old one refuse the server.            |
| `replayWindowMs`     | server     | `600000` (10 min)                       | How far a request's timestamp may be from the server's clock. Nonces are remembered for this long, so a replayed request is refused.                                                                                    |
| `allowV1`            | server     | `false`                                 | Also serve protocol v1, used by controllers without a key (ddshell 0.1.x). v1 trusts dead-drop's peer ids, which anyone holding the workspace secret can claim.                                                         |
| `allowControllers`   | server     | `[]`                                    | Peer ids allowed in over v1. Ignored unless `allowV1` is true; `ddshell check` warns when it is set without it.                                                                                                         |
| `key`                | controller | `ddshell_key` beside the config         | The controller's key pair from `ddshell keygen`. Refused if other users can read it. Without it the controller speaks v1.                                                                                               |
| `knownHosts`         | controller | `ddshell_known_hosts` beside the config | Host keys pinned per server peer id, one `<peerId> ddshell-key <base64>` line each. The first request to a server pins its key and says so on stderr.                                                                   |
| `strictHostKeys`     | controller | `false`                                 | Refuse a server that has no line in `knownHosts` instead of pinning it on first use.                                                                                                                                    |
| `shell`              | server     | `/bin/sh`                               | Absolute path to a POSIX shell. `/bin/bash` is the usual choice. It runs non-interactive and non-login, so it does not read `.bashrc` or `.profile`.                                                                    |
| `outputCapBytes`     | server     | `8388608` (8 MiB)                       | stdout plus stderr kept per command. The rest is dropped and the result says `truncated`.                                                                                                                               |
| `idleTimeoutMs`      | server     | `1800000` (30 min)                      | A session with no command for this long is closed. A running command never counts as idle.                                                                                                                              |
| `commandTimeoutMs`   | server     | `600000` (10 min)                       | A command running longer is killed together with its session.                                                                                                                                                           |
| `ledgerDir`          | server     | `<dataDir>/ddshell-ledger`              | Job states. Relative paths resolve against the config file; `~` is expanded.                                                                                                                                            |
| `ledgerRetentionMs`  | server     | `86400000` (24 h)                       | How long finished job records, including their output, are kept for replay.                                                                                                                                             |
| `transferCapBytes`   | server     | `67108864` (64 MiB)                     | Largest file `put`, `get` or `cp` moves, in either direction. Checked before anything is written.                                                                                                                       |
| `transferChunkBytes` | server     | `4194304` (4 MiB)                       | Largest piece of a file per request, at most 16 MiB. The server announces it when a transfer opens, so clients follow it. Larger pieces mean fewer round trips over GitHub and bigger commits.                          |
| `targets`            | controller | `{}`                                    | Short names to server peer ids, e.g. `{ "vm": "build-vm-01" }`. An unmapped target is used as a peer id.                                                                                                                |

`${env:...}` and `${file:...}` references are expanded only in the dead-drop part of the file, not inside `shell`.

## Values the server changes

When the shell's workspace does not set `concurrency`, the server uses `8` instead of dead-drop's default of `1`. At `1`, one `sleep 60` would hold up every other session's commands. The limit is shared by every request to the server, not only commands: while eight commands are running, a ninth command, a `ping` and every chunk of a file transfer wait for one of them to finish. Raise `concurrency` on the server's workspace if people keep long commands running.

## Choosing the 8 MiB cap

It is a starting point, not a measured optimum. dead-drop's frame limit is 64 MiB and GitHub storage is not a log archive, so the cap keeps one careless `cat` from turning into a large commit. Raise it only if you routinely need more; pipe through `head` or `tail` otherwise.

## Choosing the transfer cap

64 MiB is sixteen 4 MiB pieces, and each piece is one request: over GitHub, with four in flight, expect roughly four round trips of transport time plus upload time per 16 MiB (not measured). Protocol v1 base64-encodes each piece, making it about a third larger; v2 sends the bytes as they are. As with the output cap, the default keeps one careless copy from becoming a large commit.

## Timeouts, end to end

The client waits `--timeout` (default 120 s) for an answer. That wait covers the transport both ways plus the command itself, so over GitHub, budget several seconds of transport on top of the command's own time. `requestTimeoutMs` in the workspace does not apply to ddshell commands, because the client always passes its own timeout. For `put`, `get` and `cp`, `--timeout` applies to each piece, not to the whole file.
