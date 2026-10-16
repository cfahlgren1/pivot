// Step navigation: the progress bar, Back (and ⌘[), and tearing down each screen when it's left.
import { view } from "./context";
import { settled } from "./sidecar";

export const STEPS = [
  "welcome",
  "connect",
  "power",
  "identify",
  "follower",
  "leader",
  "drive",
  "record",
  "recordings",
] as const;
export type Step = (typeof STEPS)[number];
type Route = () => void | Promise<void>;

const progress = document.getElementById("progress")!;
const backButton = document.getElementById("back") as HTMLButtonElement;

let routes: Record<Step, Route>;
let current: Step = "welcome";

export function setRoutes(all: Record<Step, Route>): void {
  routes = all;
}

// Everything a screen sets up (event listeners, timers, hardware jobs) is torn down when the next one shows.
let cleanups: (() => void)[] = [];
export function onLeave(fn: () => void): void {
  cleanups.push(fn);
}

export function go(step: Step): void {
  cleanups.forEach((fn) => fn());
  cleanups = [];
  current = step;
  const index = STEPS.indexOf(step);
  progress.innerHTML = STEPS.map(
    (_, i) => `<i class="${i < index ? "done" : i === index ? "now" : ""}"></i>`,
  ).join("");
  backButton.hidden = index === 0;
  view.setGhost(null);
  void routes[step]();
}

// Waits for in-flight requests first, so a reply can't land on the previous step's screen.
export async function back(): Promise<void> {
  const index = STEPS.indexOf(current);
  if (index === 0 || backButton.disabled) return;
  backButton.disabled = true;
  await settled();
  backButton.disabled = false;
  go(STEPS[index - 1]);
}

backButton.addEventListener("click", () => void back());
document.addEventListener("keydown", (event) => {
  if (event.metaKey && event.key === "[") void back();
});
