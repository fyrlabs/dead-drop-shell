#!/usr/bin/env node
import { main } from './cli.js';

process.exitCode = await main(process.argv.slice(2));
// Runtime pollers and file watchers may still hold the loop; the command is done.
process.exit();
