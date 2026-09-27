# Setting up a VM over GitHub

This connects your machine (peer `laptop`) to a VM (peer `vm`) through a private GitHub repository. Neither machine needs an inbound port. Both need outbound HTTPS to github.com, Node.js 20.11+, `git` and `gh`.

Expect a round trip of several seconds per command. That is normal operation, not a fault.

## Latency

Measured with both peers on one Mac, a private GitHub repository and polling of 1 to 5 s: six `exec` round trips took 6.7, 7.1, 10.8, 13.7, 15.5 and 19.8 s, a median of about 12 s. The command itself took 3 to 9 ms of that; the rest is transport.

Part of that is dead-drop's git freshness window. The git transport reuses a fetch for up to `freshnessMs` (default 5000) before fetching again, and a round trip waits on that twice: once for the request, once for the answer. Over a local bare repository, a round trip took 6.1 to 11.2 s at the default and 1.0 to 2.2 s with `"freshnessMs": 100`.

Over GitHub the window matters less, because pushes, fetches and polling backoff add time the window does not control. In one session with polling of 1 to 5 s, six round trips took 11.8 to 24.8 s (median about 21 s) at the default and 12.4 to 16.1 s (median about 14 s) with `"freshnessMs": 1000`. A bare `git fetch` from GitHub took 0.6 to 0.9 s, so values much below 1000 mostly add fetches. The examples set 1000.

A lower window costs git fetches, not REST API calls: the github transport uses the API only at startup and for an occasional rate-limit check, and the REST quota did not move during these runs. GitHub returned no 403 or 429 in about a dozen round trips at 1000; an always-on server over days at that value is untested. While idle, the server polls every 15 s, longer than the window, so idle traffic is the same at any window below that.

## 1. Create a dedicated private repository

```bash
gh repo create your-org/vm-shell-drop --private
```

Use this repository for ddshell and nothing else. Every commit in it is ciphertext written by dead-drop, so it is useless as a code repository and should not share a workspace with other dead-drop services.

## 2. Create a restricted account on the VM

```bash
sudo useradd --system --create-home --shell /bin/bash ddshell
```

Every command you run through ddshell runs as this account. Give it only the files and groups it needs. Do not add it to `sudo`, `wheel` or `docker`; `sudo` would not work anyway, since commands have no terminal for a password prompt.

## 3. Authenticate git on both machines

On the VM, as the `ddshell` account, prefer a fine-grained personal access token scoped to this one repository with **Contents: read and write**, so a leaked VM token cannot reach anything else:

```bash
sudo -iu ddshell
gh auth login --with-token < token.txt && rm token.txt
gh auth setup-git
```

On your machine, `gh auth login` followed by `gh auth setup-git` is enough if your account can push to the repository.

`gh auth setup-git` is the step that is easy to forget. Without it `gh` is logged in but plain `git push`, which dead-drop uses, is not.

## 4. Generate the secret and move it out of band

On one machine:

```bash
npx --package @fyrlabs/dead-drop ddrop keygen | head -1 > ~/.deaddrop/ddshell.secret
chmod 600 ~/.deaddrop/ddshell.secret
```

Copy that file to `/home/ddshell/.deaddrop/ddshell.secret` on the VM over a channel you already trust (an existing SSH session, a password manager, a cloud secret store). **Never commit it and never send it through the Git repository.** Owner `ddshell`, mode 0600.

Anyone holding the secret and the current key era is trusted broadly by dead-drop: they can read and write every message in the workspace and claim any peer id. `allowControllers` checks the identity dead-drop authenticated, but the secret is what makes that identity mean anything. That is why this workspace, repository and secret should be dedicated to the shell.

## 5. Install and configure

On both machines:

```bash
npm install -g @fyrlabs/dead-drop-shell
```

On the VM, copy [examples/server.json](../examples/server.json) to `/home/ddshell/.deaddrop/ddshell.json` and set `repo`. On your machine, copy [examples/controller.json](../examples/controller.json) to `~/.deaddrop/ddshell.json` and set the same `repo`. The peer ids must match: the controller's `peerId` must appear in the server's `allowControllers`, and the controller's `targets` must point at the server's `peerId`.

Try the server in the foreground first:

```bash
sudo -iu ddshell ddshell serve
```

## 6. Run the server under systemd

```bash
sudo cp examples/ddshell-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ddshell-server
journalctl -u ddshell-server -f
```

The unit runs `ddshell` through `/usr/bin/env`, so it must be on systemd's `PATH`. If `npm install -g` put it somewhere else (nvm, a user prefix), write the absolute path into `ExecStart`.

`systemctl stop` sends SIGTERM; the server kills every session shell and its background jobs before exiting. A restart loses every session, and a command that was running at that moment is reported as unknown.

The unit has not been tested on a real Linux host yet.

## 7. Connect

```bash
ddshell exec vm -- uptime
ddshell vm
```

Add `--debug` to see the job id, the time spent on the target machine and the full round trip for each command.

## Removing a controller

Taking a name out of `allowControllers` stops the server from serving it, but anyone still holding the current key era can claim any peer id, including one that is still allowed. Real removal is dead-drop's: set `"enrollment": { "requireApproval": true }` on the workspace, approve the peers that stay, then run `ddrop peer revoke <peer>` and `ddrop rotate`. Read dead-drop's security model (`docs/security-model.md`) before relying on it; the removed peer can still read everything written before the rotation. The server re-reads its config only on restart.
