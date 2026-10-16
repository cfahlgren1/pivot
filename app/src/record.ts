// Step 7: record demonstrations one take at a time, with Keep or Redo after each.
import { poseFromJoints } from "./arm3d";
import { state, view } from "./context";
import { padMapping, startDriving, STATUS_LABELS, type TeleopStatus } from "./drive";
import { onPress, pad, type PadButton } from "./gamepad";
import { go, onLeave } from "./nav";
import { call } from "./sidecar";
import { button, click, escapeHtml, failure, formatSeconds, onKey, plural, screen } from "./ui";

export type Preview = { joints: string[]; timestamps: number[]; action: number[][] };
type Take = { duration: number; frames: number; source: string; preview: Preview };
type EpisodeSummary = {
  index: number;
  duration: number;
  frames: number;
  source: string;
  recorded_at: string;
};
export type Dataset = { name: string; task: string; path: string; episodes: EpisodeSummary[] };

const RESET_SECONDS = 5;
const CHART_JOINTS = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "gripper"];
const CHART_COLORS = ["#0a84ff", "#ff9f0a", "#30d158", "#bf5af2", "#ff375f"];

export function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Animates the 3D arm through a recorded episode, looping. Returns a function that stops it. */
export function playPreview(preview: Preview): () => void {
  const { joints, timestamps, action } = preview;
  const duration = timestamps.at(-1) ?? 0;
  const began = performance.now();
  let frame = 0;
  let handle = 0;
  const tick = () => {
    const t = duration ? ((performance.now() - began) / 1000) % (duration + 1) : 0;
    frame = t < timestamps[frame] ? 0 : frame;
    while (frame + 1 < timestamps.length && timestamps[frame + 1] <= t) frame++;
    if (action[frame])
      view.setPose(poseFromJoints(Object.fromEntries(joints.map((j, i) => [j, action[frame][i]]))));
    handle = requestAnimationFrame(tick);
  };
  tick();
  return () => cancelAnimationFrame(handle);
}

