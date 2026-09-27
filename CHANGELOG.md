# Changelog

## 0.1.0 (unreleased)

First version: a remote shell over dead-drop, an alternative to SSH for machines with no open port.

- `ddshell agent` serves shell sessions to the controllers you allow.
- `ddshell <target>` opens an interactive session; `cd` and `export` carry over between commands.
- `ddshell exec <target> -- <command>` runs one command and exits with its exit code.
- Each result has stdout, stderr, exit code, duration, working directory and a job id.
- A command delivered twice runs once. A command interrupted by an agent restart is reported as unknown and never rerun.
- Output is capped at 8 MiB per command; sessions close after 30 idle minutes; commands time out after 10 minutes.
