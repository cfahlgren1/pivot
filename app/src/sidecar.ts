// Talks to the Python hardware sidecar through the Tauri shell (see src-tauri/src/lib.rs).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void };
type Handler = (data: any) => void;

const pending = new Map<number, Pending>();
const handlers = new Map<string, Set<Handler>>();
let nextId = 0;

export function on(event: string, handler: Handler): () => void {
  if (!handlers.has(event)) handlers.set(event, new Set());
  handlers.get(event)!.add(handler);
  return () => handlers.get(event)!.delete(handler);
}

export async function call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const id = ++nextId;
  const result = new Promise<T>((resolve, reject) => pending.set(id, { resolve, reject }));
  await invoke("sidecar_send", { line: JSON.stringify({ id, method, params }) });
  return result;
}

/** Sends a request that gets no reply. Used for 60 Hz controller input. */
export function notify(method: string, params: Record<string, unknown> = {}): void {
  void invoke("sidecar_send", { line: JSON.stringify({ method, params }) });
}

/** Resolves once no requests are waiting on the sidecar, so a screen can be left without a reply landing on the next one. */
export async function settled(): Promise<void> {
  while (pending.size) await new Promise((resolve) => setTimeout(resolve, 50));
}

await listen<string>("sidecar", ({ payload }) => {
  const message = JSON.parse(payload);
  if (message.event) {
    handlers.get(message.event)?.forEach((handler) => handler(message.data));
    return;
  }
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result);
});
