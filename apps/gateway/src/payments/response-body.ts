// Bound retained bytes even for a fast or endless stream. The request's abort signal
// remains responsible for stalled streams. Never buffer a chunk that crosses the cap.
export async function readCappedBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        // Cancellation of a hostile source must not delay returning UNKNOWN.
        void reader.cancel().catch(() => undefined);
        throw new Error(`paid response body exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, size).toString('utf8');
  } finally {
    reader.releaseLock();
  }
}
