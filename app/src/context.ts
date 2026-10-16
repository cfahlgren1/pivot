// State shared by every screen: which board is which arm, how the arm is driven, and the 3D view.
import { ArmView } from "./arm3d";

export type Role = "follower" | "leader";
export type Driver = "leader" | "gamepad";

// Same IDs as LeRobot's docs, so `lerobot-record` picks up the calibration Pivot saves.
export const ARM_IDS: Record<Role, string> = { follower: "my_follower", leader: "my_leader" };
export const ARM_NAMES: Record<Role, string> = { follower: "claw arm", leader: "handle arm" };

export const state = {
  ports: [] as string[],
  follower: "",
  leader: "",
  driver: "leader" as Driver,
  speed: "normal",
  dataset: "pick-up-cube",
  task: "Pick up the cube and put it in the bowl.",
  episodeTarget: 20,
  episodeSeconds: 30,
};

export const view = new ArmView(document.getElementById("arm") as HTMLCanvasElement);
