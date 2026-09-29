# Setting up a VM over GitHub

This connects your machine (peer `laptop`) to a VM (peer `vm`) through a private GitHub repository. Neither machine needs an inbound port. Both need outbound HTTPS to github.com, Node.js 20.11+ and `git`. Only your machine needs `gh`: the VM uses dead-drop's plain `git` transport, which needs nothing but git credentials for the one repository.

Expect a round trip of several seconds per command. That is normal operation, not a fault.

## Latency

Measured with both peers on one Mac, a private GitHub repository and polling of 1 to 5 s: six `exec` round trips took 6.7, 7.1, 10.8, 13.7, 15.5 and 19.8 s, a median of about 12 s. The command itself took 3 to 9 ms of that; the rest is transport.

Part of that is dead-drop's git freshness window. The git transport reuses a fetch for up to `freshnessMs` (default 5000) before fetching again, and a round trip waits on that twice: once for the request, once for the answer. Over a local bare repository, a round trip took 6.1 to 11.2 s at the default and 1.0 to 2.2 s with `"freshnessMs": 100`.

Over GitHub the window matters less, because pushes, fetches and polling backoff add time the window does not control. In one session with polling of 1 to 5 s, six round trips took 11.8 to 24.8 s (median about 21 s) at the default and 12.4 to 16.1 s (median about 14 s) with `"freshnessMs": 1000`. A bare `git fetch` from GitHub took 0.6 to 0.9 s, so values much below 1000 mostly add fetches. The examples use the 5000 ms default to keep an always-on deployment conservative.

A lower window costs git fetches, not REST API calls: the github transport uses the API only at startup and for an occasional rate-limit check, and the REST quota did not move during these runs. GitHub returned no 403 or 429 in about a dozen round trips at 1000; an always-on server over days at that value is untested. The examples still check once a second while a reply is outstanding, but reuse each fetch for up to 5 seconds and back off to 30 seconds while idle.

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

On the VM, give the `ddshell` account a fine-grained personal access token scoped to this one repository with **Contents: read and write**, so a leaked VM token cannot reach anything else. Store it for git and check that git can reach the repository without a prompt:

```bash
sudo -iu ddshell
git config --global credential.helper store
git ls-remote https://github.com/your-org/vm-shell-drop.git
```

Enter your GitHub username and the token as the password once. Git saves it in `~/.git-credentials` as plain text, readable only by `ddshell`. The server runs git non-interactively, so if `ls-remote` still prompts afterwards, the server will fail to fetch.

An SSH deploy key with write access also works: use the SSH URL (`git@github.com:your-org/vm-shell-drop.git`) as the `remote` in step 5, and run `ssh -T git@github.com` once as `ddshell` to accept the host key. This path has not been tested.

On your machine, `gh auth login` followed by `gh auth setup-git` is enough if your account can push to the repository. `gh auth setup-git` is the step that is easy to forget. Without it `gh` is logged in but plain `git push`, which dead-drop uses, is not.

## 4. Generate the secret and move it out of band

On one machine:

```bash
npx --package @fyrlabs/dead-drop ddrop keygen | head -1 > ~/.deaddrop/ddshell.secret
chmod 600 ~/.deaddrop/ddshell.secret
```

Copy that file to `/home/ddshell/.deaddrop/ddshell.secret` on the VM over a channel you already trust (an existing SSH session, a password manager, a cloud secret store). **Never commit it and never send it through the Git repository.** Owner `ddshell`, mode 0600.

Anyone holding the secret and the current key era is trusted broadly by dead-drop: they can read and write every message in the workspace and claim any peer id. ddshell does not rely on that identity: every request is signed with the controller's own key, and commands and output are sealed so the other members cannot read them. A secret holder can still drop or delay messages, so this workspace, repository and secret should be dedicated to the shell.

## 5. Install and configure

On both machines:

```bash
npm install -g @fyrlabs/dead-drop-shell
```

On the VM, copy [examples/server.json](../examples/server.json) to `/home/ddshell/.deaddrop/ddshell.json` and set `remote` to the repository's clone URL. On your machine, copy [examples/controller.json](../examples/controller.json) to `~/.deaddrop/ddshell.json` and set `repo` to the same repository as `owner/name`. The two transports read and write the same branch, so a `git` server and a `github` controller talk to each other; keep `branch` and `prefix` at their defaults on both, or set them to the same values. The controller's `targets` must point at the server's `peerId`.

Make your key on your machine and let it in on the VM:

```bash
ddshell keygen                                   # on your machine; prints one "ddshell-key ..." line
echo 'ddshell-key ... you@laptop' >> /home/ddshell/.deaddrop/ddshell_authorized_keys   # on the VM, that line
```

The first command you run pins the VM's host key in `~/.deaddrop/ddshell_known_hosts` and prints its fingerprint. To check it, run `ddshell hostkey --config /home/ddshell/.deaddrop/ddshell.json` on the VM and compare; to skip trust on first use, put that line in `ddshell_known_hosts` yourself and set `"strictHostKeys": true`.

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

The unit runs `ddshell` through `/usr/bin/env`, so it must be on systemd's `PATH`. If `npm install -g` put it somewhere else (nvm, a user prefix), write absolute paths into `ExecStart`, for example `ExecStart=/usr/bin/node /usr/lib/node_modules/@fyrlabs/dead-drop-shell/dist/bin.js serve --config /home/ddshell/.deaddrop/ddshell.json`. `readlink -f "$(npm prefix -g)/bin/ddshell"` prints the second path.

`systemctl stop` sends SIGTERM; the server kills every session shell and its background jobs before exiting. A restart loses every session, and a command that was running at that moment is reported as unknown.

A server set up this way (git transport, token in the credential store, systemd unit with absolute paths) has run end to end on a Linux VM. The unit exactly as shipped, with `/usr/bin/env`, and a reboot of the VM have not been tested.

To give several people a server each on the same machine, each under their own account, see [per-person.md](per-person.md).

## 7. Connect

```bash
ddshell check
ddshell exec vm -- uptime
ddshell vm
```

`ddshell check` confirms the config, secret, transport and the server's beacon before anything is sent; run it on the server machine too. A server that started less than 30 s ago shows a warning that its beacon does not list `shell.v1` yet. Add `--debug` to see the job id, the time spent on the target machine and the full round trip for each command. `ddshell ping vm --count 5` measures the transport alone: five round trips that run nothing, with min, median and max.

## Removing a controller

Delete the controller's line from `ddshell_authorized_keys` and restart the server; its key is refused from then on, even though it still holds the workspace secret. It cannot read other controllers' traffic, but it can still drop or delay messages until you rotate the secret with dead-drop (`ddrop peer revoke <peer>` and `ddrop rotate`, see dead-drop's `docs/security-model.md`). The server re-reads its config only on restart.
