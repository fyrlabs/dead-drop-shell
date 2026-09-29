# Local demo

A server and a controller on one machine, talking through a shared folder. No network, no GitHub. Every relative path in these configs resolves against the config file, so the folder works wherever you copy it.

```bash
cp -r "$(npm root -g)/@fyrlabs/dead-drop-shell/examples/local" /tmp/ddshell-demo   # or examples/local from a clone
cd /tmp/ddshell-demo
npx --package @fyrlabs/dead-drop ddrop keygen | head -1 > secret
chmod 600 secret
ddshell keygen --config controller.json >> authorized_keys   # the controller's key, let in by the server

ddshell serve --config server.json        # terminal 1
ddshell vm --config controller.json       # terminal 2
```

The first request pins the server's host key in `known_hosts` and says so on stderr. Commands run as you, starting in your home directory. `ddshell exec vm --config controller.json -- uname -a` runs one command and exits with its exit code. `ddshell check --config controller.json` checks the setup, and `ddshell ping vm --config controller.json` asks the server for its version. `ddshell cp server.json vm:copy.json --config controller.json` copies a file to the server's home, and `ddshell get vm copy.json back.json --config controller.json` fetches it again.

To move the server to another machine, replace the `filesystem` transport in both files with `github` and follow [docs/github-setup.md](../../docs/github-setup.md).
