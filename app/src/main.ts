// Pivot's setup flow: one instruction and one button per screen, from unboxing to teleoperation.
import "./style.css";
import { ArmView, MIDDLE, poseFromJoints, poseFromRaw } from "./arm3d";
import { call, on } from "./sidecar";

type Role = "follower" | "leader";
type Board = { port: string; description: string };
type Diagnosis = { status: string; title: string; detail: string };
type Probe = {
  port: string;
  motors: Record<string, number>;
  voltages: Record<string, number>;
  diagnosis: Diagnosis;
};
type JointSnapshot = { min: number | null; max: number | null; position: number | null; coverage: number };
type Ranges = { joints: Record<string, JointSnapshot>; ready: boolean; least_covered: string };

const STEPS = ["welcome", "connect", "power", "identify", "follower", "leader", "try"] as const;
type Step = (typeof STEPS)[number];

// Same IDs as LeRobot's docs, so `lerobot-record` picks up the calibration Pivot saves.
const ARM_IDS: Record<Role, string> = { follower: "my_follower", leader: "my_leader" };
const ARM_NAMES: Record<Role, string> = { follower: "claw arm", leader: "handle arm" };

const state = {
  ports: [] as string[],
  follower: "",
  leader: "",
};

const panel = document.getElementById("panel")!;
const progress = document.getElementById("progress")!;
const view = new ArmView(document.getElementById("arm") as HTMLCanvasElement);

// Everything a screen sets up (event listeners, timers) is torn down when the next one shows.
let cleanups: (() => void)[] = [];
function onLeave(fn: () => void): void {
  cleanups.push(fn);
}

function go(step: Step, render: () => void | Promise<void>): void {
  cleanups.forEach((fn) => fn());
  cleanups = [];
  const index = STEPS.indexOf(step);
  progress.innerHTML = STEPS.map(
    (_, i) => `<i class="${i < index ? "done" : i === index ? "now" : ""}"></i>`,
  ).join("");
  view.setGhost(null);
  void render();
}

type Screen = { eyebrow?: string; title: string; lede?: string; body?: string; actions?: string };
let shownTitle = "";
function screen(s: Screen): void {
  panel.innerHTML = `
    ${s.eyebrow ? `<p class="eyebrow">${s.eyebrow}</p>` : ""}
    <h1>${s.title}</h1>
    ${s.lede ? `<p class="lede">${s.lede}</p>` : ""}
    ${s.body ?? ""}
    ${s.actions ? `<div class="actions">${s.actions}</div>` : ""}`;
  // Live screens redraw several times a second; only slide in when the screen itself changes.
  const title = `${s.eyebrow}|${s.title}`;
  if (title === shownTitle) return;
  shownTitle = title;
  panel.classList.remove("enter");
  void panel.offsetWidth;
  panel.classList.add("enter");
}

function button(id: string, label: string, kind = ""): string {
  return `<button class="btn ${kind}" id="${id}">${label}</button>`;
}

function click(id: string, handler: () => void): void {
  document.getElementById(id)?.addEventListener("click", handler);
}

function shortPort(port: string): string {
  return port.replace("/dev/tty.", "");
}

function failure(error: unknown): string {
  return `<div class="issue"><b>Something went wrong</b>${error instanceof Error ? error.message : String(error)}</div>`;
}

// ── 1. Welcome ──────────────────────────────────────────────────────────────
async function welcome(): Promise<void> {
  view.setKind("follower");
  let t = 0;
  const idle = setInterval(() => {
    t += 0.05;
    view.setPose({
      pan: 18 * Math.sin(t * 0.6),
      elbow: 10 * Math.sin(t * 0.8),
      wrist: 14 * Math.sin(t),
      claw: 0.5,
    });
  }, 50);
  onLeave(() => clearInterval(idle));

  screen({
    eyebrow: "SO-101 setup",
    title: "Let’s get your arms moving.",
    lede: "Pivot walks you through setup one step at a time, from plugging in to controlling the claw arm with the handle arm. It takes about ten minutes.",
    actions: button("start", "Get started", "primary"),
  });
  click("start", () => go("connect", connect));
}

// ── 2. Plug in both boards ──────────────────────────────────────────────────
async function connect(): Promise<void> {
  view.setPose(MIDDLE);
  const refresh = async () => {
    const { boards } = await call<{ boards: Board[] }>("list_boards");
    state.ports = boards.map((b) => b.port);
    const rows = boards.length
      ? boards
          .map(
            (b) =>
              `<li><span class="dot ok"></span><span>${b.description}<span class="sub">${shortPort(b.port)}</span></span></li>`,
          )
          .join("")
      : `<li><span class="dot"></span><span>Waiting for a board…</span></li>`;
    screen({
      eyebrow: "Step 1",
      title: "Plug in both arms.",
      lede: "Connect each arm’s controller board to this Mac with USB, and plug in each board’s power supply.",
      body: `<ul class="list">${rows}</ul>`,
      actions:
        button("next", "Continue", "primary") +
        `<span class="note">${boards.length === 2 ? "Both boards found." : `Found ${boards.length} of 2.`}</span>`,
    });
    (document.getElementById("next") as HTMLButtonElement).disabled = boards.length !== 2;
    click("next", () => go("power", power));
  };
  await refresh();
  const timer = setInterval(refresh, 1500);
  onLeave(() => clearInterval(timer));
}

