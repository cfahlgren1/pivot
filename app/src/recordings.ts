// Step 8: browse recorded takes, watch them on the 3D arm, replay them on the real one.
import { MIDDLE, poseFromJoints } from "./arm3d";
import { ARM_IDS, state, view } from "./context";
import { onPress } from "./gamepad";
import { go, onLeave } from "./nav";
import { type Dataset, chart, playPreview, type Preview, slug } from "./record";
import { call, on } from "./sidecar";
import { button, click, escapeHtml, failure, formatSeconds, onKey, plural, screen } from "./ui";

type Episode = { duration: number; frames: number; source: string; recorded_at: string; preview: Preview };
type ReplayStatus = {
  state: string;
  t?: number;
  duration?: number;
  target?: Record<string, number>;
  message?: string;
};

const SOURCE_LABELS: Record<string, string> = { leader_arm: "Handle arm", gamepad: "Controller" };

export async function recordings(): Promise<void> {
  view.setKind("follower");
  view.setPose(MIDDLE);
  let stopPlayback: (() => void) | null = null;
  const stopPreview = () => {
    stopPlayback?.();
    stopPlayback = null;
  };
  onLeave(stopPreview);
  onLeave(() => void call("replay_stop"));

  let unbind: (() => void)[] = [];
  const bind = (bindings: { space?: () => void; y?: () => void; b?: () => void }) => {
    unbind.forEach((fn) => fn());
    unbind = [];
    if (bindings.space) unbind.push(onKey(" ", bindings.space));
    if (bindings.y) unbind.push(onPress("y", bindings.y));
    if (bindings.b) unbind.push(onPress("b", bindings.b));
  };
  onLeave(() => bind({}));

  let datasets: Dataset[] = [];
  let root = "";
  let datasetName = slug(state.dataset);
  let selected: number | null = null;
  let speed = 0.5;

  const load = async () => {
    ({ datasets, root } = await call<{ datasets: Dataset[]; root: string }>("recordings_list"));
    datasets = datasets.filter((d) => d.episodes.length > 0);
    if (!datasets.some((d) => d.name === datasetName)) datasetName = datasets[0]?.name ?? "";
    const episodes = datasets.find((d) => d.name === datasetName)?.episodes ?? [];
    if (!episodes.some((e) => e.index === selected)) selected = episodes.at(-1)?.index ?? null;
  };

  // ── list ──
  const list = async () => {
    stopPreview();
    bind({});
    await load();
    const dataset = datasets.find((d) => d.name === datasetName);
    if (!dataset) {
      screen({
        eyebrow: "Recordings",
        title: "No recordings yet.",
        lede: "Record a few takes of a task, and they’ll show up here.",
        actions: button("record", "Record demos", "primary"),
      });
      click("record", () => go("record"));
      return;
    }
    const episode =
      selected === null
        ? null
        : await call<Episode>("recording_get", { dataset: datasetName, index: selected });
    if (episode) stopPlayback = playPreview(episode.preview);

    const picker =
      datasets.length > 1
        ? `<select id="pick-dataset" class="inline-select">${datasets
            .map(
              (d) =>
                `<option value="${d.name}" ${d.name === datasetName ? "selected" : ""}>${escapeHtml(d.name)}</option>`,
            )
            .join("")}</select>`
        : "";
    const rows = dataset.episodes
      .map(
        (e) => `<li><button class="episode ${e.index === selected ? "on" : ""}" data-index="${e.index}">
          <span class="num">${e.index}</span><span>${SOURCE_LABELS[e.source] ?? e.source}</span>
          <span class="end">${formatSeconds(e.duration)}</span></button></li>`,
      )
      .join("");
    screen({
      eyebrow: `Recordings${picker ? "" : ` · ${escapeHtml(dataset.name)}`}`,
      title: escapeHtml(dataset.task),
      lede: `${plural(dataset.episodes.length, "take")}${picker ? ` in ${picker}` : ""}. Pick one to watch it on the left.`,
      body: `<ul class="list episodes">${rows}</ul>${episode ? chart(episode.preview) : ""}
        <p class="note">Saved in <span class="mono">${escapeHtml(root.replace(/^\/Users\/[^/]+/, "~"))}</span></p>`,
      actions:
        button("replay", "Replay on arm", "primary") +
        button("delete", "Delete take") +
        button("record", "Record more"),
    });
    document.querySelectorAll<HTMLButtonElement>(".episode").forEach((row) =>
      row.addEventListener("click", () => {
        selected = Number(row.dataset.index);
        void list();
      }),
    );
    document.getElementById("pick-dataset")?.addEventListener("change", (event) => {
      datasetName = (event.target as HTMLSelectElement).value;
      selected = null;
      void list();
    });
    click("replay", prepare);
    click("delete", confirmDelete);
    click("record", () => go("record"));
    bind({ y: prepare });
  };

  const confirmDelete = () => {
    if (selected === null) return;
    bind({});
    screen({
      eyebrow: "Recordings",
      title: `Delete take ${selected}?`,
      lede: "It’s removed from this Mac. This can’t be undone.",
      actions: button("cancel", "Cancel") + button("confirm", "Delete", "danger"),
    });
    click("cancel", () => void list());
    click("confirm", async () => {
      await call("recording_delete", { dataset: datasetName, index: selected });
      selected = null;
      void list();
    });
  };

  // ── replay on the real arm ──
  const prepare = () => {
    if (selected === null) return;
    const render = () => {
      screen({
        eyebrow: `Replay take ${selected}`,
        title: "Set the scene back.",
        lede: "The claw arm will repeat exactly what you recorded, so put things where they were at the start. It moves to the starting pose first.",
        body: `<div class="row"><span class="note">Speed</span><div class="seg">
          <button id="half" class="${speed === 0.5 ? "on" : ""}">½×</button>
          <button id="full" class="${speed === 1 ? "on" : ""}">1×</button></div></div>`,
        actions: button("start", "Start replay", "primary") + button("cancel", "Cancel"),
      });
      click("half", () => ((speed = 0.5), render()));
      click("full", () => ((speed = 1), render()));
      click("start", () => void replay());
      click("cancel", () => void list());
    };
    render();
    bind({ space: () => void replay(), y: () => void replay(), b: () => void list() });
  };

  const replay = async () => {
    stopPreview();
    let status: ReplayStatus = { state: "starting" };
    const stop = async () => {
      await call("replay_stop");
      void list();
    };
    const render = () => {
      const playing = status.state === "playing";
      const t = status.t ?? 0;
      const duration = status.duration ?? 0;
      screen({
        eyebrow: `Replaying take ${selected} · ${speed === 1 ? "1×" : "½×"}`,
        title: "Watch the claw arm.",
        lede: playing ? "Playing back what you recorded." : "Moving to the starting pose…",
        body: `<div class="card-progress"><div class="row between"><b>${formatSeconds(t)}</b><span class="note">${formatSeconds(duration)}</span></div>
          <div class="bar"><i style="width:${duration ? (t / duration) * 100 : 0}%"></i></div></div>`,
        actions: button("stop", "Stop", "danger"),
      });
      click("stop", () => void stop());
    };
    const timer = setInterval(render, 200);
    const stopEvents = on("replay", (data: ReplayStatus) => {
      if (data.target) view.setPose(poseFromJoints(data.target));
      if (data.state === "done" || data.state === "error" || data.state === "stopped") {
        clearInterval(timer);
        stopEvents();
        finished(data);
        return;
      }
      status = { ...status, ...data };
    });
    onLeave(() => clearInterval(timer));
    onLeave(stopEvents);
    render();
    bind({ space: () => void stop(), b: () => void stop() });
    try {
      await call("replay_start", {
        follower: { port: state.follower, arm_id: ARM_IDS.follower },
        dataset: datasetName,
        index: selected,
        speed,
      });
    } catch (error) {
      clearInterval(timer);
      stopEvents();
      finished({ state: "error", message: String(error) });
    }
  };

  const finished = (result: ReplayStatus) => {
    bind({ y: prepare, space: () => void list() });
    screen({
      eyebrow: `Replay take ${selected}`,
      title:
        result.state === "error"
          ? "Replay stopped."
          : result.state === "done"
            ? "That’s the take."
            : "Stopped.",
      lede: result.state === "error" ? "" : "The claw arm is holding its last pose.",
      body: result.state === "error" ? failure(result.message) : "",
      actions: button("again", "Replay again", "primary") + button("to-list", "Back to recordings"),
    });
    click("again", prepare);
    click("to-list", () => void list());
  };

  await list();
}
