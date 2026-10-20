// three.js view of the arena. Purely visual: positions come from server snapshots.
import * as THREE from "three";
import { SNAP_STRIDE, RULES } from "../../shared/physics";
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

type Snap = { at: number; tick: number; arena: number; balls: { x: number; y: number; vx: number; vy: number; alive: boolean; dashIn: number }[] };



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
  private shake = 0;
  private sparks: { mesh: THREE.Mesh; v: THREE.Vector3; life: number }[] = [];
  private fx: Fx[] = [];
  private trails = new Map<number, number>(); // seat -> seconds of dash trail left
  private trailGap = 0;
  private raf = 0;
  private zoom = 1;
  private skins: string[] = [];
  you: number | null = null;
  players = 0;

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

    addEventListener("resize", () => this.resize());
    this.resize();
  }

  setPlayers(n: number, you: number | null) {
    this.players = n;
    this.you = you;
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
    this.platform.scale.set(RULES.arenaStart, 1, RULES.arenaStart);
    this.rim.scale.set(RULES.arenaStart, RULES.arenaStart, 1);
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

  pushSnapshot(d: number[]) {
    const balls = [];
    for (let i = 2; i + SNAP_STRIDE <= d.length; i += SNAP_STRIDE) {
      balls.push({ x: d[i], y: d[i + 1], vx: d[i + 2], vy: d[i + 3], alive: d[i + 4] === 1, dashIn: d[i + 5] });
    }
    this.snaps.push({ at: performance.now(), tick: d[0], arena: d[1], balls });
    if (this.snaps.length > 30) this.snaps.shift();
  }

  dashReadyIn(seat: number): number {
    const s = this.snaps[this.snaps.length - 1];
    return s ? s.balls[seat]?.dashIn ?? 0 : 0;
  }

  bump(a: number, b: number, force: number) {
    const mid = this.mid(a, b);
    if (!mid) return;
    this.shake = Math.min(0.6, this.shake + force * 0.03);
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

    this.shake *= Math.pow(0.02, dt);
    const z = this.zoom;
    this.camera.position.set((Math.random() - 0.5) * this.shake, 21 * z + (Math.random() - 0.5) * this.shake, 17 * z);
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