// ── 3. Power and motor check ────────────────────────────────────────────────
async function power(): Promise<void> {
  screen({ eyebrow: "Step 2", title: "Checking the motors…", lede: "Pinging each motor on both boards." });
  let probes: Probe[];
  try {
    probes = [];
    for (const port of state.ports) probes.push(await call<Probe>("probe", { port }));
  } catch (error) {
    screen({
      eyebrow: "Step 2",
      title: "Couldn’t check the motors.",
      body: failure(error),
      actions: button("retry", "Try again", "primary"),
    });
    click("retry", () => go("power", power));
    return;
  }

  const allReady = probes.every((p) => p.diagnosis.status === "ready");
  const rows = probes
    .map((p) => {
      const volts = Object.values(p.voltages);
      const voltage = volts.length ? `${Math.min(...volts).toFixed(1)} V` : "—";
      const ok = p.diagnosis.status === "ready";
      return `<li><span class="dot ${ok ? "ok" : "bad"}"></span>
        <span>${ok ? `${Object.keys(p.motors).length} motors ready` : p.diagnosis.title}<span class="sub">${shortPort(p.port)}</span></span>
        <span class="end">${voltage}</span></li>`;
    })
    .join("");
  const issues = probes
    .filter((p) => p.diagnosis.status !== "ready")
    .map((p) => {
      const extra =
        p.diagnosis.status === "ids_not_set"
          ? " Pivot can’t set motor IDs yet; for now run <code>lerobot-setup-motors</code> for this arm."
          : "";
      return `<div class="issue"><b>${shortPort(p.port)}: ${p.diagnosis.title}</b>${p.diagnosis.detail}${extra}</div>`;
    })
    .join("");

  screen({
    eyebrow: "Step 2",
    title: allReady ? "Both arms have power." : "One thing to fix.",
    lede: allReady
      ? "All 12 motors answered and already have their IDs, so there’s no motor setup to do."
      : "Fix the problem below, then check again.",
    body: `<ul class="list">${rows}</ul>${issues}`,
    actions: allReady ? button("next", "Continue", "primary") : button("retry", "Check again", "primary"),
  });
  click("next", () => go("identify", identify));
  click("retry", () => go("power", power));
}

// ── 4. Which arm is which ───────────────────────────────────────────────────
async function identify(): Promise<void> {
  const render = (motion: Record<string, number>, found?: { follower: string; leader: string }) => {
    const max = Math.max(600, ...Object.values(motion));
    const rows = state.ports
      .map((port) => {
        const label = found ? (port === found.follower ? "Claw arm" : "Handle arm") : "Board";
        const dot = found ? (port === found.follower ? "live" : "") : (motion[port] ?? 0) > 50 ? "live" : "";
        return `<li><span class="dot ${dot}"></span><span>${label}<span class="sub">${shortPort(port)}</span></span>
          <span class="meter"><i style="width:${Math.min(100, ((motion[port] ?? 0) / max) * 100)}%"></i></span></li>`;
      })
      .join("");
    screen({
      eyebrow: "Step 3",
      title: found ? "Got it." : "Which arm is which?",
      lede: found
        ? "The board you moved is the claw arm. If that’s backwards, swap them."
        : "Gently move the arm with the claw: swivel it, bend it, open and close the claw. Leave the handle arm still.",
      body: `<ul class="list">${rows}</ul>`,
      actions: found ? button("swap", "Swap") + button("next", "Continue", "primary") : "",
    });
    click("swap", () => {
      [state.follower, state.leader] = [state.leader, state.follower];
      render(motion, { follower: state.follower, leader: state.leader });
    });
    click("next", () => go("follower", () => calibrate("follower")));
  };

  let motion: Record<string, number> = {};
  render(motion);
  onLeave(
    on("identify", (data) => {
      motion = data.motion;
      render(motion);
    }),
  );
  onLeave(
    on("identified", (data) => {
      state.follower = data.follower;
      state.leader = data.leader;
      render(motion, data);
    }),
  );
  onLeave(() => void call("identify_stop"));
  await call("identify_start", { ports: state.ports });
}

