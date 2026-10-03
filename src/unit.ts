import { DeadDropError } from '@fyrlabs/dead-drop/protocol';

export interface UnitOptions {
  /** Absolute path of the node binary. */
  node: string;
  /** Absolute path of ddshell's `dist/bin.js`. */
  bin: string;
  /** Account the server runs as. Ignored for a template, whose instance name is the account. */
  account: string;
  /** Absolute config path. Without it the server reads the account's `~/.deaddrop/ddshell.json`. */
  config?: string;
  /** `ddshell-server@.service`: one server per person, the instance name being the account. */
  template: boolean;
}

/** Login names as `useradd` accepts them by default, so nothing can break out of `User=`. */
const ACCOUNT = /^[a-z_][a-z0-9_-]{0,31}\$?$/i;

/**
 * One ExecStart word. systemd expands `%` specifiers and `$` variables there,
 * and splits on spaces unless the word is quoted.
 */
function word(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(value)) {
    throw new DeadDropError(
      'BAD_REQUEST',
      `path has a control character: ${JSON.stringify(value)}`,
    );
  }
  const escaped = value.replace(/%/g, '%%').replace(/\$/g, '$$$$');
  if (!/[\s"'\\]/.test(escaped)) return escaped;
  return `"${escaped.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * A systemd unit that starts `ddshell serve` by absolute paths, so it works
 * whatever `PATH` systemd has and wherever npm put the package.
 */
export function systemdUnit(options: UnitOptions): string {
  const { template } = options;
  if (!template && !ACCOUNT.test(options.account)) {
    throw new DeadDropError('BAD_REQUEST', `not an account name: ${options.account}`);
  }
  const exec = [options.node, options.bin, 'serve'].map(word);
  if (options.config !== undefined) exec.push('--config', word(options.config));
  const file = template ? 'ddshell-server@.service' : 'ddshell-server.service';
  const intro = template
    ? [
        `# /etc/systemd/system/${file}`,
        '#',
        '# One server per person: `systemctl enable --now ddshell-server@alice` runs a',
        '# server as the account "alice", reading its ~/.deaddrop/ddshell.json.',
        '# See docs/per-person.md.',
      ]
    : [
        `# /etc/systemd/system/${file}`,
        '#',
        `# Runs the server as "${options.account}". The account's permissions are the real`,
        '# boundary: every allowed command runs as it.',
      ];
  return `${[
    ...intro,
    '# Made by `ddshell unit`; the paths are where node and ddshell were when it ran.',
    '',
    '[Unit]',
    `Description=ddshell server${template ? ' for %i' : ''} (line-oriented remote shell over dead-drop)`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `User=${template ? '%i' : options.account}`,
    'WorkingDirectory=~',
    `ExecStart=${exec.join(' ')}`,
    '# Reload re-reads the authorised keys, so revoking a key needs no restart.',
    'ExecReload=/bin/kill -HUP $MAINPID',
    'Restart=on-failure',
    'RestartSec=5',
    '# Stop sends SIGTERM; the server closes every session shell before exiting.',
    'KillMode=mixed',
    'TimeoutStopSec=30',
    '',
    '# Hardening that does not get in the way of an ordinary shell account.',
    'NoNewPrivileges=true',
    'PrivateTmp=true',
    'ProtectSystem=full',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
  ].join('\n')}\n`;
}
