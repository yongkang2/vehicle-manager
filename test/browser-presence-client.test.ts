import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'

const pageId = '17e1aaf4-10eb-4e66-b7a3-5ec00cf2586d', pageToken = 'b'.repeat(64), epoch = 'a'.repeat(64)
type Command = { pageId: string; pageToken: string; generation: number }
type Call = { url: string; options: RequestInit; body: Command & { token?: string } }
let fixtureId = 0
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const flush = async () => { await new Promise<void>(resolve => setImmediate(resolve)) }

async function fixture(context: TestContext, options: { seeded?: boolean; canClose?: boolean } = {}) {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  const calls: Call[] = [], sockets: Socket[] = [], cleanup: (() => void)[] = []
  let handler: ((call: Call) => Promise<Response>) | undefined
  class Window extends EventTarget {
    location = { href: 'http://127.0.0.1:4410/' }
    readonly listeners = new Map<string, EventListener[]>()
    readonly timers: { callback: () => void; milliseconds: number }[] = []
    override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
      if (typeof callback === 'function') this.listeners.set(type, [...(this.listeners.get(type) || []), callback])
      super.addEventListener(type, callback, options)
    }
    setTimeout(callback: () => void, milliseconds: number) { this.timers.push({ callback, milliseconds }); return setTimeout(callback, milliseconds) }
    clearTimeout(timer: ReturnType<typeof setTimeout>) { clearTimeout(timer) }
  }
  class Document extends EventTarget {
    visibilityState = 'visible'
    querySelector() { return options.seeded === false ? null : { getAttribute(name: string) { return name === 'content' ? pageId : name === 'data-token' ? pageToken : null } } }
  }
  class Socket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
    readyState = Socket.CONNECTING
    onopen: ((event: Event) => void) | null = null
    onclose: ((event: Event) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    closeCalls = 0
    readonly url: string
    constructor(url: string | URL) { this.url = String(url); sockets.push(this) }
    open() { this.readyState = Socket.OPEN; this.onopen?.(new Event('open')) }
    lose() { this.readyState = Socket.CLOSED; this.onclose?.(new Event('close')) }
    close() { this.closeCalls++; this.lose() }
  }
  const window = new Window(), document = new Document()
  const globals = { window, document, WebSocket: Socket }
  const before = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  const response = (call: Call) => new Response(JSON.stringify(call.url.endsWith('/close') ? { ok: true } : { token: epoch, pageId: call.body.pageId, generation: call.body.generation, canClose: options.canClose !== false }), { headers: { 'Content-Type': 'application/json' } })
  context.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(url), options: init, body: JSON.parse(String(init.body)) as Call['body'] }
    calls.push(call)
    return handler ? handler(call) : response(call)
  })
  const client = await import(new URL(`../src/browser-presence.ts?fixture=${++fixtureId}`, import.meta.url).href) as typeof import('../src/browser-presence.js')
  context.after(() => {
    for (const dispose of cleanup) dispose()
    for (const [key, descriptor] of before) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })
  const start = () => { const dispose = client.trackBrowserPresence(); cleanup.push(dispose); return dispose }
  const hide = (persisted: boolean) => { const event = new Event('pagehide'); Object.defineProperty(event, 'persisted', { value: persisted }); window.dispatchEvent(event) }
  return { client, window, document, calls, sockets, start, hide, response, setHandler: (next?: typeof handler) => { handler = next }, registrations: () => calls.filter(call => !call.url.endsWith('/close')), closes: () => calls.filter(call => call.url.endsWith('/close')), tick: (milliseconds: number) => context.mock.timers.tick(milliseconds) }
}

test('StrictMode-style remount keeps document identity and ignores callbacks from the previous tracker', async context => {
  const f = await fixture(context), firstCleanup = f.start()
  await flush(); const first = f.sockets[0], staleOpen = first.onopen, staleClose = first.onclose
  const staleHide = f.window.listeners.get('pagehide')![0]
  first.open(); firstCleanup()
  assert.equal(f.closes().length, 0, 'Effect cleanup is not a document closure')
  f.start(); await flush()
  const [firstRegistration, nextRegistration] = f.registrations()
  assert.equal(firstRegistration.body.pageId, pageId); assert.equal(firstRegistration.body.pageToken, pageToken)
  assert.equal(nextRegistration.body.pageId, pageId); assert.equal(nextRegistration.body.pageToken, pageToken)
  assert(nextRegistration.body.generation > firstRegistration.body.generation)
  const second = f.sockets[1]; second.open()
  staleOpen?.(new Event('open')); staleClose?.(new Event('close')); firstCleanup()
  const staleEvent = new Event('pagehide'); Object.defineProperty(staleEvent, 'persisted', { value: false }); staleHide.call(f.window, staleEvent)
  f.tick(15000); await flush()
  assert.equal(f.registrations().length, 2); assert.equal(second.closeCalls, 0); assert.equal(f.closes().length, 0)
  const url = new URL(second.url)
  assert.equal(url.searchParams.get('token'), epoch); assert.equal(url.searchParams.get('pageId'), pageId)
  assert.equal(url.searchParams.get('pageToken'), pageToken)
  assert.equal(url.searchParams.get('generation'), String(nextRegistration.body.generation))
})

