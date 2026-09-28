import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const manifest = (path: string | URL) =>
  (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version;

export const VERSION = manifest(new URL('../package.json', import.meta.url));

/** The installed dead-drop, through its exported `./package.json` subpath. */
export const DEAD_DROP_VERSION = manifest(
  createRequire(import.meta.url).resolve('@fyrlabs/dead-drop/package.json'),
);
