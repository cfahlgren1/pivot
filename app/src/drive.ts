// Step 6: choose the handle arm or a game controller, then drive the claw arm with it.
import { MIDDLE, poseFromJoints } from "./arm3d";
import { ARM_IDS, type Driver, state, view } from "./context";
import { driveInput, onPad, type Pad, pad, padLabel } from "./gamepad";
import { go, onLeave } from "./nav";
import { call, notify, on } from "./sidecar";
import { button, click, failure, screen } from "./ui";

export type TeleopStatus = {
  state: string;
  hz?: number;
  target?: Record<string, number>;
  holding?: boolean;
  recording_seconds?: number;
  message?: string;
};

const SPEEDS = ["slow", "normal", "fast"] as const;

/** Starts driving the claw arm with the chosen driver until the screen is left. */
export function startDriving(onStatus: (status: TeleopStatus) => void): void {
  onLeave(on("teleop", onStatus));
  if (state.driver === "gamepad") {
    onLeave(onPad((p) => notify("teleop_input", { state: driveInput(p) })));
  }
  onLeave(() => void call("teleop_stop", { relax: false }));
  call("teleop_start", {
    follower: { port: state.follower, arm_id: ARM_IDS.follower },
    leader: state.driver === "leader" ? { port: state.leader, arm_id: ARM_IDS.leader } : null,
    driver: state.driver,
    speed: state.speed,
  }).catch((error) => onStatus({ state: "error", message: String(error) }));
}

// ── drawings ────────────────────────────────────────────────────────────────
type PadPart = "lb" | "ls" | "rs" | "lt" | "rt";

export function padSvg(lit: PadPart[] = [], width = 120): string {
  const on = (part: PadPart) => lit.includes(part);
  const fill = (part: PadPart, idle: string) => (on(part) ? "#0071e3" : idle);
  return `<svg viewBox="0 0 360 250" width="${width}" aria-hidden="true">
    <rect x="62" y="22" width="62" height="34" rx="12" fill="${fill("lt", "#d9d9d6")}"/>
    <rect x="236" y="22" width="62" height="34" rx="12" fill="${fill("rt", "#d9d9d6")}"/>
    <rect x="56" y="46" width="84" height="20" rx="10" fill="${fill("lb", "#c4c4c1")}"/>
    <rect x="220" y="46" width="84" height="20" rx="10" fill="#c4c4c1"/>
    <path d="M70 62 C 110 48, 250 48, 290 62 C 335 78, 352 160, 340 205 C 330 240, 290 238, 268 210 C 252 190, 238 178, 210 178 L150 178 C 122 178, 108 190, 92 210 C 70 238, 30 240, 20 205 C 8 160, 25 78, 70 62 Z" fill="#f2f2f0" stroke="rgba(0,0,0,.16)" stroke-width="2"/>
    <circle cx="104" cy="104" r="24" fill="${fill("ls", "#d3d3d0")}"/><circle cx="104" cy="104" r="15" fill="#2c2c2e"/>
    <circle cx="222" cy="150" r="24" fill="${fill("rs", "#d3d3d0")}"/><circle cx="222" cy="150" r="15" fill="#2c2c2e"/>
    <path d="M132 140 h12 v-12 h12 v12 h12 v12 h-12 v12 h-12 v-12 h-12 Z" fill="#3a3a3c"/>
    <circle cx="258" cy="82" r="11" fill="#e8a917"/><circle cx="236" cy="104" r="11" fill="#1f6fd6"/>
    <circle cx="280" cy="104" r="11" fill="#e5352b"/><circle cx="258" cy="126" r="11" fill="#2fb344"/>
  </svg>`;
}

function handleArmSvg(width = 120): string {
  return `<svg viewBox="0 0 120 84" width="${width}" aria-hidden="true" fill="none" stroke-linecap="round">
    <path d="M24 76 h52" stroke="#1d1d1f" stroke-width="6"/>
    <path d="M50 74 L42 38 L84 22" stroke="#1d1d1f" stroke-width="7" stroke-linejoin="round"/>
    <circle cx="42" cy="38" r="6" fill="#fff" stroke="#1d1d1f" stroke-width="3"/>
    <path d="M84 22 l14 18" stroke="#0071e3" stroke-width="7"/>
  </svg>`;
}

function litParts(p: Pad): PadPart[] {
  const parts: PadPart[] = [];
  if (p.buttons?.lb) parts.push("lb");
  if (Math.hypot(p.left_x ?? 0, p.left_y ?? 0) > 0.2) parts.push("ls");
  if (Math.hypot(p.right_x ?? 0, p.right_y ?? 0) > 0.2) parts.push("rs");
  if ((p.left_trigger ?? 0) > 0.1) parts.push("lt");
  if ((p.right_trigger ?? 0) > 0.1) parts.push("rt");
  return parts;
}

export function padMapping(p: Pad): string {
  return `<div class="mapping">${padSvg(litParts(p), 150)}
    <ul>
      <li><span class="key">LB</span> Hold to move</li>
      <li><b>Left stick</b> base, upper arm</li>
      <li><b>Right stick</b> elbow, wrist</li>
      <li><span class="key">RT</span> <span class="key">LT</span> close, open claw</li>
      <li><span class="key">◀ ▶</span> roll wrist</li>
    </ul></div>`;
}

export function speedPicker(): string {
  return `<div class="seg" role="group" aria-label="Speed">${SPEEDS.map(
    (s) =>
      `<button id="speed-${s}" class="${s === state.speed ? "on" : ""}">${s[0].toUpperCase()}${s.slice(1)}</button>`,
  ).join("")}</div>`;
}

