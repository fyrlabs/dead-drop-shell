# ddshell

A remote shell that works as an alternative to SSH. Instead of a network connection, commands travel over [dead-drop](https://github.com/fyrlabs/dead-drop) through storage both machines already share: a private GitHub repository, a git remote, or a synced folder. The target needs no open port, VPN or tunnel.

```text
# on the VM
ddshell serve --config vm.json

# on your machine
ddshell vm
vm:~$ cd /srv/app
vm:/srv/app$ git status
vm:/srv/app$ cat package.json
```

Two machines are involved. The **target machine** is the one you connect to; it runs `ddshell serve`. Your machine runs the `ddshell` client and is called the controller in config files.

It is slow on purpose. Over GitHub every command is a push, a poll and another push, so a round trip takes seconds: a median of about 12 s in one measured setup, see [Latency](docs/github-setup.md#latency). What you get for that is a shell on a machine with no inbound port, no VPN, no tunnel and no broker.

## What it is not

ddshell is not SSH and not a terminal emulator. Phase one does **not** support:

- a PTY, terminal resize, or full-screen programs (`vim`, `top`, `less`)
- interactive prompts, including `sudo` password prompts (every command's stdin is `/dev/null`)
- port forwarding or WebSockets
- streaming output: you see a command's output when it finishes
- cancelling a running command from the client
- SSH protocol compatibility of any kind

## Install

Node.js 20.11 or newer, on both machines. The server needs a POSIX system (Linux or macOS); Windows is refused at startup.

```bash
npm install -g @fyrlabs/dead-drop-shell
```

This brings in `@fyrlabs/dead-drop` as a dependency. Over GitHub, the server needs only `git` with credentials for the drop repository; the controller also needs an authenticated `gh`.

## Try it locally in one minute

Two terminals, one shared folder, no network. [examples/local](examples/local) has both configs:

```bash
cp -r "$(npm root -g)/@fyrlabs/dead-drop-shell/examples/local" /tmp/ddshell-demo
cd /tmp/ddshell-demo
npx --package @fyrlabs/dead-drop ddrop keygen | head -1 > secret
chmod 600 secret

ddshell serve --config server.json        # terminal 1
ddshell vm --config controller.json       # terminal 2
```

For a real VM over GitHub, follow [docs/github-setup.md](docs/github-setup.md).

## Commands

| Command                                                                               | What it does                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ddshell serve [--config <file>]`                                                     | Runs the server until SIGINT or SIGTERM.                                                                                                                                                                                                                                |
| `ddshell <target> [--session <name>] [--timeout <ms>] [--debug]`                      | Interactive session. Each line runs in one remote shell, so `cd` and `export` carry over. Ctrl-D ends it. With `--session`, joins the live session of that name, or starts it, and leaves it running on Ctrl-D.                                                         |
| `ddshell exec <target> [--session <name>] [--timeout <ms>] [--debug] -- <command...>` | Runs one command in a fresh session and exits with its exit code. Arguments are joined with spaces, as `ssh` does. With `--session`, runs it in the named session instead and leaves that open.                                                                         |
| `ddshell exec <a>,<b>,... [--timeout <ms>] [--debug] -- <command...>`                 | Runs the command on every listed target at once. Each target's output is printed as one block when it finishes, every line prefixed with `<target>: `.                                                                                                                  |
| `ddshell sessions <target>[,<target>...] [--timeout <ms>]`                            | Lists your live sessions on each target: name, id, shell pid, busy or idle for how long, and working directory. Other controllers' sessions are not shown.                                                                                                              |
| `ddshell ping <target>[,<target>...] [--count <n>] [--timeout <ms>]`                  | Asks each target's server for its ddshell and dead-drop versions and uptime, and prints the round trip. Runs nothing and opens no session. `--count` sends several in turn and prints min, median and max.                                                              |
| `ddshell put [-r] <target>[,<target>...] <local-file> <remote-path>`                  | Copies a file to each target, or with `-r` a directory tree. It lands atomically: the server writes a temporary file beside the destination and renames it into place only once its size and sha256 match. A remote directory as destination keeps the local file name. |
| `ddshell get [-r] <target> <remote-file> <local-path>`                                | Copies a file (or with `-r` a directory tree) from the target, with the same sha256 check and atomic rename on this machine.                                                                                                                                            |
| `ddshell cp [-r] [<target>:]<file> [<target>:]<path>`                                 | scp-style form of `put` and `get`: a colon before any slash marks a remote side (`vm:app/.env`, `vm:` alone is the home directory). With a target on both sides, the file goes through this machine.                                                                    |
| `ddshell check [--config <file>]`                                                     | Checks a config without sending anything: it parses, its `${file:}` secrets are mode 600, a server's shell is executable and its ledger directory writable, every transport can be listed, and each target has a recent beacon that lists `shell.v1`.                   |

The config file is `--config`, else `$DDSHELL_CONFIG`, else `~/.deaddrop/ddshell.json`. `<target>` is looked up in `shell.targets`; an unmapped name is used as the server's peer id directly. `--timeout` is how long the client waits for an answer (default 120000). `--debug` shows runtime logs and a per-command line with the job id, server-side duration and round trip.

In an interactive session, Ctrl-D closes the remote session and exits. While a command is pending, the first Ctrl-C warns that phase one cannot cancel the remote command; a second Ctrl-C or Ctrl-D abandons the local wait and exits immediately. The command may continue on the target.

`exec` exit codes: the remote exit code, `124` when the command hit the server's `commandTimeoutMs`, `125` when the outcome is unknown (below), `255` when ddshell itself failed. With several targets, `exec` exits with the highest code among them, so any failure shows up as a non-zero exit.

`put`, `get` and `cp` exit codes: `0` when every copy landed and matched its sha256, `1` when any did not, `255` when ddshell itself failed. Remote relative paths start in the home directory of the account running the server, as with scp. Files are sent in 4 MiB pieces, four at a time, up to 64 MiB per file by default (`transferCapBytes`); a request that times out is retried twice. At a terminal, progress is shown on stderr; `--debug` prints where the file landed, its size and sha256.

`-r` copies directories as `scp -r` does: into an existing directory the copy lands under its own name, otherwise it becomes the destination. Symbolic links are followed, except one that loops back to its own parent. Every file is checked and lands atomically on its own, four at a time, and a copy carries on past a file that fails. Special files (sockets, FIFOs, devices), broken links and loops are skipped. Each failure and skip is printed and the exit code is `1`. Directories are created with their source mode plus owner access. Files of 64 KiB or less travel inside a single request each way instead of three, which is what keeps a tree of small files quick over a slow transport. Both ends need this version for `-r`; an older server is reported as not supporting it.

`ping` exit codes: `0` when every ping was answered, `1` when any went unanswered or was refused, `255` when ddshell itself failed. `check` exits `1` if any check failed; warnings alone exit `0`.

## What each command returns

stdout and stderr as bytes, the exit code, the duration on the target machine, the resulting working directory, whether output was truncated at the cap (8 MiB by default, stdout and stderr combined), and a stable job id.

## Delivery is at least once, so read this

dead-drop may deliver a request twice. Every command carries a job id, and the server keeps a durable ledger of job states:

- A duplicate of a completed job gets the stored result. It does not run again.
- The server records `running` before it starts a command. If the server stops mid-command, that job is reported as **unknown** after restart. It may have run fully, partly, or not at all. ddshell never reruns it and never claims it did not run. The client prints this loudly.
- If the client gives up waiting (`--timeout`), the command may still be running. The client says so and prints the job id.

A session's shell dies with the server, on `exit`, after an idle timeout (30 minutes by default), or when a command runs past `commandTimeoutMs` (10 minutes by default). The next command in that session is refused as `session_lost` and is not run: running it in a fresh shell in the home directory would put it somewhere you did not `cd` to. The interactive client then starts a new session and asks you to re-enter the command.

A named session (`--session build`) is the same shell with a name, like a `tmux` session: `ddshell vm --session build` or `ddshell exec vm --session build -- make` joins it wherever it was left, from any process of the same controller, and leaving does not close it. It still ends on `exit`, the idle timeout, the command timeout or a server restart, and the next command then starts it afresh in the home directory. Two clients in one session take turns: commands run one at a time. The name decides the session id, so a server older than named sessions joins them too; only `ddshell sessions` needs a current server.

## Security

Read [SECURITY.md](SECURITY.md) before deploying. In short: the OS account running the server on the target machine is the real permission boundary, so run it as a dedicated unprivileged user. Anyone holding the workspace secret and the current key era is trusted broadly by dead-drop, so give the shell its own workspace, repository and secret. The server checks callers against `shell.allowControllers`, which catches misconfigured peers but not a secret holder claiming a listed name. It logs job ids, exit codes and sizes, never commands or output.

## Documentation

- [docs/github-setup.md](docs/github-setup.md): a VM over a private GitHub repository, with systemd
- [docs/configuration.md](docs/configuration.md): every `shell` field
- [docs/architecture.md](docs/architecture.md): how sessions, the ledger and the protocol fit together
- [docs/upstream-requirements.md](docs/upstream-requirements.md): what building this taught us about a future dead-drop extension host

## License

Apache-2.0
