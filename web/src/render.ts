// three.js view of the arena. Purely visual: positions come from server snapshots.
import * as THREE from "three";
import { SNAP_STRIDE, RULES } from "../../shared/physics";
import { BATTLE, WEAPONS, type BattleSnap } from "../../shared/battle";
import { COLORS } from "../../shared/config";

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

type Fx = { mesh: THREE.Mesh; life: number; max: number; grow: number; fade: number };

type Snap = { at: number; tick: number; arena: number; balls: { x: number; y: number; vx: number; vy: number; alive: boolean; dashIn: number }[]; b?: BattleSnap };

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
  battle = false;
  // battle mode
  private arenaGroup = new THREE.Group();
  private gone = new Set<number>(); // knocked out (popped, not fallen)
  private bars: { bg: THREE.Sprite; fill: THREE.Sprite; icon: THREE.Sprite }[] = [];
  private hammers: THREE.Group[] = [];
  private spikes: THREE.Group[] = [];
  private magnets: THREE.Mesh[] = [];
  private crates!: Pool;
  private lasers!: Pool;
  private rockets!: Pool;
  private mines!: Pool;
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
    const sun = new THREE.DirectionalLight("#ffffff", 2.2);
    sun.position.set(-8, 20, 6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const sc = sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = sc.bottom = -14;
    sc.right = sc.top = 14;
    this.scene.add(sun);

    // platform: unit-radius cylinder scaled to the arena size each frame
    const top = new THREE.MeshStandardMaterial({ color: "#2a2f55", roughness: 0.55, metalness: 0.1 });
    const side = new THREE.MeshStandardMaterial({ color: "#151834", roughness: 0.8 });
    this.platform = new THREE.Mesh(new THREE.CylinderGeometry(1, 0.92, 1.2, 96, 1), [side, top, side]);
    this.platform.position.y = -0.6;
    this.platform.receiveShadow = true;
    this.scene.add(this.platform);

    // floor grid lines so motion reads well
    const grid = new THREE.Mesh(
      new THREE.RingGeometry(0.2, 0.21, 64),
      new THREE.MeshBasicMaterial({ color: "#3a4080", side: THREE.DoubleSide }),
    );
    grid.rotation.x = -Math.PI / 2;
    grid.position.y = 0.01;
    this.platform.add(grid);
    for (const r of [0.45, 0.7]) {
      const g = grid.clone();
      g.geometry = new THREE.RingGeometry(r, r + 0.008, 96);
      this.platform.add(g);
    }

    this.rim = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.012, 8, 128),
      new THREE.MeshBasicMaterial({ color: "#ff3d7f" }),
    );
    this.rim.rotation.x = Math.PI / 2;
    this.rim.position.y = 0.02;
    this.scene.add(this.rim);

    this.marker = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.6, 16), new THREE.MeshBasicMaterial({ color: "#ffffff" }));
    this.marker.rotation.x = Math.PI;
    this.marker.visible = false;
    this.scene.add(this.marker);

    this.buildBattleArena();
    addEventListener("resize", () => this.resize());
    this.resize();
  }

  private buildBattleArena() {
    const g = this.arenaGroup;
    g.visible = false;
    this.scene.add(g);
    const R = BATTLE.arena;
    const wall = new THREE.Mesh(
      new THREE.CylinderGeometry(R + 0.15, R + 0.15, 1.1, 96, 1, true),
      new THREE.MeshStandardMaterial({ color: "#5ee7ff", transparent: true, opacity: 0.22, side: THREE.DoubleSide, emissive: "#1aa6c9", emissiveIntensity: 0.4 }),
    );
    wall.position.y = 0.55;
    g.add(wall);
    const top = new THREE.Mesh(new THREE.TorusGeometry(R + 0.15, 0.09, 8, 128), new THREE.MeshBasicMaterial({ color: "#7af0ff" }));
    top.rotation.x = Math.PI / 2;
    top.position.y = 1.1;
    g.add(top);
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
    this.crates = new Pool(g, () => {
      const m = new THREE.Mesh(crateGeo, crateMat);
      m.castShadow = true;
      const q = new THREE.Sprite(qMat);
      q.scale.setScalar(0.8);
      q.position.y = 1.1;
      const grp = new THREE.Group();
      grp.add(m, q);
      return grp;
    });
    const laserGeo = new THREE.SphereGeometry(BATTLE.laser.r, 12, 8);
    // each player's shots are their ball colour
    this.laserMats = COLORS.map((c) => ({
      core: new THREE.MeshBasicMaterial({ color: c }),
      glow: new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }),
    }));
    this.lasers = new Pool(g, () => {
      const m = new THREE.Mesh(laserGeo, this.laserMats[0].core);
      const glow = new THREE.Mesh(laserGeo, this.laserMats[0].glow);
      glow.scale.setScalar(2.2);
      m.add(glow);
      return m;
    });
    const rocketGeo = new THREE.ConeGeometry(0.25, 0.9, 12);
    rocketGeo.rotateZ(-Math.PI / 2); // point along +x
    const rocketMat = new THREE.MeshStandardMaterial({ color: "#e5e5e5", emissive: "#ff5400", emissiveIntensity: 0.3 });
    const flameMat = new THREE.MeshBasicMaterial({ color: "#ffbe0b", transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending });
    this.rockets = new Pool(g, () => {
      const m = new THREE.Mesh(rocketGeo, rocketMat);
      const flame = new THREE.Mesh(SPARK_GEO, flameMat);
      flame.scale.setScalar(3);
      flame.position.x = -0.55;
      m.add(flame);
      return m;
    });
    const mineGeo = new THREE.CylinderGeometry(0.5, 0.55, 0.22, 20);
    const mineMat = new THREE.MeshStandardMaterial({ color: "#2b2d42", roughness: 0.6 });
    const lightGeo = new THREE.SphereGeometry(0.12, 8, 6);
    this.mines = new Pool(g, () => {
      const m = new THREE.Mesh(mineGeo, mineMat);
      const light = new THREE.Mesh(lightGeo, new THREE.MeshBasicMaterial({ color: "#ff0a54" }));
      light.position.y = 0.15;
      m.add(light);
      return m;
    });
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
    const handleMat = new THREE.MeshStandardMaterial({ color: "#8d5524", roughness: 0.7 });
    const headMat = new THREE.MeshStandardMaterial({ color: "#ced4da", metalness: 0.5, roughness: 0.3, emissive: "#495057", emissiveIntensity: 0.5 });
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
      const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, H.reach, 8), handleMat);
      handle.rotation.z = Math.PI / 2;
      handle.position.x = H.reach / 2;
      const head = new THREE.Mesh(new THREE.BoxGeometry(H.head * 1.3, H.head * 1.3, H.head * 2), headMat);
      head.position.x = H.reach;
      head.castShadow = true;
      hammer.add(handle, head);
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
    });
    this.mines.sync(b.m, 4, (m, d, i) => {
      m.position.set(d[i + 1], 0.11, d[i + 2]);
      const light = m.children[0] as THREE.Mesh;
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
    m.visible = false;
  }

  setPlayers(n: number, you: number | null, battle = this.battle) {
    this.players = n;
    this.you = you;
    this.battle = battle;
    this.gone.clear();
    for (const b of this.balls) this.scene.remove(b);
    this.balls = [];
    this.falling.clear();
    this.snaps = [];
    for (let i = 0; i < n; i++) {
      const mat = new THREE.MeshStandardMaterial({ color: COLORS[i % COLORS.length], roughness: 0.25, metalness: 0.15 });
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
    }
    const r = battle ? BATTLE.arena : RULES.arenaStart;
    this.platform.scale.set(r, 1, r);
    this.rim.scale.set(r, r, 1);
    this.rim.visible = !battle;
    this.arenaGroup.visible = battle;
    this.hole.scale.setScalar(BATTLE.hole);
    this.holeRim.scale.set(BATTLE.hole, BATTLE.hole, 1);
    if (battle)
      this.balls.forEach((m, i) => {
        const a = Math.atan2(m.position.z, m.position.x);
        m.position.set(Math.cos(a) * BATTLE.spawnRadius, RULES.ballRadius, Math.sin(a) * BATTLE.spawnRadius);
      });
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
      const mat = m.material as THREE.MeshStandardMaterial;
      const band = m.children[0] as THREE.Mesh | undefined;
      mat.map = file ? skinTexture(file) : null;
      mat.color.set(file ? "#ffffff" : COLORS[i % COLORS.length]);
      mat.needsUpdate = true;
      if (band) band.visible = !file; // the picture already shows the roll
    });
  }

  pushSnapshot(d: number[], battle?: BattleSnap) {
    const balls = [];
    for (let i = 2; i + SNAP_STRIDE <= d.length; i += SNAP_STRIDE) {
      balls.push({ x: d[i], y: d[i + 1], vx: d[i + 2], vy: d[i + 3], alive: d[i + 4] === 1, dashIn: d[i + 5] });
    }
    this.snaps.push({ at: performance.now(), tick: d[0], arena: d[1], balls, b: battle });
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
      this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
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
      (this.rim.material as THREE.MeshBasicMaterial).color.setHSL(0.93, 1, 0.55 + 0.15 * Math.sin(now / 150) * (arena < 10 ? 1 : 0));

      b.balls.forEach((bb, i) => {
        const m = this.balls[i];
        if (!m) return;
        const ab = a.balls[i];
        if (this.gone.has(i)) return;
        if (!bb.alive && !this.falling.has(i) && !(ab?.alive ?? true)) {
          this.falling.set(i, { x: bb.x, z: bb.y, y: RULES.ballRadius, vx: bb.vx, vz: bb.vy, vy: 0 });
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

    if (this.you !== null && this.balls[this.you] && !this.falling.has(this.you)) {
      const p = this.balls[this.you].position;
      this.marker.visible = true;
      this.marker.position.set(p.x, p.y + 2 + Math.sin(now / 200) * 0.15, p.z);
    } else this.marker.visible = false;

    const z = this.zoom;
    this.camera.position.set(0, 21 * z, 17 * z);
    this.camera.lookAt(0, -1, 1);
  }

  private resize() {
    const w = this.canvas.clientWidth || innerWidth;
    const h = this.canvas.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // pull the camera back on narrow screens so the whole arena stays in view
    this.zoom = Math.max(1, 1.05 / this.camera.aspect);
    const fog = this.scene.fog as THREE.Fog;
    fog.near = 30 * this.zoom;
    fog.far = 70 * this.zoom;
    this.camera.updateProjectionMatrix();
  }
}
