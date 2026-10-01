import { connect, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';

import { DeadDropError } from '@fyrlabs/dead-drop/protocol';

import { OutputBuffer, freshInput } from './output.js';

/** How long `open` waits for the connection before it gives up. */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * One TCP connection the server holds for a controller. What the far end sends
 * lands in an `OutputBuffer` the client reads by offset; what the client sends
 * is applied by byte offset, so a request delivered twice sends nothing twice.
 */
export class TcpStream {
  readonly buffer: OutputBuffer;
  lastUsed = performance.now();
  /** Input bytes applied so far. */
  received = 0;
  closed = false;
  error: string | undefined;
  private readonly socket: Socket;

  private constructor(socket: Socket, outputCapBytes: number) {
    this.socket = socket;
    this.buffer = new OutputBuffer(outputCapBytes);
    socket.on('data', (data) => this.buffer.append(1, data));
    socket.on('error', (error: NodeJS.ErrnoException) => {
      this.error = error.code ?? error.message;
    });
    socket.on('close', () => {
      this.closed = true;
      this.buffer.close();
    });
  }

  /** Connects, or rejects with why not. Nothing else touches the network before the allow check. */
  static open(host: string, port: number, outputCapBytes: number): Promise<TcpStream> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host, port, timeout: CONNECT_TIMEOUT_MS });
      const fail = (error: Error) => {
        socket.destroy();
        const code = (error as NodeJS.ErrnoException).code ?? error.message;
        reject(new DeadDropError('SERVICE_ERROR', `could not connect: ${code}`));
      };
      socket.once('error', fail);
      socket.once('timeout', () => fail(new Error('timed out')));
      socket.once('connect', () => {
        socket.off('error', fail);
        socket.setTimeout(0);
        resolve(new TcpStream(socket, outputCapBytes));
      });
    });
  }

  write(offset: number, bytes: Buffer): void {
    const fresh = freshInput(this.received, offset, bytes);
    if (fresh.length === 0 || this.closed) return;
    this.received += fresh.length;
    this.socket.write(fresh);
  }

  close(): void {
    this.socket.destroy();
  }
}
