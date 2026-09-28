import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import { DeadDropError } from '@fyrlabs/dead-drop/protocol';

import { ShellClient } from './client.js';
import { loadConfig, resolvePath } from './config.js';
import { SHELL_CHANNEL } from './protocol.js';

export interface Finding {
  level: 'ok' | 'warn' | 'fail';
  subject: string;
  message: string;
}

const FILE_REFERENCE = /^\$\{file:(.+)\}$/;

/**
 * Checks a config the way the server or controller would use it: the file
 * parses, its secret files are private, a server's shell and ledger are
 * usable, every transport can be listed, and each target has announced itself.
 * Starting the runtime costs what any `exec` costs, and nothing is sent.
 */
export async function check(path: string, debug = false): Promise<Finding[]> {
  const findings: Finding[] = [];
  const add = (level: Finding['level'], subject: string, message: string) =>
    findings.push({ level, subject, message });

  let config;
  try {
    config = await loadConfig(path);
  } catch (error) {
    add('fail', 'config', describe(error));
    return findings;
  }
  const workspace =
    config.runtime.workspaces.find((entry) => entry.name === config.shell.workspace) ??
    config.runtime.workspaces[0]!;
  add('ok', 'config', `${path}: workspace ${workspace.name}, peer ${workspace.peerId}`);

  for (const file of await secretFiles(path, workspace.name, config.baseDir)) {
    const mode = (await stat(file)).mode & 0o777;
    if (mode & 0o077) {
      add('warn', 'secret', `${file} has mode ${mode.toString(8)}; run chmod 600 on it`);
    } else {
      add('ok', 'secret', `${file} is readable by its owner only`);
    }
  }

  const { allowControllers, targets } = config.shell;
  const serving = allowControllers.length > 0;
  if (!serving && Object.keys(targets).length === 0) {
    add(
      'warn',
      'shell',
      'neither shell.allowControllers (server) nor shell.targets (controller) is set',
    );
  }
  if (serving) {
    if (process.platform === 'win32') add('fail', 'server', 'ddshell serve needs a POSIX system');
    const shell = config.shell.shell;
    await access(shell, constants.X_OK).then(
      () => add('ok', 'server', `shell ${shell} is executable`),
      () => add('fail', 'server', `shell ${shell} is missing or not executable`),
    );
    const ledger = await writableAncestor(config.shell.ledgerDir);
    if (ledger.ok) add('ok', 'server', `ledger ${config.shell.ledgerDir} can be written`);
    else add('fail', 'server', `ledger ${config.shell.ledgerDir}: ${ledger.reason}`);
    add('ok', 'server', `allows ${allowControllers.join(', ')}`);
  }

  let client: ShellClient;
  try {
    client = await ShellClient.start({ ...config, debug });
  } catch (error) {
    add('fail', 'transport', `the runtime did not start: ${describe(error)}`);
    return findings;
  }
  try {
    const queues = await client.workspace.queues();
    const broken = new Map(queues.unreadable.map((entry) => [entry.transport, entry.message]));
    for (const transport of client.workspace.transports()) {
      const reason = broken.get(transport.name);
      if (reason) add('fail', 'transport', `${transport.name}: ${reason}`);
      else add('ok', 'transport', `${transport.name} (${transport.kind}) can be listed`);
    }

    const names = Object.keys(targets);
    if (names.length > 0) {
      const { peers } = await client.workspace.discoverPeers();
      for (const name of names) {
        const peer = targets[name]!;
        const subject = `target ${name}`;
        const record = peers.find((entry) => entry.peerId === peer);
        if (!record) {
          add(
            'warn',
            subject,
            `peer ${peer} has no recent beacon; its server may be down. ddshell ping ${name} asks it directly`,
          );
        } else if (!record.services.includes(SHELL_CHANNEL)) {
          // dead-drop writes the first beacon before the server has registered
          // its handler, so a server that just started lists no services yet.
          add(
            'warn',
            subject,
            `peer ${peer} is up but its beacon does not list ${SHELL_CHANNEL}; a server that just started lists it after one presence interval (30 s by default). ddshell ping ${name} asks it directly`,
          );
        } else {
          const age = Math.max(0, Math.round((Date.now() - record.announcedAt) / 1000));
          add('ok', subject, `peer ${peer} serves ${SHELL_CHANNEL}, announced ${age}s ago`);
        }
      }
    }
  } finally {
    await client.stop();
  }
  return findings;
}

/** `${file:...}` secrets of one workspace, resolved the way dead-drop resolves them. */
async function secretFiles(path: string, name: string, baseDir: string): Promise<string[]> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as {
    workspaces?: Array<{ name?: string; secrets?: unknown[] }>;
  };
  const secrets = raw.workspaces?.find((entry) => entry.name === name)?.secrets ?? [];
  return secrets.flatMap((secret) => {
    const match = typeof secret === 'string' ? FILE_REFERENCE.exec(secret) : null;
    return match ? [resolvePath(match[1]!, baseDir)] : [];
  });
}

/** A directory that does not exist yet is fine if it can be created. */
async function writableAncestor(dir: string): Promise<{ ok: boolean; reason?: string }> {
  for (let current = dir; ; current = dirname(current)) {
    try {
      const info = await stat(current);
      if (!info.isDirectory()) return { ok: false, reason: `${current} is not a directory` };
      await access(current, constants.W_OK);
      return { ok: true };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES') return { ok: false, reason: `${current} is not writable` };
      if (code !== 'ENOENT' || current === dirname(current)) {
        return { ok: false, reason: (error as Error).message };
      }
    }
  }
}

function describe(error: unknown): string {
  if (DeadDropError.is(error)) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
