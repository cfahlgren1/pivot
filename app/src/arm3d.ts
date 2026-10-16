// A stylised SO-101 rendered with three.js: white printed links, black STS3215 servos.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

// Joint angles in degrees from the middle pose; claw runs 0 (closed) to 1 (open).
export type Pose = { pan: number; lift: number; elbow: number; wrist: number; roll: number; claw: number };
export const MIDDLE: Pose = { pan: 0, lift: 0, elbow: 0, wrist: 0, roll: 0, claw: 0.5 };

const rad = THREE.MathUtils.degToRad;

function diamondTexture(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 1024;
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#f3f3f1";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = "#1b1b1d";
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 2; col++) {
      g.save();
      g.translate(76 + col * 104, 150 + row * 110);
      g.rotate(Math.PI / 4);
      g.beginPath();
      g.roundRect(-26, -26, 52, 52, 6);
      g.fill();
      g.restore();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

type Materials = {
  plastic: THREE.Material;
  servo: THREE.Material;
  horn: THREE.Material;
  sticker: THREE.Material;
  decal: THREE.Material | null;
};

function makeMaterials(ghost: boolean): Materials {
  if (ghost) {
    const m = new THREE.MeshBasicMaterial({
      color: 0x4d9bff,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
    });
    return { plastic: m, servo: m, horn: m, sticker: m, decal: null };
  }
  return {
    plastic: new THREE.MeshPhysicalMaterial({
      color: 0xf2f2ef,
      roughness: 0.52,
      clearcoat: 0.15,
      clearcoatRoughness: 0.6,
    }),
    servo: new THREE.MeshPhysicalMaterial({
      color: 0x1a1a1c,
      roughness: 0.34,
      metalness: 0.05,
      clearcoat: 0.4,
      clearcoatRoughness: 0.3,
    }),
    horn: new THREE.MeshStandardMaterial({ color: 0xd4d6da, roughness: 0.28, metalness: 0.85 }),
    sticker: new THREE.MeshStandardMaterial({ color: 0xe8e8e6, roughness: 0.7 }),
    decal: new THREE.MeshPhysicalMaterial({
      map: diamondTexture(),
      roughness: 0.52,
      clearcoat: 0.15,
      clearcoatRoughness: 0.6,
    }),
  };
}

function rbox(w: number, h: number, d: number, material: THREE.Material, r = 0.35): THREE.Mesh {
  const mesh = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 4, Math.min(r, w / 2, h / 2, d / 2)), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function servo(M: Materials, w: number, h: number, d: number, axis: "x" | "y" | "z" = "z"): THREE.Group {
  const group = new THREE.Group();
  group.add(rbox(w, h, d, M.servo, 0.3));
  const horn = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.05, 0.28, 40), M.horn);
  horn.castShadow = true;
  if (axis === "z") horn.rotation.x = Math.PI / 2;
  if (axis === "x") horn.rotation.z = Math.PI / 2;
  horn.position[axis] = (axis === "x" ? w : axis === "y" ? h : d) / 2 + 0.14;
  group.add(horn);
  return group;
}

function decal(M: Materials, w: number, h: number): THREE.Mesh | null {
  if (!M.decal) return null;
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), M.decal);
  plane.position.z = 1.62;
  plane.receiveShadow = true;
  return plane;
}

function jaw(M: Materials, length: number, upper: boolean): THREE.Mesh {
  const shape = new THREE.Shape();
  if (upper) {
    shape.moveTo(0, 0);
    shape.lineTo(length * 0.92, 0.7);
    shape.lineTo(length * 0.92, 1.3);
    shape.lineTo(0, 2.0);
  } else {
    shape.moveTo(0, 0);
    shape.lineTo(length, -0.9);
    shape.lineTo(length, -1.5);
    shape.lineTo(0, -2.4);
  }
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 2.2,
    bevelEnabled: true,
    bevelThickness: 0.25,
    bevelSize: 0.25,
    bevelSegments: 3,
  });
  geometry.translate(0, 0, -1.1);
  const mesh = new THREE.Mesh(geometry, M.plastic);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

