# One server per person

Several people can share one ddshell server: each controller has its own key, sessions and output are scoped to that key, and nobody can read anyone else's commands. What they still share is the Unix account every command runs as, the workspace secret, and the server's eight handler slots. When that is not acceptable, run one server per person on the same machine.

Each person gets their own:

- Unix account, so their commands run with their permissions and nobody else's. This is the boundary that matters most.
- repository and workspace secret, so removing a person means deleting their repository, secret and account, with no secret to rotate for everyone else.
- server process, so one person's eight long commands cannot hold up another person's `ping` or file transfer.

[examples/ddshell-server@.service](../examples/ddshell-server@.service) is a systemd template unit for this. The instance name is the account name: `ddshell-server@alice` runs as `alice` and reads `/home/alice/.deaddrop/ddshell.json`, or wherever that account's home is.

## Add a person

The steps are those of [github-setup.md](github-setup.md), once per person, with that person's names. For a person `alice`:

1. Create a private repository for her alone, such as `your-org/vm-shell-alice`.
2. Pick the account her commands run as: her own login account, or a dedicated one (`sudo useradd --create-home --shell /bin/bash ddshell-alice`, then use `ddshell-alice` as the instance name below). Keep it out of `sudo`, `wheel` and `docker`.
3. As that account, store a fine-grained token scoped to her repository only and check `git ls-remote` works without a prompt.
4. Generate a secret for her workspace and give it only to her.
5. Put a server config in that account's `~/.deaddrop/ddshell.json`, with her repository as `remote` and her key line in `~/.deaddrop/ddshell_authorized_keys`. Every server has its own workspace, so all of them can use the peer id `vm`.
6. Enable her server:

```bash
sudo cp examples/ddshell-server@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ddshell-server@alice
journalctl -u ddshell-server@alice -f
sudo -iu alice ddshell check
```

Her controller config is the ordinary one from [examples/controller.json](../examples/controller.json) with her repository. Someone who uses servers in more than one workspace keeps one config file per workspace and picks it with `--config` or `$DDSHELL_CONFIG`.

## Remove a person

```bash
sudo systemctl disable --now ddshell-server@alice
```

Then delete her repository and revoke her token. Nobody else's secret, repository or key changes. Delete the account too if it was a dedicated one. Stopping the unit kills everything in its control group, including her session shells and anything she left running in the background.

## Caveats

- The unit runs `ddshell` through `/usr/bin/env`, like the single-server unit, so it must be on systemd's `PATH`. The same fix applies: write absolute paths into `ExecStart`, see [github-setup.md](github-setup.md#6-run-the-server-under-systemd).
- The unit has not been run on a Linux machine yet: neither the template nor a reboot with several instances enabled has been tested.
- Each server polls its own repository, so ten people means ten processes polling GitHub. At the example's idle backoff of 30 s that is about 20 fetches a minute in total when nobody is working.
