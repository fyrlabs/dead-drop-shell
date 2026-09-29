import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { systemdUnit } from '../src/unit.js';

const base = { node: '/usr/bin/node', bin: '/usr/lib/ddshell/dist/bin.js', account: 'ddshell' };

/** Directives only: comments and blank lines are free to differ. */
const directives = (text: string) =>
  text.split('\n').filter((line) => line !== '' && !line.startsWith('#'));

describe('systemdUnit', () => {
  it('starts the server by absolute paths as the account', () => {
    const unit = systemdUnit({ ...base, config: '/etc/ddshell.json', template: false });
    expect(directives(unit)).toContain('User=ddshell');
    expect(directives(unit)).toContain(
      'ExecStart=/usr/bin/node /usr/lib/ddshell/dist/bin.js serve --config /etc/ddshell.json',
    );
  });

  it('matches the shipped template but for ExecStart', async () => {
    const shipped = await readFile(
      new URL('../examples/ddshell-server@.service', import.meta.url),
      'utf8',
    );
    const made = systemdUnit({ ...base, template: true });
    const withoutExec = (text: string) =>
      directives(text).filter((line) => !line.startsWith('ExecStart='));
    expect(withoutExec(made)).toEqual(withoutExec(shipped));
    expect(directives(made)).toContain(
      'ExecStart=/usr/bin/node /usr/lib/ddshell/dist/bin.js serve',
    );
  });

  it('quotes and escapes paths systemd would otherwise split or expand', () => {
    const unit = systemdUnit({
      ...base,
      node: '/opt/my node/100%/$HOME/node',
      template: false,
    });
    expect(unit).toContain('ExecStart="/opt/my node/100%%/$$HOME/node" ');
  });

  it.each(['bad name', 'root\nUser=x', ''])('refuses account %j', (account) => {
    expect(() => systemdUnit({ ...base, account, template: false })).toThrow(/account/);
  });

  it('refuses a path with a newline', () => {
    expect(() => systemdUnit({ ...base, config: '/etc/x\nUser=root', template: false })).toThrow(
      /control character/,
    );
  });
});
