import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Protocol from '../src/protocol.js';
import { walk } from '../src/transfer.js';

// Without a limit, `entries.length >= limit` is always false, so a lost default
// would make walk() unbounded. Shrink the constant to prove the default is it.
vi.mock('../src/protocol.js', async (importOriginal) => ({
  ...(await importOriginal<typeof Protocol>()),
  MAX_TREE_ENTRIES: 2,
}));

let local: string;
beforeEach(async () => {
  local = await mkdtemp(join(tmpdir(), 'ddshell-walk-'));
});
afterEach(async () => {
  await rm(local, { recursive: true, force: true });
});

describe('walk default limit', () => {
  it('applies MAX_TREE_ENTRIES to entries and skipped ones when no limit is passed', async () => {
    const tree = join(local, 'tree');
    await mkdir(tree);
    for (const name of ['a', 'b']) await writeFile(join(tree, name), name);
    expect((await walk(tree)).entries).toHaveLength(2);
    await writeFile(join(tree, 'c'), 'c');
    await expect(walk(tree)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });

    const dangling = join(local, 'dangling');
    await mkdir(dangling);
    for (const name of ['x', 'y']) await symlink('missing', join(dangling, name));
    expect((await walk(dangling)).skipped).toHaveLength(2);
    await symlink('missing', join(dangling, 'z'));
    await expect(walk(dangling)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });
});