// ── 5 & 6. Calibration ──────────────────────────────────────────────────────
const JOINT_LABELS: Record<string, string> = {
  shoulder_pan: "Base",
  shoulder_lift: "Upper arm",
  elbow_flex: "Elbow",
  wrist_flex: "Wrist",
  gripper: "Claw",
};
const RING_COLORS = ["#0a84ff", "#ff9f0a", "#30d158", "#bf5af2", "#ff375f"];

function hintFor(joint: string, role: Role): string {
  return {
    shoulder_pan: "Swivel the whole arm all the way left, then all the way right.",
    shoulder_lift:
      "Tilt the tall upright section all the way forward, then all the way back. Support the forearm.",
    elbow_flex: "Bend the forearm all the way in, then straighten it all the way out.",
    wrist_flex: "Tip the wrist all the way up, then all the way down.",
    gripper:
      role === "follower"
        ? "Open the claw fully, then close it fully."
        : "Squeeze the trigger fully, then let it open fully.",
  }[joint]!;
}

function ringsMarkup(ranges: Ranges, role: Role): string {
  const joints = Object.keys(JOINT_LABELS);
  const circles = joints
    .map((joint, i) => {
      const r = 90 - i * 16;
      const pct = (ranges.joints[joint]?.coverage ?? 0) * 100;
      return `<circle cx="100" cy="100" r="${r}" fill="none" stroke="${RING_COLORS[i]}" stroke-opacity="0.15" stroke-width="12"/>
        <circle cx="100" cy="100" r="${r}" fill="none" stroke="${RING_COLORS[i]}" stroke-width="12" stroke-linecap="round"
          pathLength="100" stroke-dasharray="${pct} 100" transform="rotate(-90 100 100)"/>`;
    })
    .join("");
  const legend = joints
    .map((joint, i) => {
      const pct = Math.round((ranges.joints[joint]?.coverage ?? 0) * 100);
      const label = joint === "gripper" && role === "leader" ? "Trigger" : JOINT_LABELS[joint];
      return `<li class="${pct < 80 ? "low" : ""}"><span class="dot" style="background:${RING_COLORS[i]}"></span>${label}<b>${pct}%</b></li>`;
    })
    .join("");
  return `<div class="rings"><svg viewBox="0 0 200 200" width="200" height="200">${circles}</svg><ul>${legend}</ul></div>`;
}

async function calibrate(role: Role): Promise<void> {
  const port = role === "follower" ? state.follower : state.leader;
  const name = ARM_NAMES[role];
  const step = role === "follower" ? "Step 4" : "Step 5";
  const next = () => (role === "follower" ? go("leader", () => calibrate("leader")) : go("try", tryIt));
  view.setKind(role);
  view.setPose(MIDDLE);
  onLeave(() => void call("calibrate_cancel"));

  const prepare = () => {
    screen({
      eyebrow: step,
      title: `Calibrate the ${name}.`,
      lede:
        role === "follower"
          ? "Its motors will relax so you can move it by hand. Keep a hand under the forearm so it doesn’t drop."
          : "You’ll pose it, then move each joint end to end. Its motors stay relaxed the whole time.",
      actions: button("relax", role === "follower" ? "Relax the motors" : "Start", "primary"),
    });
    click("relax", async () => {
      try {
        await call("calibrate_begin", { role, port, arm_id: ARM_IDS[role] });
        pose();
      } catch (error) {
        screen({
          eyebrow: step,
          title: "Couldn’t reach the arm.",
          body: failure(error),
          actions: button("back", "Try again", "primary"),
        });
        click("back", prepare);
      }
    });
  };

  const pose = () => {
    view.setPose(MIDDLE);
    screen({
      eyebrow: step,
      title: "Hold it like this.",
      lede: "Base facing forward, upper arm straight up, forearm level and pointing forward, wrist straight, claw half open.",
      actions: button("middle", "Save middle position", "primary"),
    });
    click("middle", async () => {
      await call("calibrate_set_middle");
      sweep();
    });
  };

  const sweep = () => {
    let latest: Ranges | null = null;
    const render = () => {
      const ranges = latest ?? { joints: {}, ready: false, least_covered: "shoulder_pan" };
      const hint = ranges.ready
        ? `<div class="hint done">Every joint has been moved end to end. Save when you’re ready.</div>`
        : `<div class="hint"><b>${JOINT_LABELS[ranges.least_covered]}:</b> ${hintFor(ranges.least_covered, role)}</div>`;
      screen({
        eyebrow: step,
        title: "Move every joint end to end.",
        lede: "Slowly, until each one stops. Wrist roll turns all the way around, so it’s skipped.",
        body: ringsMarkup(ranges, role) + hint,
        actions: button("restart", "Start over") + button("save", "Save calibration", "primary"),
      });
      (document.getElementById("save") as HTMLButtonElement).disabled = !ranges.ready;
      click("restart", async () => {
        stop();
        await call("calibrate_cancel");
        prepare();
      });
      click("save", async () => {
        stop();
        const saved = await call<{ path: string }>("calibrate_finish");
        screen({
          eyebrow: step,
          title: `The ${name} is calibrated.`,
          lede: "Saved where LeRobot looks for it, so its own tools will use it too.",
          body: `<pre>${saved.path}</pre>`,
          actions: button("next", "Continue", "primary"),
        });
        click("next", next);
      });
    };
    // Re-rendering the panel 15 times a second would fight with clicks; refresh at 4 Hz.
    const stopEvents = on("ranges", (data: Ranges) => {
      latest = data;
      const raw = Object.fromEntries(Object.entries(data.joints).map(([j, v]) => [j, v.position]));
      view.setPose(poseFromRaw(raw));
    });
    const timer = setInterval(render, 250);
    const stop = () => {
      stopEvents();
      clearInterval(timer);
    };
    onLeave(stop);
    render();
  };

  const info = await call<{ exists: boolean; modified?: string }>("calibration_info", {
    role,
    port,
    arm_id: ARM_IDS[role],
  });
  if (!info.exists) return prepare();
  screen({
    eyebrow: step,
    title: `The ${name} is already calibrated.`,
    lede: `Saved ${new Date(info.modified!).toLocaleString()}. Use it, or recalibrate if the arm was taken apart or behaves oddly.`,
    actions: button("recal", "Recalibrate") + button("use", "Use it", "primary"),
  });
  click("recal", prepare);
  click("use", next);
}

