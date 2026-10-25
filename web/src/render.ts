// three.js view of the arena. Purely visual: positions come from server snapshots.
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { SNAP_STRIDE, RULES } from "../../shared/physics";
import { BATTLE, WEAPONS, type BattleSnap } from "../../shared/battle";
import { COLORS } from "../../shared/config";
import { RACE, TRACK, gridSpot, type RaceSnap } from "../../shared/race";

// shared by every spark so effects don't allocate GPU objects per hit
const SPARK_GEO = new THREE.SphereGeometry(0.08, 6, 4);
const sparkMats = new Map<string, THREE.MeshBasicMaterial>();
const sparkMat = (c: string) => {
  let m = sparkMats.get(c);
  if (!m) sparkMats.set(c, (m = new THREE.MeshBasicMaterial({ color: c })));
  return m;
};
const GHOST_GEO = new THREE.SphereGeometry(RULES.ballRadius, 20, 14);

const textures = new Map<string, THREE.Texture>();
function skinTexture(file: string) {
  let t = textures.get(file);
  if (!t) {
    t = new THREE.TextureLoader().load(`/skins/${encodeURIComponent(file)}`);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    textures.set(file, t);
  }
  return t;
}

// confetti pieces: one flat card, a double-sided material per colour
const CONFETTI_GEO = new THREE.PlaneGeometry(0.3, 0.17);
const confettiMats = new Map<string, THREE.MeshBasicMaterial>();
const confettiMat = (c: string) => {
  let m = confettiMats.get(c);
  if (!m) confettiMats.set(c, (m = new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide })));
  return m;
};
const KO_RING_GEO = new THREE.RingGeometry(0.75, 1, 48).rotateX(-Math.PI / 2);

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Floor of the platform: a dark glossy disc with faint neon rings and spokes (mapped onto the cylinder's top cap). */
function floorTextures() {
  const S = 1024;
  const C = S / 2;
  const color = canvasTexture(S, S, (g) => {
    const grad = g.createRadialGradient(C, C, 0, C, C, C);
    grad.addColorStop(0, "#252b5e");
    grad.addColorStop(0.7, "#161a3d");
    grad.addColorStop(1, "#0e1130");
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
  });
  const glow = canvasTexture(S, S, (g) => {
    g.fillStyle = "#000";
    g.fillRect(0, 0, S, S);
    g.strokeStyle = "rgba(94,231,255,0.32)";
    g.lineWidth = 2;
    for (let i = 1; i < 8; i++) {
      g.beginPath();
      g.arc(C, C, (C * i) / 8, 0, Math.PI * 2);
      g.stroke();
    }
    g.strokeStyle = "rgba(94,231,255,0.16)";
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      g.beginPath();
      g.moveTo(C + Math.cos(a) * C * 0.125, C + Math.sin(a) * C * 0.125);
      g.lineTo(C + Math.cos(a) * C, C + Math.sin(a) * C);
      g.stroke();
    }
    // a soft glowing centre mark
    const dot = g.createRadialGradient(C, C, 0, C, C, C * 0.125);
    dot.addColorStop(0, "rgba(199,125,255,0.55)");
    dot.addColorStop(1, "rgba(199,125,255,0)");
    g.fillStyle = dot;
    g.fillRect(0, 0, S, S);
  });
  for (const t of [color, glow]) t.anisotropy = 8;
  return { color, glow };
}

/** Background: soft nebula clouds, painted once onto the inside of a big sphere (the stars are points on top). */
function skyTexture() {
  const W = 2048;
  const H = 1024;
  return canvasTexture(W, H, (g) => {
    g.fillStyle = "#06071a";
    g.fillRect(0, 0, W, H);
    const clouds: [number, number, number, string][] = [
      [0.15, 0.62, 380, "rgba(122,60,220,0.22)"],
      [0.42, 0.7, 300, "rgba(30,120,220,0.2)"],
      [0.66, 0.6, 420, "rgba(220,50,140,0.14)"],
      [0.88, 0.72, 320, "rgba(40,200,220,0.13)"],
      [0.3, 0.35, 260, "rgba(90,70,200,0.12)"],
      [0.75, 0.3, 280, "rgba(200,80,200,0.1)"],
    ];
    for (const [u, v, r, c] of clouds)
      for (const dx of [-W, 0, W]) {
        // drawn three times so the cloud wraps across the seam
        const grad = g.createRadialGradient(u * W + dx, v * H, 0, u * W + dx, v * H, r);
        grad.addColorStop(0, c);
        grad.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = grad;
        g.fillRect(0, 0, W, H);
      }
  });
}

