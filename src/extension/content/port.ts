import type { RpcMethod, RpcMethods, ToBackground, ToContent } from '../messages';
import { PORT_NAME } from '../messages';

export class RpcError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

/**
 * Long-lived connection to the background worker. Reconnects when the worker
 * restarts; reports `onInvalidated` when the extension itself was reloaded or
 * removed (this content script is then orphaned and must clean up).
 */
export class BackgroundPort {
  private port: chrome.runtime.Port | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private hello: ToBackground | null = null;
  private retry = 250;
  private closed = false;

  constructor(
    private onMessage: (msg: ToContent) => void,
    private onInvalidated: () => void,
  ) {}

  static contextValid(): boolean {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  connect() {
    if (this.closed) return;
    if (!BackgroundPort.contextValid()) return this.invalidate();
    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connect({ name: PORT_NAME });
    } catch {
      return this.invalidate();
    }
    this.port = port;
    port.onMessage.addListener((msg: ToContent) => {
      this.retry = 250;
      if (msg.t === 'rpc-result') {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new RpcError(msg.error, msg.code));
        return;
      }
      this.onMessage(msg);
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      this.port = null;
      for (const p of this.pending.values()) p.reject(new RpcError('Connection to the extension was interrupted. Try again.'));
      this.pending.clear();
      if (!BackgroundPort.contextValid()) return this.invalidate();
      // The worker restarted: reconnect and re-introduce this page.
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(5000, this.retry * 2);
    });
    if (this.hello) this.send(this.hello);
  }

  private invalidate() {
    if (this.closed) return;
    this.closed = true;
    this.onInvalidated();
  }

  close() {
    this.closed = true;
    try {
      this.port?.disconnect();
    } catch {
      // ignore
    }
  }

  private send(msg: ToBackground) {
    try {
      this.port?.postMessage(msg);
    } catch {
      // disconnect handler deals with it
    }
  }

  setHello(pageKeys: string[], url: string) {
    this.hello = { t: 'hello', pageKeys, url };
    this.send(this.hello);
  }

  /**
   * Call the background. While the worker is restarting, the call waits (up
   * to 8s) for the reconnect instead of failing.
   */
  async call<M extends RpcMethod>(method: M, params: RpcMethods[M]['params']): Promise<RpcMethods[M]['result']> {
    const deadline = Date.now() + 8000;
    while (!this.port) {
      if (this.closed) throw new RpcError('The extension was updated. Reload the page to keep commenting.', 'invalidated');
      if (Date.now() > deadline) throw new RpcError('Not connected to the extension. Try again.');
      await new Promise(r => setTimeout(r, 100));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.send({ t: 'rpc', id, method, params });
    });
  }
}
