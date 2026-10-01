# Changelog

## Unreleased

- **Breaking:** controllers now sign in with their own key instead of a peer id. Run `ddshell keygen` on each controller and add the line it prints to the server's `shell.authorizedKeys` or `shell.authorizedKeysFile`. Old controllers are refused unless the server sets `shell.allowV1`.
- Commands and output are sealed end to end, so other members of the workspace can no longer read them.
- The controller remembers each server's host key on first contact and refuses one that changes, like ssh. `ddshell hostkey` prints a server's key so you can trust it up front with `shell.strictHostKeys`.
- Output and file transfers no longer go through base64, so they are a third smaller on the wire.
- `--session <name>` keeps a shell you can come back to, like a tmux session: `ddshell vm --session build` joins it where you left it, `ddshell exec vm --session build -- make` runs in it, and leaving keeps it open. `ddshell sessions vm` lists your live sessions.
- `ddshell put`, `ddshell get` and scp-style `ddshell cp vm:path local` copy files. Each copy is checked with sha256 and lands whole or not at all. Files up to 64 MiB by default, sent in pieces.
- `-r` on `put`, `get` and `cp` copies whole directories, as `scp -r` does. Small files take one round trip each.
- Output streams while a command runs, so long commands no longer hit `--timeout` and no longer tie up the server.
- Ctrl-C cancels the remote command, in interactive sessions and in `ddshell exec`, and keeps your session and its cwd. Press it twice to leave without waiting.
- In bash, `declare` inside a command now needs `-g` to keep the variable for later commands.
- `ddshell <target> --tty` opens a real terminal, so vim, top and tab completion work. Keys travel in batches and the screen comes back by long poll, so each keystroke echoes after a round trip. Type `~.` at the start of a line to disconnect. The server needs `node-pty`, which compiles on Linux (python3, make, g++); without it line mode is unaffected.
- `examples/ddshell-server@.service` runs one server per person, each as their own account with their own repository and secret. See `docs/per-person.md`.
- `ddshell unit` prints a systemd unit that runs the server by absolute paths, so it works with nvm or a user npm prefix. `--template` prints the per-person one.
- Each controller is held to 16 live sessions and 600 requests a minute by default (`shell.maxSessions`, `shell.requestsPerMinute`). A refused command is not run.
- The server keeps an audit log, one JSON line per session, command, file transfer and refusal, with who, exit code, duration and size, never the command, its output or paths. Set `shell.auditLog` to move it or `false` to turn it off.
- A slow command in one session no longer holds up the other sessions over git or GitHub. This needs dead-drop 0.16.1, which is now the minimum.
- `ddshell check` tests a config before you rely on it: it parses, the secret file is private, the server's shell, ledger and audit log work, every transport answers, and each target is announcing itself.
- `ddshell jobs <target>` lists your jobs on a server, newest first, and `ddshell status <target> <job>` shows one by its id or the start of it. They show state, exit code and timing, never the command or its output.
- `ddshell ping <target>` checks a server is up and shows its versions, uptime and round trip. `--count` repeats it and prints min, median and max.
- `ddshell exec a,b,c -- <command>` runs a command on several machines at once, prefixes each output line with its machine, and exits with the worst exit code.
- The server example now uses the plain git transport, so the server machine needs only git and a token for the drop repository, not `gh`.
- Keep runtime logs out of the client's output unless `--debug` is passed.
- Make Ctrl-D leave an interactive session reliably, including while a remote command is pending.
- Make a second Ctrl-C abandon a pending local wait immediately while leaving the remote command's outcome unchanged.
- Make the GitHub examples safer for always-on use by restoring the 5-second fetch freshness default and backing idle polling off to 30 seconds.

## 0.1.0

First version: a remote shell over dead-drop, an alternative to SSH for machines with no open port.

- `ddshell serve` serves shell sessions to the controllers you allow.
- `ddshell <target>` opens an interactive session; `cd` and `export` carry over between commands.
- `ddshell exec <target> -- <command>` runs one command and exits with its exit code.
- Each result has stdout, stderr, exit code, duration, working directory and a job id.
- A command delivered twice runs once. A command interrupted by a server restart is reported as unknown and never rerun.
- Output is capped at 8 MiB per command; sessions close after 30 idle minutes; commands time out after 10 minutes.
- The GitHub example configs set `freshnessMs` to 1000, for round trips of about 14 s instead of about 21 s.
- `examples/local/` runs a server and a controller on one machine through a shared folder.
