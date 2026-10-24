declare module 'express' {
  import type { Server } from 'node:http';
  import type { Socket } from 'node:net';

  export interface Request {
    body: unknown;
    params: Record<string, string>;
    query: Record<string, unknown>;
  }

  export interface Response {
    socket: Socket | null;
    setHeader(name: string, value: number | string | readonly string[]): this;
    status(code: number): this;
    json(body: unknown): this;
    send(body: string): this;
  }

  export type NextFunction = (error?: unknown) => void;
  export type Handler = (req: Request, res: Response, next: NextFunction) => unknown;

  export interface Application {
    use(handler: Handler): this;
    post(path: string, handler: Handler): this;
    get(path: string, handler: Handler): this;
    listen(port: number, hostname: string, callback?: () => void): Server;
  }

  interface ExpressFactory {
    (): Application;
    json(): Handler;
  }

  const express: ExpressFactory;
  export default express;
}
