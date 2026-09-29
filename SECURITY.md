# Security

The machine running `ddshell serve` (the target you connect to, like the VM) executes any shell command sent by a controller it allows. Treat that machine as if it were running an SSH server, because in effect it is.

## What protects the server

- **The OS account.** Every command runs as the account that runs `ddshell serve` on the target machine. That account's permissions are the only limit on what an allowed caller can do. Use a dedicated, unprivileged account with no `sudo`, `docker` or other privileged group.
- **Controller keys.** Every request is signed with the controller's own Ed25519 key (`ddshell keygen`) over the whole sealed request (job id, session id, operation and body), the host key it is meant for, a timestamp and a nonce. The server runs only requests signed by a key in `shell.authorizedKeys` or `shell.authorizedKeysFile`, and refuses a timestamp outside `replayWindowMs` (10 minutes by default) or a nonce it has seen. The key file is refused if other users can read it. To remove a controller, delete its line and restart the server.
- **The host key.** Requests are sealed to the server's X25519 host key and answers to the controller's key, so other members of the workspace cannot read commands or output, and every answer is signed by the host key. The controller pins the host key the first time it talks to a server (trust on first use, like ssh) and refuses a server whose key changed. The first contact is only as safe as the workspace: someone holding the secret could answer it first. Set `shell.strictHostKeys` and put the line `ddshell hostkey` prints on the server into `shell.knownHosts` to close that gap.
- **The workspace secret and key era.** dead-drop encrypts and authenticates every message. Anyone holding the secret and the current key era can claim any peer id, drop or delay messages, and send requests. Without an authorised key those requests are refused, but the refusal itself is a plain, unsigned dead-drop error, so such a member can deny service, not run commands or read output. Use a workspace, repository and secret dedicated to the shell anyway. To keep people from sharing an account or a secret at all, give each one their own server ([docs/per-person.md](docs/per-person.md)).
- **`allowV1` and `allowControllers`.** Protocol v1 (ddshell 0.1.x controllers) trusts dead-drop's peer id, which any secret holder can claim. It is off unless `shell.allowV1` is true, and then only peers in `shell.allowControllers` get in. Leave it off once your controllers have keys.

## What ddshell keeps and logs

- The server log records job ids, caller identity (`key:` and the key fingerprint for v2), exit codes, durations and byte counts. It never records commands or output. For file transfers it records the transfer id, caller identity and size, never paths or contents.
- `put` can write, and `get` can read, any file or (with `-r`) directory tree the server's account can. That adds nothing an allowed controller could not already do with `cat`, but it is the same OS account boundary, so keep that account unprivileged.
- The ledger keeps each finished command's output (not its text) for `ledgerRetentionMs`, default 24 hours, in files readable only by the account running the server.
- Commands and output travel sealed to the recipient's key inside dead-drop's own encryption. Over GitHub, assume the ciphertext can stay in the repository's history (not verified against dead-drop's GitHub transport).
- Child shells do not inherit `DEADDROP_*` or `DDSHELL_*` environment variables, so a secret passed to the server that way is not visible to commands. The server must read its secret file, and commands run as the same account, so an allowed controller can read that file. This is inherent, not a bug.

## Reporting a vulnerability

Please report privately through GitHub security advisories on this repository rather than in a public issue.