test('hidden/minimized and frozen pages never send closure; restore events coalesce one repair', async context => {
  const f = await fixture(context); f.start(); await flush(); f.sockets[0].open()
  f.document.visibilityState = 'hidden'; f.document.dispatchEvent(new Event('visibilitychange'))
  f.window.dispatchEvent(new Event('focus')); f.tick(600000); await flush()
  assert.equal(f.sockets[0].closeCalls, 0); assert.equal(f.registrations().length, 1)
  f.document.dispatchEvent(new Event('freeze')); f.tick(600000); await flush()
  assert.equal(f.closes().length, 0)
  f.document.visibilityState = 'visible'; f.document.dispatchEvent(new Event('visibilitychange'))
  f.window.dispatchEvent(new Event('focus')); f.window.dispatchEvent(new Event('online')); f.document.dispatchEvent(new Event('resume'))
  await flush(); assert.equal(f.registrations().length, 2)
  f.sockets[1].open(); assert.equal(f.closes().length, 0)
})

test('BFCache suspension never certifies closure and restoration closes only the newer acknowledged generation', async context => {
  const f = await fixture(context); f.start(); await flush(); f.sockets[0].open()
  f.hide(true); f.tick(600000); await flush()
  assert.equal(f.closes().length, 0); assert.equal(f.registrations().length, 1)
  f.window.dispatchEvent(new Event('pageshow')); await flush(); f.sockets[1].open()
  const generation = f.registrations()[1].body.generation
  f.hide(false); await flush()
  assert.equal(f.closes().length, 1); assert.equal(f.closes()[0].body.generation, generation)
})

test('document closure uses independent keepalive with the protected header and is sent only once', async context => {
  const f = await fixture(context), dispose = f.start()
  await flush(); f.sockets[0].open()
  const delivery = deferred<Response>()
  f.setHandler(async call => call.url.endsWith('/close') ? delivery.promise : f.response(call))
  f.hide(false); f.hide(false); dispose()
  assert.equal(f.closes().length, 1)
  const close = f.closes()[0]
  assert.equal(close.options.keepalive, true); assert.equal(close.options.signal, undefined)
  assert.equal((close.options.headers as Record<string, string>)['X-App-Request'], 'vehicle-manager')
  assert.deepEqual(close.body, { token: epoch, pageId, pageToken, generation: f.registrations()[0].body.generation })
  delivery.resolve(new Response('{}')); await flush()
})

test('unanchored or legacy documents honor canClose=false even after a healthy connection', async context => {
  const f = await fixture(context, { seeded: false, canClose: false }); f.start()
  await flush(); f.sockets[0].open()
  assert.match(f.registrations()[0].body.pageId, /^[a-f0-9-]{36}$/)
  assert.match(f.registrations()[0].body.pageToken, /^[a-f0-9]{64}$/)
  f.hide(false); await flush(); assert.equal(f.closes().length, 0)
})

test('an unclassified pagehide event stays uncertain instead of certifying closure', async context => {
  const f = await fixture(context); f.start(); await flush(); f.sockets[0].open()
  f.window.dispatchEvent(new Event('pagehide')); await flush()
  assert.equal(f.closes().length, 0)
  f.window.dispatchEvent(new Event('pageshow')); await flush(); f.sockets[1].open()
  f.hide(false); assert.equal(f.closes().length, 1)
})

test('a never-resolving token request has a five-second deadline and its late reply cannot overwrite a newer connection', async context => {
  const f = await fixture(context), firstResponse = deferred<Response>()
  f.setHandler(async call => f.registrations().length === 1 ? firstResponse.promise : f.response(call))
  f.start(); const rejected = assert.rejects(f.client.repairBrowserPresence(), /PRESENCE_TIMEOUT/)
  f.tick(4999); await flush(); assert.equal(f.registrations().length, 1)
  f.tick(1); await rejected
  assert.equal(f.registrations()[0].options.signal?.aborted, true)
  f.tick(999); await flush(); assert.equal(f.registrations().length, 1)
  f.tick(1); await flush(); f.sockets[0].open()
  firstResponse.resolve(f.response(f.registrations()[0])); await flush()
  assert.equal(f.sockets.length, 1)
  f.hide(false); assert.equal(f.closes()[0].body.generation, f.registrations()[1].body.generation)
})

