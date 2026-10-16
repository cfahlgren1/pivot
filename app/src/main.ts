// Pivot: set up SO-101 arms one screen at a time, then drive, record and replay them.
import "./style.css";
import { drive } from "./drive";
import { go, setRoutes } from "./nav";
import { record } from "./record";
import { recordings } from "./recordings";
import { calibrate, connect, identify, power, welcome } from "./setup";
import { call, on } from "./sidecar";
import { failure, screen } from "./ui";

setRoutes({
  welcome,
  connect,
  power,
  identify,
  follower: () => calibrate("follower"),
  leader: () => calibrate("leader"),
  drive,
  record,
  recordings,
});

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
go("welcome");
