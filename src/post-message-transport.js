/**
 * PostMessageTransport - MCP over postMessage
 *
 * Carries MCP's JSON-RPC messages between a page and a Web Worker (or any two
 * ends of a MessageChannel) instead of over HTTP. The same class serves both
 * sides: the page wraps the Worker, and the worker wraps its own global scope.
 *
 *   // page
 *   const worker = new Worker('server.js', { type: 'module' });
 *   const mcp = new MCPClient('worker:duckdb', {}, {
 *       transport: () => new PostMessageTransport(worker),
 *   });
 *
 *   // server.js, in the worker
 *   await server.connect(new PostMessageTransport(self));
 *
 * A browser has no ports to listen on, so this is how an MCP server runs inside
 * the page: the worker is its sandbox and postMessage is its only interface.
 *
 * Implements the MCP SDK's Transport interface (start, send, close, onmessage,
 * onerror, onclose). Messages that arrive before start() — a worker still
 * loading while the page sends `initialize` — are queued, not dropped.
 */

export class PostMessageTransport {
    /**
     * @param {Worker|MessagePort|DedicatedWorkerGlobalScope} port - anything
     *   with postMessage and addEventListener('message')
     */
    constructor(port) {
        this.port = port;
        this._queue = [];
        this._started = false;
        this._closed = false;
        this._onMessage = (event) => {
            if (this._closed) return;
            if (!this._started) this._queue.push(event.data);
            else this.onmessage?.(event.data);
        };
        this._onError = (event) => {
            this.onerror?.(event.error ?? new Error(event.message ?? 'postMessage transport error'));
        };
        // Listen from construction so nothing sent before start() is lost.
        port.addEventListener('message', this._onMessage);
        port.addEventListener('messageerror', this._onError);
        port.start?.(); // a MessagePort delivers nothing until started
    }

    async start() {
        if (this._started) throw new Error('PostMessageTransport already started');
        this._started = true;
        while (this._queue.length > 0 && !this._closed) this.onmessage?.(this._queue.shift());
    }

    async send(message) {
        if (this._closed) throw new Error('Not connected');
        this.port.postMessage(message);
    }

    async close() {
        if (this._closed) return;
        this._closed = true;
        this._queue = [];
        this.port.removeEventListener('message', this._onMessage);
        this.port.removeEventListener('messageerror', this._onError);
        this.onclose?.();
    }
}