/** A soft round dot, for the floating motes. */
function dotTexture() {
  return canvasTexture(64, 64, (g) => {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.3, "rgba(255,255,255,0.5)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  });
}

const MOTES = 70;
const BLOB_GEO = new THREE.PlaneGeometry(RULES.ballRadius * 3, RULES.ballRadius * 3).rotateX(-Math.PI / 2);
let blobMaterial: THREE.MeshBasicMaterial | null = null;
const blobMat = () =>
  (blobMaterial ??= new THREE.MeshBasicMaterial({
    map: canvasTexture(64, 64, (g) => {
      const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, "rgba(0,0,0,0.7)");
      grad.addColorStop(0.5, "rgba(0,0,0,0.35)");
      grad.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
    }),
    transparent: true,
    depthWrite: false,
  }));
const SQ = new THREE.Matrix4();
const BLACK = new THREE.MeshBasicMaterial({ color: "#000000" });
const ORIGIN = new THREE.Vector3();

type Fx = { mesh: THREE.Mesh; life: number; max: number; grow: number; fade: number };

type Snap = { at: number; tick: number; arena: number; balls: { x: number; y: number; vx: number; vy: number; alive: boolean; dashIn: number }[]; b?: BattleSnap; r?: RaceSnap };

export const WEAPON_ICON = ["🔨", "⚡", "🧲", "🦔", "🚀", "💣"];
export const WEAPON_NAME = ["Hammer", "Laser rifle", "Magnet", "Spike shell", "Homing rocket", "Mines"];

const iconTextures = new Map<string, THREE.Texture>();
function iconTexture(emoji: string) {
  let t = iconTextures.get(emoji);
  if (!t) {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    g.font = "48px system-ui, 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(emoji, 32, 36);
    t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    iconTextures.set(emoji, t);
  }
  return t;
}

/** Keeps one mesh per live object id (crates, shots, mines), adding and removing as they come and go. */
class Pool {
  meshes = new Map<number, THREE.Object3D>();
  constructor(private parent: THREE.Object3D, private make: () => THREE.Object3D) {}
  sync(flat: number[], stride: number, place: (m: THREE.Object3D, d: number[], i: number) => void) {
    const seen = new Set<number>();
    for (let i = 0; i + stride <= flat.length; i += stride) {
      const id = flat[i];
      seen.add(id);
      let m = this.meshes.get(id);
      if (!m) {
        m = this.make();
        this.meshes.set(id, m);
        this.parent.add(m);
      }
      place(m, flat, i);
    }
    for (const [id, m] of this.meshes)
      if (!seen.has(id)) {
        this.parent.remove(m);
        this.meshes.delete(id);
      }
  }
  clear() {
    for (const m of this.meshes.values()) this.parent.remove(m);
    this.meshes.clear();
  }
}

/** Index of each id's position in a flat [id, x, y, ...] list. */
function byId(flat: number[] | undefined, stride: number) {
  const m = new Map<number, number>();
  if (flat) for (let i = 0; i + stride <= flat.length; i += stride) m.set(flat[i], i);
  return m;
}



export class ArenaView {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
  private platform: THREE.Mesh;
  private rim: THREE.Mesh;
  private balls: THREE.Mesh[] = [];
  private falling = new Map<number, { y: number; vy: number; x: number; z: number; vx: number; vz: number }>();
  private marker: THREE.Mesh;
  private snaps: Snap[] = [];
  private sparks: { mesh: THREE.Mesh; v: THREE.Vector3; life: number }[] = [];
  private fx: Fx[] = [];
  private trails = new Map<number, number>(); // seat -> seconds of dash trail left
  private trailGap = 0;
  private raf = 0;
  private zoom = 1;
  private skins: string[] = [];
  you: number | null = null;
  players = 0;
  battle = false; // weapons on (battle and race)
  race = false;
  // battle mode
  private arenaGroup = new THREE.Group();
  private gear = new THREE.Group(); // crates, shots and mines (battle and race)
  // race mode
  private trackGroup = new THREE.Group();
  private sun!: THREE.DirectionalLight;
  private focus = new THREE.Vector3();
  private rimGlow: THREE.Mesh;
  private sky: THREE.Mesh;
  private motes: THREE.Points;
  private moteSeed: Float32Array;
  private composer: EffectComposer | null = null; // soft glow; null on weak devices
  private bloomComposer: EffectComposer | null = null; // renders only the glowing parts (balls blacked out)
  private darkened = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private slowFrames = 0;
  private blobs: THREE.Mesh[] = [];
  private squash = new Map<number, { t: number; max: number; amt: number; dx: number; dz: number }>();
  private confetti: { mesh: THREE.Mesh; v: THREE.Vector3; spin: THREE.Vector3; life: number }[] = [];
  private gone = new Set<number>(); // knocked out (popped, not fallen)
  private bars: { bg: THREE.Sprite; fill: THREE.Sprite; icon: THREE.Sprite }[] = [];
  private hammers: THREE.Group[] = [];
  private spikes: THREE.Group[] = [];
  private magnets: THREE.Mesh[] = [];
  private crates!: Pool;
  private lasers!: Pool;
  private rockets!: Pool;
  private mines!: Pool;
  private mineMats: THREE.MeshStandardMaterial[] = [];
  private laserMats: { core: THREE.MeshBasicMaterial; glow: THREE.MeshBasicMaterial }[] = [];
  private hole!: THREE.Mesh;
  private holeRim!: THREE.Mesh;

  constructor(private canvas: HTMLCanvasElement, public interpMs = 90) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;

    this.scene.background = new THREE.Color("#0b0d1a");
    this.scene.fog = new THREE.Fog("#0b0d1a", 30, 70);

    this.camera.position.set(0, 21, 17);
    this.camera.lookAt(0, -1, 1);

    this.scene.add(new THREE.HemisphereLight("#b7c4ff", "#1a1030", 0.9));
    const sun = (this.sun = new THREE.DirectionalLight("#ffffff", 2.2));
    sun.position.set(-8, 20, 6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const sc = sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = sc.bottom = -14;
    sc.right = sc.top = 14;
    this.scene.add(sun, sun.target);

    // platform: unit-radius cylinder scaled to the arena size each frame
    const floor = floorTextures();
    const top = new THREE.MeshStandardMaterial({ map: floor.color, emissiveMap: floor.glow, emissive: "#ffffff", emissiveIntensity: 1.4, roughness: 0.22, metalness: 0.35 });
    const side = new THREE.MeshStandardMaterial({ color: "#0e1130", roughness: 0.5, metalness: 0.3, emissive: "#2a1650", emissiveIntensity: 0.6 });
    this.platform = new THREE.Mesh(new THREE.CylinderGeometry(1, 0.92, 1.2, 96, 1), [side, top, side]);
    this.platform.position.y = -0.6;
    this.platform.receiveShadow = true;
    this.scene.add(this.platform);

    // neon rim: a bright core and a wider soft halo; its colour heats up as the arena closes in
    this.rim = new THREE.Mesh(new THREE.TorusGeometry(1, 0.012, 8, 128), new THREE.MeshBasicMaterial({ color: "#5ee7ff" }));
    this.rim.rotation.x = Math.PI / 2;
    this.rim.position.y = 0.02;
    this.scene.add(this.rim);
    this.rimGlow = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.032, 8, 128),
      new THREE.MeshBasicMaterial({ color: "#5ee7ff", transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.rim.add(this.rimGlow);

    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(150, 48, 24),
      new THREE.MeshBasicMaterial({ map: skyTexture(), side: THREE.BackSide, fog: false, depthWrite: false }),
    );
    this.sky.renderOrder = -1;
    this.scene.add(this.sky);
    // stars as points so they stay round wherever the camera looks
    for (const [n, size, opacity] of [[1400, 1.6, 0.8], [160, 3, 1]]) {
      const pos = new Float32Array(n * 3);
      const col = new Float32Array(n * 3);
      const tint = new THREE.Color();
      for (let i = 0; i < n; i++) {
        const v = new THREE.Vector3().randomDirection().multiplyScalar(140);
        pos.set([v.x, v.y, v.z], i * 3);
        tint.set(Math.random() < 0.2 ? "#aac8ff" : Math.random() < 0.1 ? "#ffc8e6" : "#ffffff").multiplyScalar(0.4 + Math.random() * 0.6);
        col.set([tint.r, tint.g, tint.b], i * 3);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setAttribute("color", new THREE.BufferAttribute(col, 3));
      const stars = new THREE.Points(g, new THREE.PointsMaterial({ size, sizeAttenuation: false, vertexColors: true, transparent: true, opacity, fog: false, depthWrite: false }));
      stars.renderOrder = -1;
      this.sky.add(stars);
    }

    // a few specks of light drifting over the arena
    this.moteSeed = new Float32Array(MOTES * 4);
    for (let i = 0; i < this.moteSeed.length; i++) this.moteSeed[i] = Math.random();
    const mg = new THREE.BufferGeometry();
    mg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MOTES * 3), 3));
    this.motes = new THREE.Points(
      mg,
      new THREE.PointsMaterial({ map: dotTexture(), color: "#bfe9ff", size: 0.35, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.motes.frustumCulled = false;
    this.scene.add(this.motes);

    // soft studio reflections on the balls and the glossy floor
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.25;
    pmrem.dispose();

    // soft glow on bright things (rim, trails, sparks); skipped on phones and weak machines
    const coarse = matchMedia("(pointer: coarse)").matches;
    if (!coarse && (navigator.hardwareConcurrency ?? 4) >= 4) {
      // glow is worked out on a copy of the frame with the balls blacked out, then added on top,
      // so the rim, trails and sparks glow but the players don't
      const bc = new EffectComposer(this.renderer);
      bc.renderToScreen = false;
      bc.addPass(new RenderPass(this.scene, this.camera));
      bc.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.3, 0.35, 0.88));
      const c = new EffectComposer(this.renderer);
      c.addPass(new RenderPass(this.scene, this.camera));
      const mix = new ShaderPass(
        new THREE.ShaderMaterial({
          uniforms: { baseTexture: { value: null }, bloomTexture: { value: bc.renderTarget2.texture } },
          vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
          fragmentShader:
            "uniform sampler2D baseTexture; uniform sampler2D bloomTexture; varying vec2 vUv; void main() { gl_FragColor = texture2D(baseTexture, vUv) + vec4(texture2D(bloomTexture, vUv).rgb, 0.0); }",
        }),
        "baseTexture",
      );
      mix.needsSwap = true;
      c.addPass(mix);
      c.addPass(new OutputPass());
      this.bloomComposer = bc;
      this.composer = c;
    }

    this.marker = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.6, 16), new THREE.MeshBasicMaterial({ color: "#ffffff" }));
    this.marker.rotation.x = Math.PI;
    this.marker.visible = false;
    this.scene.add(this.marker);

    this.buildBattleArena();
    this.buildTrack();
    addEventListener("resize", () => this.resize());
    this.resize();
  }

  private buildBattleArena() {
    const g = this.arenaGroup;
    g.visible = false;
    this.scene.add(g);
    const R = BATTLE.arena;
    // a solid-looking barrier: metal panels with glowing seams, a bright top rail and a lit base
    const H = 1.3;
    const panels = canvasTexture(128, 64, (c) => {
      const grad = c.createLinearGradient(0, 0, 0, 64);
      grad.addColorStop(0, "#5ee7ff");
      grad.addColorStop(0.08, "#0b1030");
      grad.addColorStop(0.85, "#0b1030");
      grad.addColorStop(1, "#2a8fb0");
      c.fillStyle = grad;
      c.fillRect(0, 0, 128, 64);
      c.fillStyle = "#5ee7ff";
      c.fillRect(0, 0, 3, 64); // seam between panels
      c.fillStyle = "rgba(94,231,255,0.35)";
      c.fillRect(20, 26, 88, 2); // a faint stripe across each panel
    });
    panels.wrapS = THREE.RepeatWrapping;
    panels.repeat.set(40, 1);
    const wall = new THREE.Mesh(
      new THREE.CylinderGeometry(R + 0.15, R + 0.15, H, 120, 1, true),
      new THREE.MeshStandardMaterial({ color: "#26305e", metalness: 0.5, roughness: 0.35, emissiveMap: panels, emissive: "#ffffff", emissiveIntensity: 0.45, transparent: true, opacity: 0.82, side: THREE.DoubleSide, depthWrite: false }),
    );
    wall.position.y = H / 2;
    g.add(wall);
    const rail = new THREE.MeshBasicMaterial({ color: new THREE.Color("#7af0ff").multiplyScalar(0.55) });
    const top = new THREE.Mesh(new THREE.TorusGeometry(R + 0.15, 0.1, 8, 128), rail);
    top.rotation.x = Math.PI / 2;
    top.position.y = H;
    g.add(top);
    const base = new THREE.Mesh(new THREE.TorusGeometry(R + 0.1, 0.05, 6, 128), rail);
    base.rotation.x = Math.PI / 2;
    base.position.y = 0.03;
    g.add(base);
    this.hole = new THREE.Mesh(new THREE.CircleGeometry(1, 64), new THREE.MeshBasicMaterial({ color: "#020208" }));
    this.hole.rotation.x = -Math.PI / 2;
    this.hole.position.y = 0.015;
    g.add(this.hole);
    this.holeRim = new THREE.Mesh(new THREE.TorusGeometry(1, 0.025, 8, 96), new THREE.MeshBasicMaterial({ color: "#ff9f1c" }));
    this.holeRim.rotation.x = Math.PI / 2;
    this.holeRim.position.y = 0.03;
    g.add(this.holeRim);

    const crateMat = new THREE.MeshStandardMaterial({ color: "#ffb703", emissive: "#a35f00", emissiveIntensity: 0.6, roughness: 0.4 });
    const crateGeo = new THREE.BoxGeometry(1, 1, 1);
    const qMat = new THREE.SpriteMaterial({ map: iconTexture("❓"), depthWrite: false });
    this.scene.add(this.gear);
    this.gear.visible = false;
    this.crates = new Pool(this.gear, () => {
      const m = new THREE.Mesh(crateGeo, crateMat);
      m.castShadow = true;
      const q = new THREE.Sprite(qMat);
      q.scale.setScalar(0.8);
      q.position.y = 1.1;
      const grp = new THREE.Group();
      grp.add(m, q);
      return grp;
    });
    // laser shots: a bright bolt with a soft sheath, pointed the way it's flying
    const boltGeo = new THREE.CapsuleGeometry(0.11, 0.7, 4, 12).rotateZ(Math.PI / 2);
    const sheathGeo = new THREE.CapsuleGeometry(0.24, 0.85, 4, 12).rotateZ(Math.PI / 2);
    // each player's shots are their ball colour
    this.laserMats = COLORS.map((c) => ({
      core: new THREE.MeshBasicMaterial({ color: new THREE.Color(c).lerp(new THREE.Color("#ffffff"), 0.3) }),
      glow: new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }),
    }));
    this.lasers = new Pool(this.gear, () => {
      const m = new THREE.Mesh(boltGeo, this.laserMats[0].core);
      m.add(new THREE.Mesh(sheathGeo, this.laserMats[0].glow));
      return m;
    });

    // homing rocket: white body, red nose and fins, metal nozzle and a flickering flame; points along +x
    const lathe = (pts: [number, number][], seg = 20) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg).rotateZ(-Math.PI / 2);
    const bodyGeo = lathe([[0, -0.42], [0.15, -0.42], [0.19, -0.36], [0.19, 0.16]]);
    const noseGeo = lathe([[0.19, 0.16], [0.17, 0.3], [0.12, 0.42], [0.05, 0.5], [0, 0.52]]);
    const bandGeo = lathe([[0.195, -0.06], [0.195, 0.04]]);
    const nozzleGeo = lathe([[0.1, -0.42], [0.14, -0.56], [0.11, -0.56], [0.07, -0.44]], 16);
    const fin = new THREE.Shape();
    fin.moveTo(0, 0);
    fin.lineTo(0.26, 0);
    fin.lineTo(0.02, 0.24);
    fin.lineTo(-0.06, 0.24);
    fin.closePath();
    const finGeo = new THREE.ExtrudeGeometry(fin, { depth: 0.03, bevelEnabled: false }).translate(-0.42, 0.17, -0.015);
    const flameGeo = new THREE.ConeGeometry(0.13, 0.55, 12, 1, true).rotateZ(Math.PI / 2).translate(-0.82, 0, 0);
    const flameCoreGeo = new THREE.ConeGeometry(0.06, 0.3, 10, 1, true).rotateZ(Math.PI / 2).translate(-0.7, 0, 0);
    const white = new THREE.MeshStandardMaterial({ color: "#f1f3f5", metalness: 0.3, roughness: 0.35 });
    const red = new THREE.MeshStandardMaterial({ color: "#e63946", metalness: 0.2, roughness: 0.4 });
    const darkRed = new THREE.MeshStandardMaterial({ color: "#9d0208", metalness: 0.2, roughness: 0.45, side: THREE.DoubleSide });
    const steel = new THREE.MeshStandardMaterial({ color: "#6c757d", metalness: 0.9, roughness: 0.3, side: THREE.DoubleSide });
    const flameMat = new THREE.MeshBasicMaterial({ color: "#ff8c1a", transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const flameCoreMat = new THREE.MeshBasicMaterial({ color: "#fff3b0", transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.rockets = new Pool(this.gear, () => {
      const m = new THREE.Group();
      const body = new THREE.Group(); // rolls slowly around its own axis
      body.name = "body";
      body.add(new THREE.Mesh(bodyGeo, white), new THREE.Mesh(noseGeo, red), new THREE.Mesh(bandGeo, red), new THREE.Mesh(nozzleGeo, steel));
      for (let k = 0; k < 4; k++) {
        const f = new THREE.Mesh(finGeo, darkRed);
        f.rotation.x = (k / 4) * Math.PI * 2;
        body.add(f);
      }
      body.traverse((o) => ((o as THREE.Mesh).isMesh && ((o as THREE.Mesh).castShadow = true)));
      const flame = new THREE.Mesh(flameGeo, flameMat);
      flame.name = "flame";
      flame.add(new THREE.Mesh(flameCoreGeo, flameCoreMat));
      m.add(body, flame);
      m.scale.setScalar(1.15);
      return m;
    });

    // landmine: a dark metal dome with studs, a ring in the owner's colour and a blinking light on top
    const domeGeo = new THREE.LatheGeometry(
      [[0, 0], [0.56, 0], [0.56, 0.05], [0.5, 0.12], [0.38, 0.2], [0.2, 0.25], [0, 0.26]].map(([r, y]) => new THREE.Vector2(r, y)),
      28,
    );
    const ringGeo = new THREE.TorusGeometry(0.5, 0.035, 8, 40).rotateX(Math.PI / 2).translate(0, 0.1, 0);
    const studGeo = new THREE.CylinderGeometry(0.045, 0.055, 0.07, 8);
    const capGeo = new THREE.CylinderGeometry(0.11, 0.13, 0.06, 16).translate(0, 0.28, 0);
    const lightGeo = new THREE.SphereGeometry(0.075, 12, 8).translate(0, 0.34, 0);
    const shell = new THREE.MeshStandardMaterial({ color: "#2b2d42", metalness: 0.7, roughness: 0.4 });
    const studMat = new THREE.MeshStandardMaterial({ color: "#adb5bd", metalness: 0.9, roughness: 0.25 });
    // each mine's ring is the colour of whoever dropped it
    this.mineMats = COLORS.map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.4, emissive: c, emissiveIntensity: 0.6 }));
    const lightMat = new THREE.MeshBasicMaterial({ color: "#ff2e2e" });
    this.mines = new Pool(this.gear, () => {
      const m = new THREE.Group();
      const dome = new THREE.Mesh(domeGeo, shell);
      dome.castShadow = true;
      const ring = new THREE.Mesh(ringGeo, this.mineMats[0]);
      ring.name = "ring";
      m.add(dome, ring, new THREE.Mesh(capGeo, studMat));
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        const st = new THREE.Mesh(studGeo, studMat);
        st.position.set(Math.cos(a) * 0.3, 0.23, Math.sin(a) * 0.3);
        m.add(st);
      }
      const light = new THREE.Mesh(lightGeo, lightMat);
      light.name = "light";
      m.add(light);
      return m;
    });
  }

  /** Race mode: the track as a ribbon along its centre line, with glowing edges and a chequered start line. */
  private buildTrack() {
    const g = this.trackGroup;
    g.visible = false;
    this.scene.add(g);
    const N = TRACK.length;
    const W = RACE.halfWidth;
    // one strip of quads between two offsets from the centre line, at heights y0 (inner) and y1 (outer)
    const strip = (o0: number, o1: number, y0: number, y1: number, mat: THREE.Material, every = 1, len = 1) => {
      const pos: number[] = [];
      const idx: number[] = [];
      for (let i = 0; i < N; i += every) {
        for (let j = 0; j <= len; j++) {
          const p = TRACK[(i + j) % N];
          const nx = -p.ty;
          const ny = p.tx;
          pos.push(p.x + nx * o0, y0, p.y + ny * o0, p.x + nx * o1, y1, p.y + ny * o1);
        }
        const base = (pos.length / 3) - (len + 1) * 2;
        for (let j = 0; j < len; j++) {
          const a = base + j * 2;
          idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, mat);
      g.add(m);
      return m;
    };
    const top = new THREE.MeshStandardMaterial({ color: "#1a1f48", roughness: 0.25, metalness: 0.35, side: THREE.DoubleSide });
    const side = new THREE.MeshStandardMaterial({ color: "#0e1130", roughness: 0.5, metalness: 0.3, emissive: "#2a1650", emissiveIntensity: 0.6, side: THREE.DoubleSide });
    strip(-W, W, 0, 0, top, N, N).receiveShadow = true;
    strip(W, W - 0.3, 0, -1.2, side, N, N);
    strip(-W, -W + 0.3, 0, -1.2, side, N, N);
    const edge = new THREE.MeshBasicMaterial({ color: new THREE.Color("#ff3d7f").multiplyScalar(1.8), side: THREE.DoubleSide });
    strip(W - 0.14, W + 0.02, 0.02, 0.02, edge, N, N);
    strip(-W + 0.14, -W - 0.02, 0.02, 0.02, edge, N, N);
    // centre dashes so speed reads well
    strip(-0.08, 0.08, 0.015, 0.015, new THREE.MeshBasicMaterial({ color: "#3a4080", side: THREE.DoubleSide }), 8, 3);
    // chequered start / finish line
    const c = document.createElement("canvas");
    c.width = 16;
    c.height = 128;
    const cx = c.getContext("2d")!;
    for (let y = 0; y < 16; y++) for (let x = 0; x < 2; x++) {
      cx.fillStyle = (x + y) % 2 ? "#111" : "#c8c8c8";
      cx.fillRect(x * 8, y * 8, 8, 8);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.NearestFilter;
    const line = new THREE.Mesh(new THREE.PlaneGeometry(1.2, W * 2), new THREE.MeshBasicMaterial({ map: tex }));
    line.rotation.x = -Math.PI / 2;
    const holder = new THREE.Group();
    holder.add(line);
    holder.position.set(TRACK[0].x, 0.02, TRACK[0].y);
    holder.rotation.y = -Math.atan2(TRACK[0].ty, TRACK[0].tx);
    g.add(holder);
  }

  /** Race standings from the newest snapshot: laps done (fractional) per seat. */
  raceInfo(seat: number) {
    const r = this.snaps[this.snaps.length - 1]?.r;
    if (!r) return null;
    const mine = r.p[seat] ?? 0;
    return { lap: Math.min(RACE.laps, Math.max(1, Math.floor(mine) + 1)), laps: RACE.laps, place: 1 + r.p.filter((p, i) => i !== seat && p > mine).length, of: r.p.length };
  }

  /** Per-ball battle gear: HP bar, weapon icon, hammer, spikes, magnet ring. */
  private buildFighters(n: number) {
    for (const b of this.bars) this.scene.remove(b.bg, b.fill, b.icon);
    for (const h of this.hammers) this.scene.remove(h);
    for (const m of this.magnets) this.scene.remove(m);
    this.bars = [];
    this.hammers = [];
    this.spikes = [];
    this.magnets = [];
    for (const p of [this.crates, this.lasers, this.rockets, this.mines]) p.clear();
    if (!this.battle) return;
    const spikeGeo = new THREE.ConeGeometry(0.16, 0.55, 8);
    const spikeMat = new THREE.MeshStandardMaterial({ color: "#e9ecef", metalness: 0.6, roughness: 0.3 });
    const handleMat = new THREE.MeshStandardMaterial({ color: "#a0672f", roughness: 0.6 });
    const headMat = new THREE.MeshStandardMaterial({ color: "#c9ced6", metalness: 0.9, roughness: 0.28 });
    const faceMat = new THREE.MeshStandardMaterial({ color: "#5c636b", metalness: 0.95, roughness: 0.35 });
    const gripMat = new THREE.MeshStandardMaterial({ color: "#3d2314", roughness: 0.8 });
    for (let i = 0; i < n; i++) {
      const bg = new THREE.Sprite(new THREE.SpriteMaterial({ color: "#000000", opacity: 0.55, transparent: true, depthTest: false }));
      const fill = new THREE.Sprite(new THREE.SpriteMaterial({ color: "#3ddc97", depthTest: false }));
      const icon = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false }));
      bg.scale.set(1.7, 0.2, 1);
      fill.scale.set(1.6, 0.13, 1);
      icon.scale.setScalar(0.9);
      bg.renderOrder = 10;
      fill.renderOrder = 11;
      icon.renderOrder = 11;
      icon.visible = false;
      this.scene.add(bg, fill, icon);
      this.bars.push({ bg, fill, icon });

      const H = BATTLE.hammer;
      const hammer = new THREE.Group();
      // wooden handle with a leather grip, a steel collar and a rounded steel head with darker striking faces
      const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.11, H.reach, 14), handleMat);
      handle.rotation.z = Math.PI / 2;
      handle.position.x = H.reach / 2;
      const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.125, 0.125, 0.55, 14), gripMat);
      grip.rotation.z = Math.PI / 2;
      grip.position.x = RULES.ballRadius + 0.35;
      const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.22, 16), faceMat);
      collar.rotation.z = Math.PI / 2;
      collar.position.x = H.reach - H.head * 0.62;
      const head = new THREE.Mesh(new RoundedBoxGeometry(H.head * 1.15, H.head * 1.15, H.head * 1.9, 3, 0.09), headMat);
      head.position.x = H.reach;
      head.castShadow = true;
      for (const side of [-1, 1]) {
        const face = new THREE.Mesh(new THREE.CylinderGeometry(H.head * 0.5, H.head * 0.56, 0.16, 24), faceMat);
        face.rotation.x = Math.PI / 2;
        face.position.set(H.reach, 0, side * H.head * 1.0);
        hammer.add(face);
      }
      hammer.add(handle, grip, collar, head);
      hammer.visible = false;
      this.scene.add(hammer);
      this.hammers.push(hammer);

      const spikes = new THREE.Group();
      const dirs = [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0)];
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        dirs.push(new THREE.Vector3(Math.cos(a), k % 2 ? 0.45 : -0.45, Math.sin(a)).normalize());
      }
      for (const d of dirs) {
        const c = new THREE.Mesh(spikeGeo, spikeMat);
        c.position.copy(d).multiplyScalar(RULES.ballRadius + 0.15);
        c.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
        spikes.add(c);
      }
      spikes.visible = false;
      this.balls[i]?.add(spikes);
      this.spikes.push(spikes);

      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(1, 0.05, 6, 64),
        new THREE.MeshBasicMaterial({ color: "#c77dff", transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.visible = false;
      this.scene.add(ring);
      this.magnets.push(ring);
    }
  }

  /** Position the battle gear from the newest snapshot (shots are interpolated by id). */
  private drawBattle(a: BattleSnap, b: BattleSnap, k: number, now: number) {
    this.hole.scale.setScalar(b.hole);
    this.holeRim.scale.set(b.hole, b.hole, 1);
    this.balls.forEach((m, i) => {
      const bar = this.bars[i];
      if (!bar) return;
      const out = this.gone.has(i) || this.falling.has(i);
      const hp = Math.max(0, b.hp[i] ?? 0) / BATTLE.hp;
      const p = m.position;
      bar.bg.visible = bar.fill.visible = !out;
      bar.bg.position.set(p.x, p.y + 1.6, p.z);
      bar.fill.position.copy(bar.bg.position);
      const w = Math.max(0.01, hp);
      bar.fill.scale.x = 1.6 * w;
      bar.fill.center.set(0.5 / w, 0.5); // keep the bar's left end fixed as it empties
      (bar.fill.material as THREE.SpriteMaterial).color.setHSL(0.33 * hp, 0.85, 0.5);
      const wi = b.w[i];
      bar.icon.visible = !out && wi >= 0;
      if (wi >= 0) {
        const mat = bar.icon.material as THREE.SpriteMaterial;
        const tex = iconTexture(WEAPON_ICON[wi]);
        if (mat.map !== tex) {
          mat.map = tex;
          mat.needsUpdate = true;
        }
        bar.icon.position.set(p.x + 1.25, p.y + 1.6, p.z);
      }
      const on = !out && b.on[i] > 0;
      const weapon = WEAPONS[wi];
      const hammer = this.hammers[i];
      hammer.visible = on && weapon === "hammer";
      if (hammer.visible) {
        let da = b.ang[i] - a.ang[i];
        if (Math.abs(da) > Math.PI) da = 0;
        hammer.position.set(p.x, p.y, p.z);
        hammer.rotation.y = -(a.ang[i] + da * k);
      }
      this.spikes[i].visible = on && weapon === "spikes";
      const ring = this.magnets[i];
      ring.visible = on && weapon === "magnet";
      if (ring.visible) {
        const r = BATTLE.magnet.pull * (1 - ((now / 500) % 1));
        ring.scale.set(Math.max(0.3, r), Math.max(0.3, r), 1);
        ring.position.set(p.x, 0.1, p.z);
      }
    });
    const t = now / 1000;
    this.crates.sync(b.c, 3, (m, d, i) => {
      m.position.set(d[i + 1], 0.6 + Math.sin(t * 3 + d[i]) * 0.12, d[i + 2]);
      m.children[0].rotation.y = t * 1.5 + d[i];
    });
    const lerp = (prev: Map<number, number>, pa: number[], d: number[], i: number) => {
      const j = prev.get(d[i]);
      return j === undefined ? [d[i + 1], d[i + 2]] : [pa[j + 1] + (d[i + 1] - pa[j + 1]) * k, pa[j + 2] + (d[i + 2] - pa[j + 2]) * k];
    };
    const prevL = byId(a.l, 4);
    this.lasers.sync(b.l, 4, (m, d, i) => {
      const [x, z] = lerp(prevL, a.l, d, i);
      const dx = x - m.position.x;
      const dz = z - m.position.z;
      if (dx * dx + dz * dz > 1e-6 && m.position.y > 0) m.rotation.y = -Math.atan2(dz, dx); // face the way it's going
      m.position.set(x, 0.7, z);
      const mats = this.laserMats[d[i + 3] % this.laserMats.length];
      (m as THREE.Mesh).material = mats.core;
      (m.children[0] as THREE.Mesh).material = mats.glow;
    });
    const prevR = byId(a.r, 4);
    this.rockets.sync(b.r, 4, (m, d, i) => {
      const [x, z] = lerp(prevR, a.r, d, i);
      m.position.set(x, 0.8, z);
      m.rotation.y = -d[i + 3];
      m.getObjectByName("body")!.rotation.x = t * 4;
      const flame = m.getObjectByName("flame")!;
      flame.scale.set(0.8 + Math.random() * 0.45, 0.9 + Math.random() * 0.2, 0.9 + Math.random() * 0.2);
    });
    this.mines.sync(b.m, 5, (m, d, i) => {
      m.position.set(d[i + 1], 0, d[i + 2]);
      (m.getObjectByName("ring") as THREE.Mesh).material = this.mineMats[d[i + 4] % this.mineMats.length];
      const light = m.getObjectByName("light")!;
      light.visible = d[i + 3] === 0 || Math.sin(t * 12) > 0; // blinks once armed
    });
  }

  /** Something took damage: red sparks where it happened. */
  hit(x: number, y: number, dmg: number) {
    this.burst(new THREE.Vector3(x, 0.8, y), Math.min(16, 3 + Math.round(dmg / 3)), ["#ff4d6d", "#ffd6a5"], 8, 0.45);
  }

  /** An explosion (rocket, mine, magnet fling): a flash that grows and fades, plus sparks. */
  boom(x: number, y: number, r: number) {
    const at = new THREE.Vector3(x, 0.6, y);
    const ball = new THREE.Mesh(GHOST_GEO, new THREE.MeshBasicMaterial({ color: "#ffd166", transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    ball.position.copy(at);
    ball.scale.setScalar(0.3);
    this.scene.add(ball);
    this.fx.push({ mesh: ball, life: 0.3, max: 0.3, grow: r * 3.5, fade: 0.9 });
    this.burst(at, 14, ["#ffbe0b", "#fb5607", "#ffffff"], 12, 0.6);
  }

  /** A ball ran out of HP: it pops instead of falling. */
  ko(seat: number) {
    const m = this.balls[seat];
    if (!m) return;
    this.gone.add(seat);
    this.burst(m.position.clone(), 24, [COLORS[seat % COLORS.length], "#ffffff"], 12, 0.7);
    this.koRing(m.position.x, m.position.z, seat);
    m.visible = false;
  }

  setPlayers(n: number, you: number | null, battle = this.battle, race = false) {
    this.players = n;
    this.you = you;
    this.battle = battle || race;
    this.race = race;
    this.focus.set(0, 0, 0); // the race camera snaps to you on the next frame
    battle = battle && !race; // from here on: the battle arena
    this.gone.clear();
    for (const b of this.balls) this.scene.remove(b);
    for (const b of this.blobs) this.scene.remove(b);
    this.balls = [];
    this.blobs = [];
    this.squash.clear();
    for (const c of this.confetti) this.scene.remove(c.mesh);
    this.confetti = [];
    this.falling.clear();
    this.snaps = [];
    for (let i = 0; i < n; i++) {
      const mat = new THREE.MeshPhysicalMaterial({ color: COLORS[i % COLORS.length], roughness: 0.3, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.12 });
      const m = new THREE.Mesh(new THREE.SphereGeometry(RULES.ballRadius, 40, 28), mat);
      // a stripe so rolling is visible
      const band = new THREE.Mesh(
        new THREE.TorusGeometry(RULES.ballRadius * 0.999, 0.09, 8, 48),
        new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.4 }),
      );
      m.add(band);
      m.castShadow = true;
      const a = (i / n) * Math.PI * 2 + Math.PI / 4;
      m.position.set(Math.cos(a) * RULES.spawnRadius, RULES.ballRadius, Math.sin(a) * RULES.spawnRadius);
      this.scene.add(m);
      this.balls.push(m);
      const blob = new THREE.Mesh(BLOB_GEO, blobMat());
      blob.position.y = 0.012;
      this.scene.add(blob);
      this.blobs.push(blob);
    }
    const r = battle ? BATTLE.arena : RULES.arenaStart;
    this.platform.scale.set(r, 1, r);
    this.rim.scale.set(r, r, 1);
    this.platform.visible = !race;
    this.rim.visible = !battle && !race;
    this.arenaGroup.visible = battle;
    this.gear.visible = battle || race;
    this.trackGroup.visible = race;
    this.hole.scale.setScalar(BATTLE.hole);
    this.holeRim.scale.set(BATTLE.hole, BATTLE.hole, 1);
    if (battle)
      this.balls.forEach((m, i) => {
        const a = Math.atan2(m.position.z, m.position.x);
        m.position.set(Math.cos(a) * BATTLE.spawnRadius, RULES.ballRadius, Math.sin(a) * BATTLE.spawnRadius);
      });
    if (race)
      this.balls.forEach((m, i) => {
        const g = gridSpot(i);
        m.position.set(g.x, RULES.ballRadius, g.y);
      });
    const fog = this.scene.fog as THREE.Fog;
    fog.near = (race ? 40 : 30) * this.zoom;
    fog.far = (race ? 90 : 70) * this.zoom;
    this.buildFighters(n);
    this.applySkins();
  }

  /** Skin file per seat ("" keeps the seat's plain colour). */
  setSkins(skins: string[]) {
    if (skins.join("|") === this.skins.join("|")) return;
    this.skins = [...skins];
    this.applySkins();
  }

  private applySkins() {
    this.balls.forEach((m, i) => {
      const file = this.skins[i] || "";
      const mat = m.material as THREE.MeshPhysicalMaterial;
      const band = m.children[0] as THREE.Mesh | undefined;
      mat.map = file ? skinTexture(file) : null;
      mat.color.set(file ? "#ffffff" : COLORS[i % COLORS.length]);
      mat.needsUpdate = true;
      if (band) band.visible = !file; // the picture already shows the roll
    });
  }

  pushSnapshot(d: number[], battle?: BattleSnap, race?: RaceSnap) {
    const balls = [];
    for (let i = 2; i + SNAP_STRIDE <= d.length; i += SNAP_STRIDE) {
      balls.push({ x: d[i], y: d[i + 1], vx: d[i + 2], vy: d[i + 3], alive: d[i + 4] === 1, dashIn: d[i + 5] });
    }
    this.snaps.push({ at: performance.now(), tick: d[0], arena: d[1], balls, b: battle, r: race });
    if (this.snaps.length > 30) this.snaps.shift();
  }

  /** Your HP, weapon and how long a running weapon has left, from the newest snapshot. */
  fighter(seat: number) {
    const b = this.snaps[this.snaps.length - 1]?.b;
    return b ? { hp: b.hp[seat], weapon: b.w[seat], ammo: b.n[seat], on: b.on[seat] } : null;
  }

  dashReadyIn(seat: number): number {
    const s = this.snaps[this.snaps.length - 1];
    return s ? s.balls[seat]?.dashIn ?? 0 : 0;
  }

  bump(a: number, b: number, force: number) {
    const mid = this.mid(a, b);
    if (!mid) return;
    this.burst(mid, Math.min(14, 4 + Math.round(force)), ["#fff3b0"], 10, 0.5);
    // both balls squash a little along the line between them
    const A = this.balls[a].position;
    const B = this.balls[b].position;
    const dx = B.x - A.x;
    const dz = B.z - A.z;
    const l = Math.hypot(dx, dz) || 1;
    const amt = Math.min(0.24, 0.06 + force * 0.015);
    for (const s of [a, b]) this.squash.set(s, { t: 0.2, max: 0.2, amt, dx: dx / l, dz: dz / l });
  }

  /** A ring of light where a ball went out, in its colour. */
  private koRing(x: number, z: number, seat: number) {
    const c = COLORS[seat % COLORS.length];
    const ring = new THREE.Mesh(KO_RING_GEO, new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(1.5), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    ring.position.set(x, 0.06, z);
    ring.scale.setScalar(0.4);
    this.scene.add(ring);
    this.fx.push({ mesh: ring, life: 0.6, max: 0.6, grow: 5, fade: 0.9 });
    this.burst(new THREE.Vector3(x, 0.3, z), 10, [c, "#ffffff"], 7, 0.45);
  }

  /** The match is won: a short burst of confetti around the winner's ball. */
  celebrate(seat: number) {
    const m = this.balls[seat];
    if (!m) return;
    const colors = [COLORS[seat % COLORS.length], "#ffffff", "#ffd166"];
    const at = this.falling.has(seat) || this.gone.has(seat) ? new THREE.Vector3(0, 0, 0) : m.position;
    for (let i = 0; i < 70; i++) {
      const mesh = new THREE.Mesh(CONFETTI_GEO, confettiMat(colors[i % colors.length]));
      mesh.position.set(at.x + (Math.random() - 0.5) * 0.6, at.y + 0.5, at.z + (Math.random() - 0.5) * 0.6);
      mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      this.scene.add(mesh);
      const a = Math.random() * Math.PI * 2;
      const out = 1.5 + Math.random() * 3;
      this.confetti.push({
        mesh,
        v: new THREE.Vector3(Math.cos(a) * out, 7 + Math.random() * 5, Math.sin(a) * out),
        spin: new THREE.Vector3(Math.random() * 10 - 5, Math.random() * 10 - 5, Math.random() * 10 - 5),
        life: 2.2 + Math.random() * 1,
      });
    }
  }

  /** The ball starts a dash: a fading streak of afterimages behind it. */
  dash(seat: number) {
    if (this.balls[seat]) this.trails.set(seat, 0.35);
  }

  private mid(a: number, b: number) {
    const A = this.balls[a]?.position;
    const B = this.balls[b]?.position;
    return A && B ? A.clone().add(B).multiplyScalar(0.5) : null;
  }

  private burst(at: THREE.Vector3, n: number, colors: string[], speed: number, life: number) {
    for (let i = 0; i < n; i++) {
      const mesh = new THREE.Mesh(SPARK_GEO, sparkMat(colors[i % colors.length]));
      mesh.position.copy(at);
      this.scene.add(mesh);
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8 + 0.2, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.5 + Math.random() * 0.7));
      this.sparks.push({ mesh, v, life: life * (0.6 + Math.random() * 0.6) });
    }
  }




  start() {
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      this.update(now, dt);
      if (this.composer && this.bloomComposer) {
        this.darkenPlayers(true);
        this.bloomComposer.render(dt);
        this.darkenPlayers(false);
        this.composer.render(dt);
        // drop the glow if this device can't keep up with it
        this.slowFrames = dt > 1 / 40 ? this.slowFrames + 1 : Math.max(0, this.slowFrames - 1);
        if (this.slowFrames > 90) {
          this.composer.dispose();
          this.bloomComposer.dispose();
          this.composer = this.bloomComposer = null;
        }
      } else this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  /** Swap the balls (and the marker over yours) to plain black for the glow pass, and back. */
  private darkenPlayers(on: boolean) {
    if (on) {
      const hide = (o: THREE.Object3D) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          this.darkened.set(m, m.material);
          m.material = BLACK;
        }
      };
      for (const b of this.balls) b.traverse(hide);
      hide(this.marker);
    } else {
      for (const [m, mat] of this.darkened) m.material = mat;
      this.darkened.clear();
    }
  }

  stop() {
    cancelAnimationFrame(this.raf);
  }

  private update(now: number, dt: number) {
    const target = now - this.interpMs;
    let a = this.snaps[0];
    let b = this.snaps[0];
    for (let i = 0; i < this.snaps.length - 1; i++) {
      if (this.snaps[i].at <= target && this.snaps[i + 1].at >= target) {
        a = this.snaps[i];
        b = this.snaps[i + 1];
        break;
      }
      if (this.snaps[i + 1].at < target) a = b = this.snaps[i + 1];
    }
    if (a && b) {
      const k = b.at === a.at ? 1 : Math.min(1, Math.max(0, (target - a.at) / (b.at - a.at)));
      const arena = a.arena + (b.arena - a.arena) * k;
      this.platform.scale.set(arena, 1, arena);
      this.rim.scale.set(arena, arena, 1);
      // cyan at the start, through magenta, to a pulsing red as the edge closes in
      const heat = Math.min(1, Math.max(0, 1 - arena / RULES.arenaStart) * 1.35);
      const pulse = arena < 6 ? 0.5 + 0.5 * Math.sin(now / 120) : 0;
      const rc = (this.rim.material as THREE.MeshBasicMaterial).color;
      rc.setHSL((0.52 + 0.48 * heat) % 1, 1, 0.55).multiplyScalar(0.9 + 0.4 * heat + pulse * 0.8);
      (this.rimGlow.material as THREE.MeshBasicMaterial).color.copy(rc);

      b.balls.forEach((bb, i) => {
        const m = this.balls[i];
        if (!m) return;
        const ab = a.balls[i];
        if (this.gone.has(i)) return;
        if (this.race && bb.alive && this.falling.has(i)) {
          // race: back on the track after a fall
          this.falling.delete(i);
          m.position.set(bb.x, RULES.ballRadius, bb.y);
        }
        if (!bb.alive && !this.falling.has(i) && !(ab?.alive ?? true)) {
          this.falling.set(i, { x: bb.x, z: bb.y, y: RULES.ballRadius, vx: bb.vx, vz: bb.vy, vy: 0 });
          this.koRing(bb.x, bb.y, i);
        }
        if (this.falling.has(i)) return;
        const x = ab.x + (bb.x - ab.x) * k;
        const z = ab.y + (bb.y - ab.y) * k;
        const dx = x - m.position.x;
        const dz = z - m.position.z;
        m.position.set(x, RULES.ballRadius, z);
        // roll
        const dist = Math.hypot(dx, dz);
        if (dist > 1e-4) {
          const axis = new THREE.Vector3(dz, 0, -dx).normalize();
          m.rotateOnWorldAxis(axis, dist / RULES.ballRadius);
        }
        if (b.r?.sp[i]) m.rotateY(dt * 25); // spun out
      });
    }

    if (this.battle && b?.b) this.drawBattle(a.b ?? b.b, b.b, Math.min(1, Math.max(0, (target - a.at) / (b.at - a.at || 1))), now);

    for (const [i, f] of this.falling) {
      f.vy -= 30 * dt;
      f.x += f.vx * dt;
      f.z += f.vz * dt;
      f.y += f.vy * dt;
      this.balls[i]?.position.set(f.x, f.y, f.z);
    }

    // dash afterimages
    this.trailGap -= dt;
    const spawn = this.trailGap <= 0;
    if (spawn) this.trailGap = 0.025;
    for (const [seat, left] of this.trails) {
      const m = this.balls[seat];
      if (!m || left <= 0 || this.falling.has(seat)) {
        this.trails.delete(seat);
        continue;
      }
      this.trails.set(seat, left - dt);
      if (!spawn) continue;
      const ghost = new THREE.Mesh(GHOST_GEO, new THREE.MeshBasicMaterial({ color: COLORS[seat % COLORS.length], transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }));
      ghost.position.copy(m.position);
      this.scene.add(ghost);
      this.fx.push({ mesh: ghost, life: 0.22, max: 0.22, grow: -2.5, fade: 0.45 });
    }

    for (const f of this.fx) {
      f.life -= dt;
      const mat = f.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = Math.max(0, (f.life / f.max) * f.fade);
      f.mesh.scale.setScalar(Math.max(0.05, f.mesh.scale.x + f.grow * dt));
    }
    this.fx = this.fx.filter((f) => {
      if (f.life > 0) return true;
      this.scene.remove(f.mesh);
      (f.mesh.material as THREE.Material).dispose();
      return false;
    });

    for (const s of this.sparks) {
      s.v.y -= 25 * dt;
      s.mesh.position.addScaledVector(s.v, dt);
      s.life -= dt;
    }
    this.sparks = this.sparks.filter((s) => {
      if (s.life > 0) return true;
      this.scene.remove(s.mesh);
      return false;
    });

    // soft dark spot under each ball, so it sits on the glossy floor
    this.balls.forEach((m, i) => {
      const blob = this.blobs[i];
      if (!blob) return;
      blob.visible = m.visible && !this.falling.has(i) && !this.gone.has(i);
      blob.position.x = m.position.x;
      blob.position.z = m.position.z;
    });

    // squash: compress along the hit direction and bulge sideways, in world space so the roll doesn't twist it
    this.balls.forEach((m, i) => {
      const q = this.squash.get(i);
      if (q) q.t -= dt;
      if (!q || q.t <= 0) {
        if (q) this.squash.delete(i);
        m.matrixAutoUpdate = true;
        return;
      }
      const e = q.amt * Math.sin(Math.PI * (1 - q.t / q.max));
      const c = -e - e * 0.5;
      const { dx, dz } = q;
      SQ.set(1 + e * 0.5 + c * dx * dx, 0, c * dx * dz, 0, 0, 1 + e * 0.5, 0, 0, c * dx * dz, 0, 1 + e * 0.5 + c * dz * dz, 0, 0, 0, 0, 1);
      m.matrixAutoUpdate = false;
      m.matrix.makeRotationFromQuaternion(m.quaternion).premultiply(SQ).setPosition(m.position);
      m.matrixWorldNeedsUpdate = true;
    });

    for (const c of this.confetti) {
      c.v.y -= 9 * dt;
      c.v.multiplyScalar(1 - 1.8 * dt); // air drag, so it flutters down
      c.mesh.position.addScaledVector(c.v, dt);
      c.mesh.rotation.x += c.spin.x * dt;
      c.mesh.rotation.y += c.spin.y * dt;
      c.mesh.rotation.z += c.spin.z * dt;
      c.life -= dt;
    }
    this.confetti = this.confetti.filter((c) => {
      if (c.life > 0 && c.mesh.position.y > -3) return true;
      this.scene.remove(c.mesh);
      return false;
    });

    // motes drift in slow loops around whatever the camera is looking at
    const centre = this.race ? this.focus : ORIGIN;
    const mp = this.motes.geometry.attributes.position as THREE.BufferAttribute;
    const t = now / 1000;
    for (let i = 0; i < MOTES; i++) {
      const s = this.moteSeed;
      const a = s[i * 4] * Math.PI * 2 + t * (0.03 + s[i * 4 + 1] * 0.05);
      const r = 3 + s[i * 4 + 2] * 15;
      mp.setXYZ(i, centre.x + Math.cos(a) * r, 1 + s[i * 4 + 3] * 6 + Math.sin(t * 0.6 + i) * 0.4, centre.z + Math.sin(a) * r);
    }
    mp.needsUpdate = true;
    this.sky.position.copy(this.camera.position);
    this.sky.rotation.y = t * 0.004;

    if (this.you !== null && this.balls[this.you] && !this.falling.has(this.you)) {
      const p = this.balls[this.you].position;
      this.marker.visible = true;
      this.marker.position.set(p.x, p.y + 2 + Math.sin(now / 200) * 0.15, p.z);
    } else this.marker.visible = false;

    const z = this.zoom;
    if (this.race) {
      // follow your ball (or the leader when watching), without turning, so the controls stay screen-relative
      let seat = this.you;
      const r = b?.r;
      if ((seat === null || !this.balls[seat]) && r) seat = r.p.indexOf(Math.max(...r.p));
      const m = seat !== null ? this.balls[seat] : null;
      if (m) {
        // look a little ahead of where it's heading, so the bends come into view sooner
        const v = b?.balls[seat!];
        const want = new THREE.Vector3(m.position.x + (v?.vx ?? 0) * 0.5, 0, m.position.z + (v?.vy ?? 0) * 0.5);
        if (this.falling.has(seat!)) want.copy(this.focus); // hold still while it drops
        this.focus.lerp(want, this.focus.lengthSq() === 0 ? 1 : Math.min(1, dt * 4));
      }
      const f = this.focus;
      this.camera.position.set(f.x, 19 * z, f.z + 15 * z);
      this.camera.lookAt(f.x, -1, f.z + 1);
      this.sun.position.set(f.x - 8, 20, f.z + 6);
      this.sun.target.position.copy(f);
      return;
    }
    this.camera.position.set(0, 21 * z, 17 * z);
    this.camera.lookAt(0, -1, 1);
    this.sun.position.set(-8, 20, 6);
    this.sun.target.position.set(0, 0, 0);
  }

  private resize() {
    const w = this.canvas.clientWidth || innerWidth;
    const h = this.canvas.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer?.setPixelRatio(this.renderer.getPixelRatio());
    this.composer?.setSize(w, h);
    this.bloomComposer?.setPixelRatio(this.renderer.getPixelRatio());
    this.bloomComposer?.setSize(w, h);
    this.camera.aspect = w / h;
    // pull the camera back on narrow screens so the whole arena stays in view
    this.zoom = Math.max(1, 1.2 / this.camera.aspect);
    const fog = this.scene.fog as THREE.Fog;
    fog.near = (this.race ? 40 : 30) * this.zoom;
    fog.far = (this.race ? 90 : 70) * this.zoom;
    this.camera.updateProjectionMatrix();
  }
}
