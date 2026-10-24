// Reads a response body up to a byte limit. Once the limit is passed it stops reading and cancels the
// stream, so a remote server can't make the gateway buffer an unbounded body.
// Returns null when the body is too large; network errors and aborts (e.g. a timeout) are thrown.
export async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