export function bindSpeedPicker(rerender: () => void): void {
  for (const speed of SPEEDS) {
    click(`speed-${speed}`, () => {
      state.speed = speed;
      void call("teleop_speed", { speed });
      rerender();
    });
  }
}

export const STATUS_LABELS: Record<string, string> = {
  starting: "Connecting…",
  easing_in: "Easing in…",
  running: "Following",
  retrying: "Retrying a missed read…",
  reconnecting: "Reconnecting…",
};

// ── 6. Drive ────────────────────────────────────────────────────────────────
export async function drive(): Promise<void> {
  view.setKind("follower");
  view.setPose(MIDDLE);

  const choose = () => {
    let choice: Driver = state.driver;
    let shown = "";
    const render = () => {
      const p = pad();
      const controllerStatus = p.connected
        ? `<span class="dot live"></span>${padLabel(p)}`
        : `<span class="dot"></span>Connect one over Bluetooth or USB`;
      screen({
        eyebrow: "Step 6",
        title: "How do you want to drive it?",
        lede: "Both record the same kind of data, so anything you record trains the same way.",
        body: `<div class="choices">
          <button class="choice ${choice === "leader" ? "on" : ""}" id="pick-leader">
            <span class="art">${handleArmSvg(84)}</span>
            <span><b>Handle arm</b><span>The claw arm copies it. The most natural motion, and the best data.</span>
            <small><span class="dot ok"></span>Calibrated</small></span></button>
          <button class="choice ${choice === "gamepad" ? "on" : ""}" id="pick-gamepad">
            <span class="art">${padSvg([], 84)}</span>
            <span><b>Game controller</b><span>Steer with the sticks, squeeze the triggers to grab. Only needs the claw arm.</span>
            <small>${controllerStatus}</small></span></button></div>`,
        actions: button(
          "next",
          choice === "gamepad" ? "Continue with controller" : "Continue with handle arm",
          "primary",
        ),
      });
      (document.getElementById("next") as HTMLButtonElement).disabled = choice === "gamepad" && !p.connected;
      click("pick-leader", () => ((choice = "leader"), render()));
      click("pick-gamepad", () => ((choice = "gamepad"), render()));
      click("next", () => {
        state.driver = choice;
        if (choice === "leader") lineUp();
        else driving();
      });
      shown = `${p.connected}|${padLabel(p)}`;
    };
    render();
    // Only redraw when the controller connects, disconnects or changes, not on every reading.
    onLeave(onPad((p) => `${p.connected}|${padLabel(p)}` !== shown && render()));
  };

  const lineUp = () => {
    screen({
      eyebrow: "Step 6",
      title: "Line them up.",
      lede: "Put both arms in roughly the same pose. When you start, the claw arm eases into place over a second, then follows the handle arm.",
      actions: button("start", "Start driving", "primary") + button("change", "Use a controller instead"),
    });
    click("start", driving);
    click("change", choose);
  };

  const driving = () => {
    let status: TeleopStatus = { state: "starting" };
    const render = () => {
      const gamepad = state.driver === "gamepad";
      const hud = `<div class="hud"><div><b>${status.hz ? status.hz.toFixed(0) : "–"} Hz</b><small>Update rate</small></div>
        <div><b>${STATUS_LABELS[status.state] ?? status.state}</b><small>Status</small></div></div>`;
      screen({
        eyebrow: gamepad ? "Step 6 · Controller" : "Step 6 · Handle arm",
        title: gamepad ? (status.holding ? "Driving." : "Hold LB and drive.") : "Move the handle arm.",
        lede: gamepad
          ? "Let go of LB and the arm freezes where it is."
          : "The claw arm follows. Squeeze the trigger to close the claw.",
        body: gamepad ? `${padMapping(pad())}<div class="row">${speedPicker()}</div>` : hud,
        actions: button("record", "Record demos", "primary") + button("stop", "Stop"),
      });
      if (gamepad) bindSpeedPicker(render);
      click("record", () => go("record"));
      click("stop", confirmStop);
    };
    const timer = setInterval(render, 300);
    startDriving((data) => {
      if (data.target) view.setPose(poseFromJoints(data.target));
      if (data.state === "error") {
        clearInterval(timer);
        screen({
          eyebrow: "Step 6",
          title: "Driving stopped.",
          body: failure(data.message),
          actions: button("again", "Start again", "primary"),
        });
        click("again", () => go("drive"));
        return;
      }
      if (data.state !== "stopped") status = { ...status, ...data };
    });
    onLeave(() => clearInterval(timer));
    render();

    function confirmStop() {
      clearInterval(timer);
      screen({
        eyebrow: "Step 6",
        title: "Hold the claw arm.",
        lede: "If its motors relax, it will drop. Keep a hand under the forearm, or keep it stiff where it is.",
        actions: button("stiff", "Stop, keep it stiff") + button("relax", "Stop and relax", "primary"),
      });
      click("stiff", () => finish(false));
      click("relax", () => finish(true));
    }

    async function finish(relax: boolean) {
      await call("teleop_stop", { relax });
      screen({
        eyebrow: "Done",
        title: "Your arms are set up.",
        lede: "Record demonstrations whenever you’re ready. LeRobot’s own tools use the same calibration.",
        actions: button("record", "Record demos", "primary") + button("again", "Drive again"),
      });
      click("record", () => go("record"));
      click("again", () => go("drive"));
    }
  };

  choose();
}
