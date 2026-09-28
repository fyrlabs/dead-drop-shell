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
- SCP, file transfer, port forwarding, or WebSockets
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

| Command                                                            | What it does                                                                                                       |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `ddshell serve [--config <file>]`                                  | Runs the server until SIGINT or SIGTERM.                                                                           |
| `ddshell <target> [--timeout <ms>] [--debug]`                      | Interactive session. Each line runs in one remote shell, so `cd` and `export` carry over. Ctrl-D ends it.          |
| `ddshell exec <target> [--timeout <ms>] [--debug] -- <command...>` | Runs one command in a fresh session and exits with its exit code. Arguments are joined with spaces, as `ssh` does. |

The config file is `--config`, else `$DDSHELL_CONFIG`, else `~/.deaddrop/ddshell.json`. `<target>` is looked up in `shell.targets`; an unmapped name is used as the server's peer id directly. `--timeout` is how long the client waits for an answer (default 120000). `--debug` shows runtime logs and a per-command line with the job id, server-side duration and round trip.

In an interactive session, Ctrl-D closes the remote session and exits. While a command is pending, the first Ctrl-C warns that phase one cannot cancel the remote command; a second Ctrl-C or Ctrl-D abandons the local wait and exits immediately. The command may continue on the target.

`exec` exit codes: the remote exit code, `124` when the command hit the server's `commandTimeoutMs`, `125` when the outcome is unknown (below), `255` when ddshell itself failed.

## What each command returns

stdout and stderr as bytes, the exit code, the duration on the target machine, the resulting working directory, whether output was truncated at the cap (8 MiB by default, stdout and stderr combined), and a stable job id.

## Delivery is at least once, so read this

dead-drop may deliver a request twice. Every command carries a job id, and the server keeps a durable ledger of job states:

- A duplicate of a completed job gets the stored result. It does not run again.
- The server records `running` before it starts a command. If the server stops mid-command, that job is reported as **unknown** after restart. It may have run fully, partly, or not at all. ddshell never reruns it and never claims it did not run. The client prints this loudly.
- If the client gives up waiting (`--timeout`), the command may still be running. The client says so and prints the job id.

A session's shell dies with the server, on `exit`, after an idle timeout (30 minutes by default), or when a command runs past `commandTimeoutMs` (10 minutes by default). The next command in that session is refused as `session_lost` and is not run: running it in a fresh shell in the home directory would put it somewhere you did not `cd` to. The interactive client then starts a new session and asks you to re-enter the command.

## Security

Read [SECURITY.md](SECURITY.md) before deploying. In short: the OS account running the server on the target machine is the real permission boundary, so run it as a dedicated unprivileged user. Anyone holding the workspace secret and the current key era is trusted broadly by dead-drop, so give the shell its own workspace, repository and secret. The server checks callers against `shell.allowControllers`, which catches misconfigured peers but not a secret holder claiming a listed name. It logs job ids, exit codes and sizes, never commands or output.

## Documentation

- [docs/github-setup.md](docs/github-setup.md): a VM over a private GitHub repository, with systemd
- [docs/configuration.md](docs/configuration.md): every `shell` field
- [docs/architecture.md](docs/architecture.md): how sessions, the ledger and the protocol fit together
- [docs/upstream-requirements.md](docs/upstream-requirements.md): what building this taught us about a future dead-drop extension host

## License

Apache-2.0
