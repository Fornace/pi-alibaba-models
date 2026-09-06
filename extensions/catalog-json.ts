import { gunzipSync } from "node:zlib";

export const CATALOG_INPUT_LIMIT = 1024 * 1024;
export const CATALOG_OUTPUT_LIMIT = 4 * 1024 * 1024;

// Some catalog responses contain gzip bytes without Content-Encoding. Fetch
// cannot decode those automatically. Sniff only the fixed gzip signature;
// already-decoded JSON must not be decompressed again based on stale headers.
export async function readCatalogJSON<T>(response: Response, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  if (!response.body) throw new Error("Catalog response has no body");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > CATALOG_INPUT_LIMIT) throw new Error("Catalog response exceeds input limit");
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const received = Buffer.concat(chunks, total);
  const gzip = received[0] === 0x1f && received[1] === 0x8b && received[2] === 0x08;
  const decoded = gzip ? gunzipSync(received, { maxOutputLength: CATALOG_OUTPUT_LIMIT }) : received;
  signal.throwIfAborted();
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded)) as T;
  } catch (cause) {
    throw new Error("Catalog response is not valid UTF-8 JSON", { cause });
  }
}
