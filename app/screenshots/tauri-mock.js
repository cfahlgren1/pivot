// Stands in for the Tauri shell in a plain browser: sidecar_send posts to bridge.py, and
// sidecar lines come back over server-sent events as `sidecar` events.
(() => {
  const BRIDGE = "http://127.0.0.1:1430";
  const callbacks = new Map();
  const listeners = [];
  let nextId = 1;
  const pending = [];

  new EventSource(`${BRIDGE}/events`).onmessage = ({ data }) => {
    if (!listeners.length) return pending.push(data);
    for (const id of listeners) callbacks.get(id)?.({ event: "sidecar", id: 0, payload: data });
  };

  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback(callback) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    async invoke(cmd, args) {
      if (cmd === "plugin:event|listen") {
        listeners.push(args.handler);
        for (const data of pending.splice(0))
          callbacks.get(args.handler)({ event: "sidecar", id: 0, payload: data });
        return args.handler;
      }
      if (cmd === "plugin:event|unlisten") return;
      if (cmd === "sidecar_send") {
        await fetch(`${BRIDGE}/send`, { method: "POST", body: args.line });
        return;
      }
      throw new Error(`tauri-mock: unhandled command ${cmd}`);
    },
  };
})();
