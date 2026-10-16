// Regenerates the README screenshots in docs/screenshots/ from the real UI and the simulated arms.
// Runs in headless Chromium with software WebGL, so it works without a GPU. Usage: pnpm screenshots
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "../../docs/screenshots");
const APP = "http://localhost:1420";

const children = [
  spawn("python3", [join(here, "bridge.py")], { stdio: "inherit" }),
  spawn("pnpm", ["exec", "vite", "--port", "1420", "--strictPort"], {
    cwd: join(here, ".."),
    stdio: "ignore",
  }),
];
const stop = () => children.forEach((child) => child.kill());
process.on("exit", stop);

async function waitForServer(url) {
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`${url} never came up`);
}

await waitForServer(APP);
await waitForServer("http://127.0.0.1:1430/events").catch(() => {});
await mkdir(out, { recursive: true });

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1200, height: 780 }, deviceScaleFactor: 2 });
await page.addInitScript({ path: join(here, "tauri-mock.js") });
page.on("pageerror", (error) => console.error("page error:", error.message));
await page.goto(APP);
// The "Simulated arms" badge is for development; real setups never show it.
await page.addStyleTag({ content: "#badge { display: none !important; }" });

const shots = [];
async function shoot(name) {
  await page.waitForTimeout(700); // let the slide-in and the arm settle
  shots.push({ name, png: await page.screenshot() });
  console.log("captured", name);
}
async function clickWhenReady(id) {
  const button = page.locator(`#${id}:not([disabled])`);
  await button.waitFor({ timeout: 60_000 });
  await button.click();
}
// A previous run may have left a simulated calibration behind; start that arm over if so.
async function beginCalibration() {
  await page.locator("#relax, #recal").first().waitFor({ timeout: 60_000 });
  if (await page.locator("#recal").count()) await page.locator("#recal").click();
  await clickWhenReady("relax");
}
const waitForText = (text) => page.getByText(text).first().waitFor({ timeout: 60_000 });

await waitForText("Let’s get your arms moving.");
await shoot("1-welcome");

await clickWhenReady("start");
await waitForText("Both boards found.");
await shoot("2-connect");

await clickWhenReady("next");
await page.locator("#next").waitFor({ timeout: 30_000 });
await shoot("3-power");

await clickWhenReady("next");
await page.locator("#swap").waitFor({ timeout: 30_000 });
await shoot("4-identify");

await clickWhenReady("next");
await beginCalibration();
await clickWhenReady("middle");
await page.waitForTimeout(8_000); // the simulated user is partway through sweeping the joints
await shoot("5-calibrate");

await clickWhenReady("save");
await clickWhenReady("next");
await beginCalibration();
await clickWhenReady("middle");
await clickWhenReady("save");
await clickWhenReady("next");
await clickWhenReady("start");
await page.locator("#stop").waitFor({ timeout: 30_000 });
await page.waitForTimeout(3_000);
await shoot("6-teleop");

// Frame each capture as a macOS window with traffic lights and a soft shadow, on a transparent background.
const framePage = await browser.newPage({ viewport: { width: 1320, height: 900 }, deviceScaleFactor: 2 });
for (const { name, png } of shots) {
  await framePage.setContent(`
    <style>
      body { margin: 0; background: transparent; }
      .window { position: relative; margin: 40px 60px 80px; width: 1200px; height: 780px; border-radius: 12px;
        overflow: hidden; box-shadow: 0 0 0 0.5px rgba(0,0,0,.25), 0 24px 60px rgba(0,0,0,.22), 0 6px 16px rgba(0,0,0,.08); }
      .window img { display: block; width: 100%; height: 100%; }
      .lights { position: absolute; top: 18px; left: 20px; display: flex; gap: 8px; }
      .lights i { width: 12px; height: 12px; border-radius: 50%; box-shadow: inset 0 0 0 0.5px rgba(0,0,0,.2); }
    </style>
    <div class="window">
      <img src="data:image/png;base64,${png.toString("base64")}">
      <div class="lights"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>
    </div>`);
  await framePage.locator(".window img").evaluate((img) => img.decode());
  await framePage.screenshot({ path: join(out, `${name}.png`), omitBackground: true });
}

await browser.close();
stop();
console.log(`Wrote ${shots.length} screenshots to docs/screenshots/`);
