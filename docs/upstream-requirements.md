# What a dead-drop extension host would need

ddshell is phase one of dead-drop's [application extension proposal](https://github.com/fyrlabs/dead-drop/blob/main/docs/proposals/0001-application-extensions.md): prove the lifecycle with one real application before core grows a plugin system. These are the requirements that surfaced while building it against dead-drop 0.16.0. None of them are changes made to dead-drop; this package uses only its public API.

## Register handlers before the mailbox starts

`workspace.service()` can only be called after `runtime.start()`, which already starts polling. A request that was queued while the server was down could in principle be picked up before the `shell.v1` handler exists. The integration test for exactly that case passes, but that shows the current timing works, not that it is guaranteed. A host should accept registrations first and start the mailbox after, or document that a request for an unregistered channel is retried rather than answered as not found. The same ordering leaves the first presence beacon without `shell.v1` in its `services`, and the next one comes a full `presenceIntervalMs` later (30 s by default), so for that long discovery says the server offers nothing. `ddshell check` has to explain this in its warning instead of trusting the beacon.

## `idempotencyKey` and re-asking conflict

dead-drop dedupes deliveries on `idempotencyKey ?? envelope.id`. ddshell has its own job id, and the obvious move is to pass it as `idempotencyKey`. That breaks re-asking: a client that times out and sends the same job again would have the retry dropped by the mailbox instead of getting the recorded result from the ledger. ddshell therefore sends no key and dedupes in its own ledger. A host should say which layer owns deduplication for request/response traffic, and ideally let a handler answer a known duplicate from its own store.

## Per-process mailbox addresses

A controller and a long-running `ddrop start` on one machine share a peer id. ddshell gives its runtime a random `sessionId` so replies come back to the right process while `context.identity` stays the configured peer. This works, but every short-lived client has to know to do it. A host should make it the default for CLI clients.

## Identity, not address

`RequestContext.from` is a reply address and `identity` is the authenticated peer. Authorisation must use `identity`. The names make the wrong one easy to reach for; a host's permission layer should only ever hand plugins the identity.

`identity` itself is only as strong as the workspace secret: any holder can claim any peer id. ddshell therefore brings its own per-controller Ed25519 keys, host keys and sealing (`src/envelope.ts`). Per-peer signing keys in dead-drop, with `identity` bound to them, would let a host drop that layer.

## Binary payloads

Resolved: `workspace.handle(channel, handler)` and `workspace.request(peer, channel, bytes, { headers: { accept } })` carry `Uint8Array` as is, which ddshell's v2 envelope uses to move output and file pieces without base64. Only `service()` and `call()` force JSON.

## Errors that survive the round trip

`workspace.call` rethrows a remote `DeadDropError` with its code, which is what lets the CLI tell `UNAUTHORIZED` from `TIMEOUT`. `workspace.request` returns the error payload instead of throwing, which is easy to miss. A plugin API should expose one of these, not both.

## Application config beside runtime config

`parseRuntimeConfig` ignores unknown top-level keys, so ddshell's `shell` section lives in the same file. But `${env:}` and `${file:}` expansion does not reach it, and nothing validates it until ddshell does. A host should give each plugin a validated config section with the same reference expansion.

## Per-service concurrency

Workspace `concurrency` defaults to 1, which lets one slow command hold up every other session. ddshell raises it to 8 for the whole workspace. Up to dead-drop 0.16.0 that was not enough: the mailbox handled each poll's requests in batches and waited for the whole batch before polling again, so a request arriving on a later poll waited until every running command had finished. [dead-drop 0.16.1](https://github.com/fyrlabs/dead-drop/releases/tag/v0.16.1) runs handlers in a sliding pool that keeps polling while they run, and ddshell requires it. The tests `keeps sessions independent and runs them concurrently` and `answers pings, uploads and other commands while a long command runs` (real processes over the git transport) fail without it. The pool is still one per workspace, so with every slot held by a long command a ping or a transfer chunk waits too. What is still missing is a way for a service to declare its own concurrency instead of sharing one workspace-wide number with every other service.

## Timers that keep the process alive

dead-drop unrefs all its clock timers. Only the filesystem transport holds a ref'd handle (its `fs.watch`), so over git or GitHub an embedding process with nothing else to do exits with code 13 in the middle of a request. `ShellClient` and `ShellServer` each hold an interval of their own for this. Tests over the filesystem transport cannot catch it. A host should keep the process alive while it has pending requests or registered services, or document that the embedder must.

## Lifecycle hooks the shell needed

Start after the runtime is ready, a periodic tick (idle sweeping, ledger pruning), and an orderly stop that runs before the runtime shuts down so child processes are killed while replies can still be sent. Streaming output and cancellation need ordered chunks and a cancel signal delivered to a running handler.