/** One line per joint over the whole episode. */
export function chart(preview: Preview): string {
  const width = 400;
  const rows = CHART_JOINTS.map((joint, row) => {
    const column = preview.joints.indexOf(joint);
    const values = preview.action.map((a) => a[column]);
    const low = Math.min(...values);
    const span = Math.max(...values) - low || 1;
    const points = values
      .map(
        (v, i) =>
          `${((i / Math.max(1, values.length - 1)) * width).toFixed(1)},${(17 - ((v - low) / span) * 14).toFixed(1)}`,
      )
      .join(" ");
    return `<svg viewBox="0 0 ${width} 20" preserveAspectRatio="none"><polyline points="${points}" fill="none" stroke="${CHART_COLORS[row]}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
  });
  return `<div class="chart">${rows.join("")}</div>`;
}

/** Binds a screen's controls to on-screen buttons, controller buttons and keys, replacing the last set. */
function controls(): (bindings: Partial<Record<PadButton | "space", () => void>>) => void {
  let unbind: (() => void)[] = [];
  const clear = () => {
    unbind.forEach((fn) => fn());
    unbind = [];
  };
  onLeave(clear);
  return (bindings) => {
    clear();
    for (const [key, handler] of Object.entries(bindings)) {
      unbind.push(key === "space" ? onKey(" ", handler) : onPress(key as PadButton, handler));
    }
  };
}

const hint = (keys: [string, string, string][]) =>
  `<div class="hints">${keys.map(([cls, glyph, label]) => `<span><span class="xb ${cls}">${glyph}</span>${label}</span>`).join("")}</div>`;

export async function record(): Promise<void> {
  view.setKind("follower");
  const bind = controls();
  let live = true;
  let stopPlayback: (() => void) | null = null;
  let kept = 0;
  let timer = 0;
  const stopTimer = () => clearInterval(timer);
  onLeave(stopTimer);
  onLeave(() => stopPlayback?.());

  let status: TeleopStatus = { state: "starting" };
  startDriving((data) => {
    if (live && data.target) view.setPose(poseFromJoints(data.target));
    if (data.state === "error") {
      stopTimer();
      bind({});
      screen({
        eyebrow: "Recording",
        title: "Driving stopped.",
        body: failure(data.message),
        actions: button("again", "Start again", "primary"),
      });
      click("again", () => go("record"));
      return;
    }
    if (data.state !== "stopped") status = { ...status, ...data };
  });

  const recorded = async (): Promise<number> => {
    const { datasets } = await call<{ datasets: Dataset[] }>("recordings_list");
    return datasets.find((d) => d.name === slug(state.dataset))?.episodes.length ?? 0;
  };
  const progressBar = (total: number, current: number | null) =>
    `<div class="takes">${Array.from(
      { length: state.episodeTarget },
      (_, i) => `<i class="${i < total ? "kept" : i === current ? "now" : ""}"></i>`,
    ).join("")}</div><p class="note">${total} of ${state.episodeTarget} recorded</p>`;

  // ── session setup ──
  const setup = async () => {
    live = true;
    stopPlayback?.();
    stopTimer();
    const existing = await recorded();
    const lengths = [15, 30, 60];
    const targets = [10, 20, 50];
    screen({
      eyebrow: "Record",
      title: "What should it learn?",
      lede: "Describe the task, then show it how, a few seconds per take. Drive the arm into a starting pose first.",
      body: `<div class="form">
        <label class="field"><span>Task</span><input id="task" value="${escapeHtml(state.task)}" spellcheck="false"></label>
        <label class="field"><span>Dataset</span><input id="dataset" value="${escapeHtml(state.dataset)}" spellcheck="false"></label>
        <div class="field-row">
          <label class="field"><span>Takes</span><select id="target">${targets.map((n) => `<option ${n === state.episodeTarget ? "selected" : ""}>${n}</option>`).join("")}</select></label>
          <label class="field"><span>Longest take</span><select id="length">${lengths.map((n) => `<option value="${n}" ${n === state.episodeSeconds ? "selected" : ""}>${n} s</option>`).join("")}</select></label>
        </div></div>
        <p class="note">${existing ? `${plural(existing, "take")} already in this dataset. New ones are added to it.` : "Takes are saved on this Mac."}</p>`,
      actions: button("go", "Start recording", "primary") + button("list", "See recordings"),
    });
    const begin = () => {
      const task = (document.getElementById("task") as HTMLInputElement).value.trim();
      const dataset = (document.getElementById("dataset") as HTMLInputElement).value;
      if (!task || !slug(dataset)) return;
      state.task = task;
      state.dataset = slug(dataset);
      state.episodeTarget = Number((document.getElementById("target") as HTMLSelectElement).value);
      state.episodeSeconds = Number((document.getElementById("length") as HTMLSelectElement).value);
      kept = existing;
      void countdown(3);
    };
    click("go", begin);
    click("list", () => go("recordings"));
    bind({ a: begin });
  };

  // ── 3, 2, 1 ──
  const countdown = async (from: number) => {
    bind({});
    for (let n = from; n > 0; n--) {
      screen({
        eyebrow: `Take ${kept + 1}`,
        title: "Get ready.",
        body: `<div class="countdown">${n}</div>`,
        lede: escapeHtml(state.task),
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    await take();
  };

  // ── recording ──
  const take = async () => {
    try {
      await call("record_start", { dataset: state.dataset, task: state.task });
    } catch (error) {
      screen({
        eyebrow: "Record",
        title: "Couldn’t start recording.",
        body: failure(error),
        actions: button("setup", "Back", "primary"),
      });
      click("setup", setup);
      return;
    }
    const began = performance.now();
    const elapsed = () => (performance.now() - began) / 1000;
    const done = () => void stopTake();
    const discard = async () => {
      stopTimer();
      await call("record_stop", { dataset: state.dataset });
      await call("record_discard");
      reset();
    };
    const render = () => {
      if (elapsed() >= state.episodeSeconds) return done();
      const gamepad = state.driver === "gamepad";
      screen({
        eyebrow: `Recording take ${kept + 1} · ${escapeHtml(state.dataset)}`,
        title: `<span class="timer">${formatSeconds(elapsed())}</span>`,
        lede: `${escapeHtml(state.task)} Stops by itself at ${formatSeconds(state.episodeSeconds)}.`,
        body:
          (gamepad ? padMapping(pad()) : "") +
          `${hint([
            ["a", "A", "Done"],
            ["b", "B", "Discard"],
          ])}${progressBar(kept, kept)}` +
          (status.state !== "running"
            ? `<p class="note">${STATUS_LABELS[status.state] ?? status.state}</p>`
            : ""),
        actions: button("done", "Done", "danger") + button("discard", "Discard"),
      });
      click("done", done);
      click("discard", () => void discard());
    };
    render();
    timer = window.setInterval(render, 250);
    bind({ a: done, space: done, b: () => void discard() });
  };

  const stopTake = async () => {
    stopTimer();
    bind({});
    const result = await call<Take>("record_stop", { dataset: state.dataset });
    review(result);
  };

  // ── keep or redo ──
  const review = (result: Take) => {
    live = false;
    stopPlayback = playPreview(result.preview);
    const keep = async () => {
      bind({});
      await call("record_save");
      kept++;
      if (kept >= state.episodeTarget) finished();
      else reset();
    };
    const redo = async () => {
      bind({});
      await call("record_discard");
      reset();
    };
    screen({
      eyebrow: `Take ${kept + 1} of ${state.episodeTarget}`,
      title: "Keep this take?",
      lede: `${result.duration.toFixed(1)} seconds, replaying on the left. Keep it if it’s how you’d want the robot to do it: no fumbles, no long pauses.`,
      body:
        chart(result.preview) +
        hint([
          ["a", "A", "Keep"],
          ["x", "X", "Redo"],
        ]),
      actions: button("redo", "Redo") + button("keep", "Keep", "primary"),
    });
    click("keep", () => void keep());
    click("redo", () => void redo());
    bind({ a: () => void keep(), space: () => void keep(), x: () => void redo() });
  };

  // ── reset the scene ──
  const reset = () => {
    live = true;
    stopPlayback?.();
    stopPlayback = null;
    const began = performance.now();
    const start = () => {
      stopTimer();
      void countdown(1);
    };
    const pause = () => {
      stopTimer();
      void setup();
    };
    const render = () => {
      const left = RESET_SECONDS - (performance.now() - began) / 1000;
      if (left <= 0) return start();
      screen({
        eyebrow: `${kept} of ${state.episodeTarget} recorded`,
        title: "Reset the scene.",
        lede: "Put things back, a little differently each time, and drive the arm to its starting pose.",
        body: `<div class="ring" style="--p:${(1 - left / RESET_SECONDS) * 100}%"><b>${Math.ceil(left)}</b></div>
          ${hint([
            ["a", "A", "Start now"],
            ["b", "B", "Pause"],
          ])}${progressBar(kept, null)}`,
        actions: button("now", "Start now", "primary") + button("pause", "Pause"),
      });
      click("now", start);
      click("pause", pause);
    };
    render();
    timer = window.setInterval(render, 200);
    bind({ a: start, space: start, b: pause });
  };

  const finished = () => {
    live = true;
    stopPlayback?.();
    stopPlayback = null;
    screen({
      eyebrow: escapeHtml(state.dataset),
      title: `${plural(kept, "take")} recorded.`,
      lede: "Watch them back, replay any of them on the arm, or delete the ones you don’t like.",
      body: progressBar(kept, null),
      actions: button("list", "See recordings", "primary") + button("more", "Record more"),
    });
    click("list", () => go("recordings"));
    click("more", () => {
      state.episodeTarget += 10;
      void setup();
    });
    bind({ a: () => go("recordings") });
  };

  await setup();
}
