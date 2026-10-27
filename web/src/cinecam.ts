// Spectator camera for filming: fly freely, or pick a smooth automatic shot (orbit, follow a player, top-down).
// Purely visual; it only moves the three.js camera.
import * as THREE from "three";

export type CineMode = "free" | "orbit" | "follow" | "top";
export type CineBall = { x: number; y: number; z: number; vx: number; vz: number; alive: boolean };

const ease = (dt: number, rate: number) => 1 - Math.exp(-dt * rate);

export class CineCam {
  active = false;
  mode: CineMode = "orbit";
  target = 0; // seat followed in "follow"
  private keys = new Set<string>();
  // free fly: where we want to be and look; the camera eases towards these
  private pos = new THREE.Vector3(0, 14, 22);
  private vel = new THREE.Vector3();
  private yaw = 0;
  private pitch = -0.5;
  private lookYaw = 0;
  private lookPitch = -0.5;
  private speed = 10; // units per second, changed with the scroll wheel
  // automatic shots
  private centre = new THREE.Vector3();
  private orbitAngle = 0;
  private orbitR = 24;
  private orbitH = 11;
  private followDir = new THREE.Vector3(1, 0, 0);
  private lookAt = new THREE.Vector3();
  private dragging: { x: number; y: number } | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    addEventListener("keydown", (e) => {
      if (!this.active || (e.target as HTMLElement)?.tagName === "INPUT") return;
      this.keys.add(e.code);
    });
    addEventListener("keyup", (e) => this.keys.delete(e.code));
    addEventListener("blur", () => this.keys.clear());
    canvas.addEventListener("pointerdown", (e) => {
      if (!this.active) return;
      this.dragging = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!this.active || !this.dragging) return;
      const dx = e.clientX - this.dragging.x;
      const dy = e.clientY - this.dragging.y;
      this.dragging = { x: e.clientX, y: e.clientY };
      if (this.mode === "free") {
        this.yaw -= dx * 0.004;
        this.pitch = THREE.MathUtils.clamp(this.pitch - dy * 0.004, -1.5, 1.2);
      } else if (this.mode === "orbit") {
        this.orbitAngle -= dx * 0.005;
        this.orbitH = THREE.MathUtils.clamp(this.orbitH + dy * 0.05, 1.5, 40);
      }
    });
    const stop = () => (this.dragging = null);
    canvas.addEventListener("pointerup", stop);
    canvas.addEventListener("pointercancel", stop);
    canvas.addEventListener(
      "wheel",
      (e) => {
        if (!this.active) return;
        e.preventDefault();
        const f = Math.exp(e.deltaY * 0.001);
        if (this.mode === "free") this.speed = THREE.MathUtils.clamp(this.speed * f, 2, 60);
        else if (this.mode === "orbit") this.orbitR = THREE.MathUtils.clamp(this.orbitR * f, 6, 70);
      },
      { passive: false },
    );
  }

  /** Start from wherever the camera is now, so switching on doesn't jump. */
  start(cam: THREE.PerspectiveCamera) {
    this.active = true;
    this.pos.copy(cam.position);
    this.vel.set(0, 0, 0);
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    this.yaw = this.lookYaw = Math.atan2(-dir.x, -dir.z);
    this.pitch = this.lookPitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
    this.lookAt.copy(cam.position).add(dir.multiplyScalar(10));
    this.orbitAngle = Math.atan2(cam.position.z, cam.position.x);
  }

  stop() {
    this.active = false;
    this.keys.clear();
    this.dragging = null;
  }

  setMode(mode: CineMode, cam: THREE.PerspectiveCamera) {
    if (mode === "free" && this.mode !== "free") this.start(cam); // fly on from the current shot
    this.mode = mode;
  }

  /** Move the camera for this frame. balls: where everyone is; returns the point the shot is centred on. */
  update(dt: number, cam: THREE.PerspectiveCamera, balls: CineBall[]): THREE.Vector3 {
    const alive = balls.filter((b) => b.alive);
    // the action centre: the middle of everyone still in, eased so the shot doesn't twitch
    const c = new THREE.Vector3();
    for (const b of alive) c.add(new THREE.Vector3(b.x, 0, b.z));
    if (alive.length) c.divideScalar(alive.length);
    this.centre.lerp(c, ease(dt, 1.5));

    if (this.mode === "free") {
      const k = this.keys;
      const fast = k.has("ShiftLeft") || k.has("ShiftRight") ? 3 : 1;
      const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      const want = new THREE.Vector3();
      if (k.has("KeyW") || k.has("ArrowUp")) want.add(fwd);
      if (k.has("KeyS") || k.has("ArrowDown")) want.sub(fwd);
      if (k.has("KeyD") || k.has("ArrowRight")) want.add(right);
      if (k.has("KeyA") || k.has("ArrowLeft")) want.sub(right);
      if (k.has("KeyE") || k.has("Space")) want.y += 1;
      if (k.has("KeyQ") || k.has("ControlLeft")) want.y -= 1;
      if (want.lengthSq()) want.normalize().multiplyScalar(this.speed * fast);
      this.vel.lerp(want, ease(dt, 3)); // glide in and out of moves
      this.pos.addScaledVector(this.vel, dt);
      this.pos.y = Math.max(0.6, this.pos.y);
      this.lookYaw += (this.yaw - this.lookYaw) * ease(dt, 8);
      this.lookPitch += (this.pitch - this.lookPitch) * ease(dt, 8);
      cam.position.copy(this.pos);
      const d = new THREE.Vector3(-Math.sin(this.lookYaw) * Math.cos(this.lookPitch), Math.sin(this.lookPitch), -Math.cos(this.lookYaw) * Math.cos(this.lookPitch));
      cam.lookAt(this.pos.clone().add(d));
      return this.pos.clone().add(d.multiplyScalar(12)).setY(0);
    }

    let wantPos: THREE.Vector3;
    let wantLook: THREE.Vector3;
    if (this.mode === "follow") {
      let b = balls[this.target];
      if (!b?.alive) b = alive[0] ?? b;
      if (b) {
        const v = new THREE.Vector3(b.vx, 0, b.vz);
        if (v.lengthSq() > 1) this.followDir.lerp(v.normalize(), ease(dt, 2)).normalize();
        const p = new THREE.Vector3(b.x, b.y, b.z);
        wantPos = p.clone().addScaledVector(this.followDir, -7).setY(p.y + 3.2);
        wantLook = p.clone().addScaledVector(this.followDir, 3);
      } else {
        wantPos = this.centre.clone().add(new THREE.Vector3(0, 14, 18));
        wantLook = this.centre.clone();
      }
    } else if (this.mode === "top") {
      const t = performance.now() / 1000;
      wantPos = this.centre.clone().add(new THREE.Vector3(Math.sin(t * 0.1) * 3, 34, 4));
      wantLook = this.centre.clone();
    } else {
      // orbit: a slow circle around the action
      this.orbitAngle += dt * 0.18;
      wantPos = this.centre.clone().add(new THREE.Vector3(Math.cos(this.orbitAngle) * this.orbitR, this.orbitH, Math.sin(this.orbitAngle) * this.orbitR));
      wantLook = this.centre.clone();
    }
    cam.position.lerp(wantPos, ease(dt, this.mode === "follow" ? 3 : 2));
    this.lookAt.lerp(wantLook, ease(dt, 4));
    cam.lookAt(this.lookAt);
    return this.lookAt.clone().setY(0);
  }
}
