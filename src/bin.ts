#!/usr/bin/env node
import { main } from './cli.js';

// A reader that quits early (`ddshell exec vm -- yes | head`) closes the pipe.
// That is the reader's choice, not a failure: drop what it cannot take and keep
// the command's own exit code. Anything else on these streams still throws.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error;
  });
}

process.exitCode = await main(process.argv.slice(2));
// Runtime pollers and file watchers may still hold the loop; the command is done.
// Standard output is not a file though: to a pipe or a file it is asynchronous,
// so anything still queued would be dropped by exiting here. Let it drain first.
await Promise.all([process.stdout, process.stderr].map(drained));
process.exit();

/** Resolves once `stream` has handed everything it was given to the OS. */
function drained(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (!stream.writableLength) {
      resolve();
      return;
    }
    stream.write('', () => resolve());
  });
}
