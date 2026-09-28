# Security

The machine running `ddshell serve` (the target you connect to, like the VM) executes any shell command sent by a controller it allows. Treat that machine as if it were running an SSH server, because in effect it is.

## What protects the server

- **The OS account.** Every command runs as the account that runs `ddshell serve` on the target machine. That account's permissions are the only limit on what an allowed caller can do. Use a dedicated, unprivileged account with no `sudo`, `docker` or other privileged group.
- **The workspace secret and key era.** dead-drop encrypts and authenticates every message. Anyone holding the secret and the current key era can read all traffic and claim any peer id. There are no per-peer signatures.
- **`allowControllers`.** The server refuses callers whose authenticated identity is not listed. Every peer in a workspace holds the secret and can claim a listed name, so this only guards against honest mistakes and misconfigured peers, never against a peer acting in bad faith. Use a workspace, repository and secret dedicated to the shell, shared only with machines you would give a shell to.

## What ddshell keeps and logs

- The server log records job ids, caller identity, exit codes, durations and byte counts. It never records commands or output. For file transfers it records the transfer id, caller identity and size, never paths or contents.
- `put` can write, and `get` can read, any file the server's account can. That adds nothing an allowed controller could not already do with `cat`, but it is the same OS account boundary, so keep that account unprivileged.
- The ledger keeps each finished command's output (not its text) for `ledgerRetentionMs`, default 24 hours, in files readable only by the account running the server.
- Command output travels through the transport encrypted. Over GitHub, assume the ciphertext can stay in the repository's history (not verified against dead-drop's GitHub transport).
- Child shells do not inherit `DEADDROP_*` or `DDSHELL_*` environment variables, so a secret passed to the server that way is not visible to commands. The server must read its secret file, and commands run as the same account, so an allowed controller can read that file. This is inherent, not a bug.

## Reporting a vulnerability

Please report privately through GitHub security advisories on this repository rather than in a public issue.
