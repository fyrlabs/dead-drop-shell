# Changelog

## Unreleased

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