class ArmModel {
  root = new THREE.Group();
  private pan = new THREE.Group();
  private shoulder = new THREE.Group();
  private elbow = new THREE.Group();
  private wrist = new THREE.Group();
  private roll = new THREE.Group();
  private claw = new THREE.Group();

  constructor(
    private leader: boolean,
    ghost: boolean,
  ) {
    const M = makeMaterials(ghost);
    const plate = rbox(14, 1.2, 12, M.plastic, 0.5);
    plate.position.y = 0.6;
    this.root.add(plate, this.pan);
    this.pan.position.y = 1.2;

    const panServo = servo(M, 4.6, 3.6, 2.6, "y");
    panServo.position.y = 1.8;
    const bracket = rbox(5.2, 2.6, 4.6, M.plastic, 0.5);
    bracket.position.y = 4.4;
    this.pan.add(panServo, bracket, this.shoulder);

    this.shoulder.position.y = 6.2;
    const shoulderServo = servo(M, 4.4, 3.6, 2.6);
    const upper = rbox(3.0, 11.2, 3.2, M.plastic, 0.6);
    upper.position.y = 5.6;
    this.shoulder.add(shoulderServo, upper, this.elbow);
    const upperDecal = decal(M, 2.2, 8.6);
    if (upperDecal) {
      upperDecal.position.y = 5.6;
      this.shoulder.add(upperDecal);
    }

    this.elbow.position.y = 11.2;
    const forearm = rbox(13.6, 2.8, 3.2, M.plastic, 0.6);
    forearm.position.x = 6.8;
    this.elbow.add(servo(M, 4.4, 3.6, 2.6), forearm, this.wrist);
    const foreDecal = decal(M, 2.0, 9.6);
    if (foreDecal) {
      foreDecal.position.x = 7;
      foreDecal.rotation.z = Math.PI / 2;
      this.elbow.add(foreDecal);
    }

    this.wrist.position.x = 13.6;
    const wristLink = rbox(3.0, 2.6, 3.2, M.plastic, 0.5);
    wristLink.position.x = 2.6;
    this.wrist.add(servo(M, 3.6, 4.4, 2.6), wristLink, this.roll);

    this.roll.position.x = 4.2;
    const rollServo = servo(M, 2.6, 3.6, 4.2, "x");
    rollServo.position.x = 1.3;
    this.roll.add(rollServo, this.claw);

    if (leader) {
      const gripServo = servo(M, 3.4, 2.6, 3.2);
      gripServo.position.set(4.2, 0.2, 0);
      const handle = new THREE.Mesh(new THREE.CapsuleGeometry(1.15, 6.2, 8, 24), M.plastic);
      handle.castShadow = true;
      handle.position.set(5.4, -4.4, 0);
      handle.rotation.z = rad(-12);
      this.roll.add(gripServo, handle);
      this.claw.position.set(6.4, -1.2, 0);
      const trigger = rbox(1.2, 4.2, 1.6, M.plastic, 0.5);
      trigger.position.set(0.8, -2.0, 0);
      this.claw.add(trigger);
    } else {
      const gripServo = servo(M, 4.2, 2.6, 3.4);
      gripServo.position.set(4.8, 0.6, 0);
      const fixed = jaw(M, 8.5, false);
      fixed.position.set(3.4, -0.6, 0);
      this.roll.add(gripServo, fixed);
      this.claw.position.set(5.4, 1.6, 0);
      const moving = jaw(M, 7.6, true);
      moving.position.set(0, -1.4, 0);
      this.claw.add(moving);
    }

    // A ghost only needs the parts that move relative to the base.
    if (ghost) [plate, panServo, bracket, shoulderServo, upper].forEach((m) => (m.visible = false));
  }

