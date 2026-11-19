// The HTTP seam. In the browser every request goes to the hub over `fetch`
// with the token taken from the `?auth=` link. The desktop shell installs a
// transport that proxies the same requests through Tauri, so the hub token
// never reaches web storage.

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const nativeFetch: FetchLike = (input, init) => globalThis.fetch(input, init)

let transport: FetchLike = nativeFetch
let transportAuth = false

/**
 * Install the request transport. `providesAuth` marks transports that attach
 * hub credentials themselves, which makes the page count as authenticated.
 */
export function setFetchTransport(next: FetchLike | null, options: { providesAuth?: boolean } = {}): void {
  transport = next ?? nativeFetch
  transportAuth = Boolean(next && options.providesAuth)
}

export function currentTransport(): FetchLike {
  return transport
}

/** True when the installed transport supplies hub credentials on its own. */
export function transportProvidesAuth(): boolean {
  return transportAuth
}

export function fetchWithTransport(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return transport(input, init)
}
