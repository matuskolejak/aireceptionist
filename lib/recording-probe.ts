/**
 * Ask the recording proxy whether there are bytes to play, and resolve its
 * status code.
 *
 * `api.recordingSource` never touches the network - it only builds a URI and a
 * header - and expo-audio has no error channel at all: a load that fails leaves
 * the player unloaded with no event, forever. So the one place a 404 (the audio
 * has aged out of ElevenLabs), a 409 (the call is still running) or a 503 (no
 * upstream key) can be observed is a request made here, before the URI is
 * handed to the player.
 *
 * XMLHttpRequest rather than fetch because React Native's fetch is XHR-backed
 * and does not stream: its promise settles only once the whole body has
 * arrived, so a `Range` the upstream chose to ignore would pull an entire
 * multi-megabyte call down a cellular connection just to read a status line.
 * Aborting at HEADERS_RECEIVED costs one round trip and no body.
 *
 * The order inside `finish` is the whole fix. React Native's `abort()` resets
 * `status` to 0 and then SYNCHRONOUSLY dispatches readystatechange with DONE.
 * Aborting before settling re-entered the handler, which settled with that 0
 * first - so every probe resolved 0 and every recording read "could not be
 * loaded", including the 404/409 cases that have their own message. The
 * handlers are detached and the real status settled before `abort()` runs.
 *
 * Pure and injectable (`createXhr`) so it can be exercised without a device.
 */

/** The part of XMLHttpRequest the probe touches. */
export interface ProbeXhr {
  readonly readyState: number;
  readonly status: number;
  timeout: number;
  onreadystatechange: ((...args: never[]) => unknown) | null;
  onerror: ((...args: never[]) => unknown) | null;
  ontimeout: ((...args: never[]) => unknown) | null;
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(): void;
  abort(): void;
}

export interface RecordingProbe {
  /** The proxy's status code; 0 means no answer (offline, timed out, cancelled). */
  status: Promise<number>;
  cancel: () => void;
}

/** XMLHttpRequest.HEADERS_RECEIVED / DONE, as numbers so a fake needs no constants. */
const HEADERS_RECEIVED = 2;
const DONE = 4;

/** How long the probe waits for a status line before calling it no answer. */
export const PROBE_TIMEOUT_MS = 15_000;

export function probeRecording(
  uri: string,
  headers: Record<string, string>,
  {
    timeoutMs = PROBE_TIMEOUT_MS,
    createXhr = () => new XMLHttpRequest() as unknown as ProbeXhr,
  }: { timeoutMs?: number; createXhr?: () => ProbeXhr } = {},
): RecordingProbe {
  const xhr = createXhr();
  let settle: (code: number) => void = () => {};
  const status = new Promise<number>((resolve) => {
    let done = false;
    settle = (code: number) => {
      if (done) return;
      done = true;
      resolve(code);
    };
  });

  /** Detach first, settle second, abort last - see the note at the top. */
  const finish = (code: number, abort: boolean) => {
    xhr.onreadystatechange = null;
    xhr.onerror = null;
    xhr.ontimeout = null;
    settle(code);
    if (abort) xhr.abort();
  };

  xhr.onreadystatechange = () => {
    if (xhr.readyState === HEADERS_RECEIVED) finish(xhr.status, true);
    else if (xhr.readyState === DONE) finish(xhr.status, false);
  };
  // 0 is not a status the proxy can return, so it reads as "no answer".
  xhr.onerror = () => finish(0, false);
  xhr.ontimeout = () => finish(0, false);
  xhr.timeout = timeoutMs;
  xhr.open('GET', uri);
  for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
  // The route forwards Range upstream, so when it is honoured this is one byte.
  xhr.setRequestHeader('Range', 'bytes=0-0');
  xhr.send();

  return {
    status,
    cancel: () => finish(0, true),
  };
}
