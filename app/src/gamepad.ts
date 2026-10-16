// The game controller, read natively by the Tauri shell (`start_gamepad` in src-tauri/src/lib.rs).
import { listen } from "@tauri-apps/api/event";

export type PadButton = "a" | "b" | "x" | "y" | "lb" | "rb" | "left" | "right" | "menu";
export type Pad = {
  connected: boolean;
  name?: string;
  battery?: number | null;
  left_x?: number;
  left_y?: number;
  right_x?: number;
  right_y?: number;
  left_trigger?: number;
  right_trigger?: number;
  buttons?: Partial<Record<PadButton, boolean>>;
};

let latest: Pad = { connected: false };
const padListeners = new Set<(pad: Pad) => void>();
const pressListeners = new Map<PadButton, Set<() => void>>();

export function pad(): Pad {
  return latest;
}

/** Called with every controller reading (~60 Hz while one is connected). Returns an unsubscribe function. */
export function onPad(listener: (pad: Pad) => void): () => void {
  padListeners.add(listener);
  return () => padListeners.delete(listener);
}

/** Called once each time `button` goes down. Returns an unsubscribe function. */
export function onPress(button: PadButton, listener: () => void): () => void {
  if (!pressListeners.has(button)) pressListeners.set(button, new Set());
  pressListeners.get(button)!.add(listener);
  return () => pressListeners.get(button)!.delete(listener);
}

export function padLabel(p: Pad): string {
  const name = p.name || "Controller";
  return p.battery == null ? name : `${name} · ${p.battery}%`;
}

/** The sidecar's GamepadInput fields (see sidecar/src/pivot_sidecar/drive.py). */
export function driveInput(p: Pad): Record<string, number | boolean> {
  return {
    left_x: p.left_x ?? 0,
    left_y: p.left_y ?? 0,
    right_x: p.right_x ?? 0,
    right_y: p.right_y ?? 0,
    left_trigger: p.left_trigger ?? 0,
    right_trigger: p.right_trigger ?? 0,
    hold: !!p.buttons?.lb,
    roll_left: !!p.buttons?.left,
    roll_right: !!p.buttons?.right,
  };
}

await listen<Pad>("gamepad", ({ payload }) => {
  const previous = latest;
  latest = payload;
  for (const [button, listeners] of pressListeners) {
    if (payload.buttons?.[button] && !previous.buttons?.[button]) listeners.forEach((fn) => fn());
  }
  padListeners.forEach((fn) => fn(payload));
});
