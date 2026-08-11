import type { IncomingMessage, ServerResponse } from 'node:http';

export const SESSION_OPERATION_PROXY_BODY_MAX_BYTES = 64 * 1024;

export class SessionOperationProxyBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`session operation body exceeds ${maxBytes} bytes`);
    this.name = 'SessionOperationProxyBodyTooLargeError';
  }
}

/** Write a JSON HTTP response without coupling callers to a feature module. */
export function jsonRes(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Preserve a browser session-mutation body while adding only the headers the
 * owner daemon needs to interpret its operation identity. Empty requests stay
 * bodyless for compatibility with existing CLI/direct recovery callers. */
export async function sessionOperationProxyInit(
  req: IncomingMessage,
  forwardBody: boolean,
  method: 'POST' | 'PUT' = 'POST',
): Promise<RequestInit> {
  const headers = new Headers();
  const operationId = req.headers['x-botmux-operation-id'];
  if (typeof operationId === 'string') headers.set('x-botmux-operation-id', operationId);
  const hasOperationId = typeof operationId === 'string';

  if (!forwardBody) return {
    method,
    ...(hasOperationId ? { headers } : {}),
  };

  const declared = req.headers['content-length'];
  if (typeof declared === 'string'
      && /^\d+$/.test(declared)
      && Number(declared) > SESSION_OPERATION_PROXY_BODY_MAX_BYTES) {
    req.once('error', () => {});
    req.resume();
    throw new SessionOperationProxyBodyTooLargeError(
      SESSION_OPERATION_PROXY_BODY_MAX_BYTES,
    );
  }
  const chunks = await new Promise<Buffer[]>((resolve, reject) => {
    const buffered: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const rejectOnce = (error: Error, drain = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (drain) {
        req.once('error', () => {});
        req.resume();
      }
      reject(error);
    };
    const onData = (raw: Buffer | string) => {
      if (settled) return;
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      totalBytes += chunk.byteLength;
      if (totalBytes > SESSION_OPERATION_PROXY_BODY_MAX_BYTES) {
        buffered.length = 0;
        rejectOnce(new SessionOperationProxyBodyTooLargeError(
          SESSION_OPERATION_PROXY_BODY_MAX_BYTES,
        ), true);
        return;
      }
      buffered.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(buffered);
    };
    const onError = (error: Error) => rejectOnce(error);
    const onAborted = () => rejectOnce(new Error('request aborted'));
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
  });
  if (chunks.length === 0) return {
    method,
    ...(hasOperationId ? { headers } : {}),
  };

  const contentType = req.headers['content-type'];
  if (typeof contentType === 'string') headers.set('content-type', contentType);
  return {
    method,
    headers,
    body: Buffer.concat(chunks).toString('utf8'),
  };
}
