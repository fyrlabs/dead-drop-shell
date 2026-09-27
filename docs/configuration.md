# Configuration

One JSON file per machine. Everything except `shell` is an ordinary dead-drop runtime config, parsed by dead-drop's own `parseRuntimeConfig`: workspace, peer id, secret references, transports, polling and request timeout all work exactly as in the [dead-drop configuration reference](https://github.com/fyrlabs/dead-drop/blob/main/docs/configuration.md). dead-drop ignores top-level keys it does not know, so the `shell` section lives beside `workspaces` in the same file.

Found at `--config <file>`, else `$DDSHELL_CONFIG`, else `~/.deaddrop/ddshell.json`.

Never put a secret in the file. Reference it: `"secrets": ["${file:~/.deaddrop/ddshell.secret}"]` or `"${env:DEADDROP_SECRET}"`.

## `shell`

| Field               | Used by    | Default                    | Notes                                                                                                                                                |
| ------------------- | ---------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace`         | both       | first workspace            | Which workspace carries shell traffic. Must name a configured workspace.                                                                             |
| `allowControllers`  | agent      | `[]`                       | Peer ids allowed to run commands, matched against dead-drop's authenticated caller identity. Empty refuses everyone, and the agent warns at startup. |
| `shell`             | agent      | `/bin/sh`                  | Absolute path to a POSIX shell. `/bin/bash` is the usual choice. It runs non-interactive and non-login, so it does not read `.bashrc` or `.profile`. |
| `outputCapBytes`    | agent      | `8388608` (8 MiB)          | stdout plus stderr kept per command. The rest is dropped and the result says `truncated`.                                                            |
| `idleTimeoutMs`     | agent      | `1800000` (30 min)         | A session with no command for this long is closed. A running command never counts as idle.                                                           |
| `commandTimeoutMs`  | agent      | `600000` (10 min)          | A command running longer is killed together with its session.                                                                                        |
| `ledgerDir`         | agent      | `<dataDir>/ddshell-ledger` | Job states. Relative paths resolve against the config file; `~` is expanded.                                                                         |
| `ledgerRetentionMs` | agent      | `86400000` (24 h)          | How long finished job records, including their output, are kept for replay.                                                                          |
| `targets`           | controller | `{}`                       | Short names to agent peer ids, e.g. `{ "vm": "build-vm-01" }`. An unmapped target is used as a peer id.                                              |

`${env:...}` and `${file:...}` references are expanded only in the dead-drop part of the file, not inside `shell`.

## Values the agent changes

When the shell's workspace does not set `concurrency`, the agent uses `8` instead of dead-drop's default of `1`. At `1`, one `sleep 60` would hold up every other session's commands.

## Choosing the 8 MiB cap

It is a starting point, not a measured optimum. dead-drop's frame limit is 64 MiB and GitHub storage is not a log archive, so the cap keeps one careless `cat` from turning into a large commit. Raise it only if you routinely need more; pipe through `head` or `tail` otherwise.

## Timeouts, end to end

The client waits `--timeout` (default 120 s) for an answer. That wait covers the transport both ways plus the command itself, so over GitHub, budget several seconds of transport on top of the command's own time. `requestTimeoutMs` in the workspace does not apply to ddshell commands, because the client always passes its own timeout.
