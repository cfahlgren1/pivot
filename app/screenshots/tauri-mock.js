// Stands in for the Tauri shell in a plain browser: sidecar_send posts to bridge.py, sidecar lines
// come back over server-sent events as `sidecar` events, and a simulated controller sends `gamepad`
// events. Set `window.__pad` to change what the controller reports.
(() => {
  const BRIDGE = "http://127.0.0.1:1430";
  const callbacks = new Map();
  const listeners = new Map(); // event name -> handler ids
  const pending = [];
  let nextId = 1;

  const emit = (event, payload) => {
    const ids = listeners.get(event) ?? [];
    if (event === "sidecar" && !ids.length) return pending.push(payload);
    for (const id of ids) callbacks.get(id)?.({ event, id: 0, payload });
  };

  new EventSource(`${BRIDGE}/events`).onmessage = ({ data }) => emit("sidecar", data);

  window.__pad = {
    connected: true,
    name: "Xbox Wireless Controller",
    battery: 82,
    left_x: 0,
    left_y: 0,
    right_x: 0,
    right_y: 0,
    left_trigger: 0,
    right_trigger: 0,
    buttons: {},
  };
  setInterval(() => emit("gamepad", structuredClone(window.__pad)), 16);

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
        if (!listeners.has(args.event)) listeners.set(args.event, []);
        listeners.get(args.event).push(args.handler);
        if (args.event === "sidecar") for (const data of pending.splice(0)) emit("sidecar", data);
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