  setPose(p: Pose): void {
    this.pan.rotation.y = rad(p.pan);
    this.shoulder.rotation.z = -rad(p.lift);
    this.elbow.rotation.z = -rad(p.elbow);
    this.wrist.rotation.z = -rad(p.wrist);
    this.roll.rotation.x = rad(p.roll);
    this.claw.rotation.z = this.leader ? -rad((1 - p.claw) * 18) : rad(p.claw * 34);
  }
}

export class ArmView {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 1, 400);
  private arm: ArmModel | null = null;
  private ghost: ArmModel | null = null;
  private pose: Pose = { ...MIDDLE };
  private shown: Pose = { ...MIDDLE };
  private size = { w: 0, h: 0 };

  constructor(private canvas: HTMLCanvasElement) {
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    } catch {
      canvas.replaceWith(
        Object.assign(document.createElement("div"), {
          className: "no-gl",
          textContent: "The 3D preview needs graphics acceleration.",
        }),
      );
      return;
    }
    const r = this.renderer;
    r.setPixelRatio(Math.min(2, devicePixelRatio));
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene.environment = new THREE.PMREMGenerator(r).fromScene(new RoomEnvironment(), 0.04).texture;
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(14, 40, 22);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.radius = 6;
    key.shadow.bias = -0.0004;
    Object.assign(key.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 120 });
    this.scene.add(key);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(240, 240),
      new THREE.ShadowMaterial({ opacity: 0.13 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    this.camera.position.set(56, 44, 120);
    this.camera.lookAt(8, 19, 0);
    this.setKind("follower");
    requestAnimationFrame(this.tick);
  }

  setKind(kind: "follower" | "leader"): void {
    if (!this.renderer) return;
    if (this.arm) this.scene.remove(this.arm.root);
    this.arm = new ArmModel(kind === "leader", false);
    this.scene.add(this.arm.root);
  }

  setGhost(pose: Pose | null): void {
    if (!this.renderer) return;
    if (!pose) {
      if (this.ghost) this.scene.remove(this.ghost.root);
      this.ghost = null;
      return;
    }
    if (!this.ghost) {
      this.ghost = new ArmModel(false, true);
      this.scene.add(this.ghost.root);
    }
    this.ghost.setPose(pose);
  }

  setPose(pose: Partial<Pose>): void {
    this.pose = { ...this.pose, ...pose };
  }

  private tick = (): void => {
    requestAnimationFrame(this.tick);
    if (!this.renderer || !this.arm) return;
    // Ease toward the latest reading so 10 Hz updates still look smooth at 60 fps.
    for (const key of Object.keys(this.pose) as (keyof Pose)[]) {
      this.shown[key] += (this.pose[key] - this.shown[key]) * 0.2;
    }
    this.arm.setPose(this.shown);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w !== this.size.w || h !== this.size.h) {
      this.size = { w, h };
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    this.renderer.render(this.scene, this.camera);
  };
}

// LeRobot reports joints in degrees around the calibrated middle and the gripper as 0-100.
export function poseFromJoints(joints: Record<string, number>): Partial<Pose> {
  return {
    pan: joints.shoulder_pan ?? 0,
    lift: joints.shoulder_lift ?? 0,
    elbow: joints.elbow_flex ?? 0,
    wrist: joints.wrist_flex ?? 0,
    roll: joints.wrist_roll ?? 0,
    claw: (joints.gripper ?? 50) / 100,
  };
}

// Raw encoder ticks (0-4095, 2047 = middle) to degrees, for previews before calibration exists.
export function poseFromRaw(raw: Record<string, number | null>): Partial<Pose> {
  const deg = (v: number | null | undefined) => (v == null ? 0 : ((v - 2047) * 360) / 4096);
  return {
    pan: deg(raw.shoulder_pan),
    lift: deg(raw.shoulder_lift),
    elbow: deg(raw.elbow_flex),
    wrist: deg(raw.wrist_flex),
    claw: raw.gripper == null ? 0.5 : Math.min(1, Math.max(0, (raw.gripper - 1400) / 1450)),
  };
}
