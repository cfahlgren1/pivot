//! Pivot's native shell: starts the Python hardware sidecar and relays its JSON lines.
//!
//! The UI sends requests with the `sidecar_send` command; every line the sidecar prints is
//! forwarded to the UI as a `sidecar` event.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::thread;

use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

#[derive(Default)]
struct Sidecar {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
}

/// GUI apps don't inherit the shell PATH on macOS, so look for uv in the usual install spots too.
fn find_uv() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        format!("{home}/.local/bin/uv"),
        format!("{home}/.cargo/bin/uv"),
        "/opt/homebrew/bin/uv".to_string(),
        "/usr/local/bin/uv".to_string(),
    ];
    candidates
        .iter()
        .map(PathBuf::from)
        .find(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from("uv"))
}

/// Release builds ship a frozen sidecar in the app's resources (see scripts/build-mac.sh).
/// Dev builds run it from the repo with uv. `PIVOT_SIDECAR_ARGS="--fake"` simulates arms.
fn sidecar_command(app: &AppHandle) -> Command {
    let bundled = app
        .path()
        .resource_dir()
        .map(|dir| dir.join("pivot-sidecar").join("pivot-sidecar"))
        .ok()
        .filter(|path| path.is_file());
    let mut command = match bundled {
        Some(path) => Command::new(path),
        None => {
            let project = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../sidecar");
            let mut command = Command::new(find_uv());
            command
                .args(["run", "--quiet", "--project"])
                .arg(project)
                .arg("pivot-sidecar");
            command
        }
    };
    if let Ok(extra) = std::env::var("PIVOT_SIDECAR_ARGS") {
        command.args(extra.split_whitespace());
    }
    command
}

fn start_sidecar(app: &AppHandle) -> Result<(), String> {
    let mut command = sidecar_command(app);
    eprintln!("Starting sidecar: {:?}", command.get_program());
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Couldn't start the hardware sidecar: {e}"))?;

    let stdout = child.stdout.take().ok_or("Sidecar has no stdout")?;
    let state = app.state::<Sidecar>();
    *state.stdin.lock().unwrap() = child.stdin.take();
    *state.child.lock().unwrap() = Some(child);

    let app = app.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = app.emit("sidecar", line);
        }
        let _ = app.emit("sidecar", r#"{"event":"exited","data":{}}"#);
    });
    Ok(())
}

#[tauri::command]
fn sidecar_send(line: String, state: State<Sidecar>) -> Result<(), String> {
    let mut guard = state.stdin.lock().unwrap();
    let stdin = guard.as_mut().ok_or("The hardware sidecar isn't running")?;
    writeln!(stdin, "{line}").map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .manage(Sidecar::default())
        .invoke_handler(tauri::generate_handler![sidecar_send])
        .setup(|app| {
            if let Err(message) = start_sidecar(app.handle()) {
                eprintln!("{message}");
                let _ = app.emit(
                    "sidecar",
                    serde_json::json!({"event": "exited", "data": {"message": message}})
                        .to_string(),
                );
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Pivot")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(mut child) = app.state::<Sidecar>().child.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