// ── 7. Teleoperate ──────────────────────────────────────────────────────────
async function tryIt(): Promise<void> {
  view.setKind("follower");
  view.setPose(MIDDLE);

  const ready = () => {
    screen({
      eyebrow: "Step 6",
      title: "Line them up.",
      lede: "Put both arms in roughly the same pose. When you start, the claw arm eases into place over a second, then follows the handle arm.",
      actions: button("start", "Start teleoperating", "primary"),
    });
    click("start", running);
  };

  const running = async () => {
    let status = { state: "starting", hz: 0, message: "" };
    const render = () => {
      const label: Record<string, string> = {
        starting: "Connecting…",
        easing_in: "Easing in…",
        running: "Following",
        retrying: "Retrying a missed read…",
        reconnecting: "Reconnecting…",
      };
      screen({
        eyebrow: "Step 6",
        title: "Move the handle arm.",
        lede: "The claw arm follows. Squeeze the trigger to close the claw.",
        body: `<div class="hud"><div><b>${status.hz ? status.hz.toFixed(0) : "–"} Hz</b><small>Update rate</small></div>
          <div><b>${label[status.state] ?? status.state}</b><small>Status</small></div></div>`,
        actions: button("stop", "Stop", "danger"),
      });
      click("stop", confirmStop);
    };
    const stopEvents = on("teleop", (data) => {
      if (data.leader) view.setPose(poseFromJoints(data.leader));
      if (data.state === "error") {
        cleanupRun();
        screen({
          eyebrow: "Step 6",
          title: "Teleoperation stopped.",
          body: failure(data.message),
          actions: button("again", "Start again", "primary"),
        });
        click("again", ready);
        return;
      }
      if (data.state !== "stopped") status = { ...status, ...data };
    });
    const timer = setInterval(render, 300);
    const cleanupRun = () => {
      stopEvents();
      clearInterval(timer);
    };
    onLeave(cleanupRun);
    onLeave(() => void call("teleop_stop", { relax: false }));
    render();
    await call("teleop_start", {
      follower: { port: state.follower, arm_id: ARM_IDS.follower },
      leader: { port: state.leader, arm_id: ARM_IDS.leader },
    });

    function confirmStop() {
      cleanupRun();
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
        lede: "LeRobot can use them as-is. To record demonstrations:",
        body: `<pre>lerobot-record \\
  --robot.type=so101_follower --robot.port=${state.follower} --robot.id=${ARM_IDS.follower} \\
  --teleop.type=so101_leader --teleop.port=${state.leader} --teleop.id=${ARM_IDS.leader}</pre>`,
        actions: button("again", "Teleoperate again", "primary"),
      });
      click("again", ready);
    }
  };

  ready();
}

// ── boot ────────────────────────────────────────────────────────────────────
on("exited", (data) => {
  screen({
    title: "The hardware helper stopped.",
    lede: "Pivot can’t talk to the arms until it’s running. Quit and reopen Pivot.",
    body: data?.message ? failure(data.message) : "",
  });
});

const hello = await call<{ fake: boolean; scenario: string | null }>("hello");
if (hello.fake) {
  const badge = document.getElementById("badge")!;
  badge.hidden = false;
  badge.textContent = `Simulated arms · ${hello.scenario}`;
}
go("welcome", welcome);