test('the same deadline covers an unresolved JSON body, not just token response headers', async context => {
  const f = await fixture(context), body = deferred<unknown>()
  f.setHandler(async () => ({ ok: true, json: () => body.promise }) as Response)
  f.start(); const rejected = assert.rejects(f.client.repairBrowserPresence(), /PRESENCE_TIMEOUT/)
  await flush(); f.tick(5000); await rejected
  f.setHandler(); const repaired = f.client.repairBrowserPresence()
  await flush(); f.sockets[0].open(); await repaired
  const old = f.registrations()[0]
  body.resolve({ token: epoch, pageId: old.body.pageId, generation: old.body.generation, canClose: true }); await flush()
  assert.equal(f.sockets.length, 1); assert.equal(f.closes().length, 0)
})

test('a stalled WebSocket handshake times out and late socket callbacks cannot damage its replacement', async context => {
  const f = await fixture(context); f.start(); const rejected = assert.rejects(f.client.repairBrowserPresence(), /PRESENCE_TIMEOUT/)
  await flush(); const old = f.sockets[0], lateOpen = old.onopen, lateClose = old.onclose
  f.tick(5000); await rejected; assert.equal(old.closeCalls, 1)
  const repaired = f.client.repairBrowserPresence(); await flush(); f.sockets[1].open(); await repaired
  lateOpen?.(new Event('open')); lateClose?.(new Event('close')); f.tick(15000); await flush()
  assert.equal(f.sockets[1].closeCalls, 0); assert.equal(f.registrations().length, 2)
})

test('lost established sockets remain uncertain and automatic reconnect keeps the document identity', async context => {
  const f = await fixture(context); f.start(); await flush(); f.sockets[0].open()
  f.sockets[0].lose(); assert.equal(f.closes().length, 0)
  f.tick(1000); await flush(); assert.equal(f.registrations().length, 2)
  assert.equal(f.registrations()[1].body.pageId, f.registrations()[0].body.pageId)
  f.sockets[1].open(); assert.equal(f.closes().length, 0)
})

test('explicit repairs coalesce and cancelling one caller leaves the document handshake available to another', async context => {
  const f = await fixture(context), controller = new AbortController()
  f.start(); const cancelled = assert.rejects(f.client.repairBrowserPresence({ signal: controller.signal }), { name: 'AbortError' })
  const second = f.client.repairBrowserPresence(); controller.abort(); await cancelled; await flush()
  assert.equal(f.registrations().length, 1); assert.equal(f.sockets[0].closeCalls, 0)
  f.sockets[0].open(); await second
  const forced = f.client.repairBrowserPresence(); await flush()
  assert.equal(f.registrations().length, 2, 'Retry does not trust an apparently OPEN old transport')
  f.sockets[1].open(); await forced
})

test('a closing document with unacknowledged registration never invents closure or connects after its late response', async context => {
  const f = await fixture(context), response = deferred<Response>()
  f.setHandler(async () => response.promise)
  f.start(); f.hide(false); response.resolve(f.response(f.registrations()[0])); await flush()
  f.tick(600000); await flush()
  assert.equal(f.sockets.length, 0); assert.equal(f.closes().length, 0); assert.equal(f.registrations().length, 1)
})

test('mismatched registration echoes cannot establish presence or authorize document closure', async context => {
  const f = await fixture(context)
  f.setHandler(async call => new Response(JSON.stringify({ token: epoch, pageId: 'another-document', generation: call.body.generation, canClose: true })))
  f.start(); const rejected = assert.rejects(f.client.repairBrowserPresence(), /NETWORK_ERROR/)
  await flush(); await rejected; f.hide(false)
  assert.equal(f.sockets.length, 0); assert.equal(f.closes().length, 0)
})

test('automatic retry backs off from one to fifteen seconds and explicit repair bypasses that delay', async context => {
  const f = await fixture(context)
  f.setHandler(async () => new Response('', { status: 503 }))
  f.start(); await flush()
  for (const delay of [1000, 2000, 4000, 8000, 15000, 15000]) {
    const previous = f.registrations().length
    f.tick(delay - 1); await flush(); assert.equal(f.registrations().length, previous)
    f.tick(1); await flush(); assert.equal(f.registrations().length, previous + 1)
  }
  f.setHandler(); const repaired = f.client.repairBrowserPresence(); await flush()
  f.sockets[0].open(); await repaired
  const count = f.registrations().length; f.tick(15000); await flush()
  assert.equal(f.registrations().length, count); assert.equal(f.closes().length, 0)
})

test('a queued retry from an older attempt cannot erase or bypass a newer backoff timer', async context => {
  const f = await fixture(context)
  f.setHandler(async () => new Response('', { status: 503 }))
  f.start(); await flush()
  const oldRetry = f.window.timers.find(timer => timer.milliseconds === 1000)!
  await assert.rejects(f.client.repairBrowserPresence(), /NETWORK_ERROR/)
  assert.equal(f.registrations().length, 2)
  oldRetry.callback(); await flush()
  assert.equal(f.registrations().length, 2, 'A cancelled old callback must not start a premature attempt')
  f.setHandler(); f.tick(1999); await flush(); assert.equal(f.registrations().length, 2)
  f.tick(1); await flush(); assert.equal(f.registrations().length, 3)
  f.sockets[0].open()
})
