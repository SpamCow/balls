// Keyboard (WASD / arrows + space, E or Shift for the weapon) and a touch
// joystick (left half) + dash and weapon buttons.
export type Controls = { x: number; y: number; dash: boolean; use: boolean };

export function createControls(root: HTMLElement, onDash: () => void = () => {}, onUse: () => void = () => {}) {
  const keys = new Set<string>();
  const state = { touchX: 0, touchY: 0, dashQueued: false, useQueued: false };

  addEventListener("keydown", (e) => {
    if ((e.target as HTMLElement)?.tagName === "INPUT") return;
    keys.add(e.code);
    if (e.code === "Space") {
      if (!e.repeat) {
        state.dashQueued = true;
        onDash();
      }
      e.preventDefault();
    }
    if ((e.code === "KeyE" || e.code === "ShiftLeft" || e.code === "ShiftRight") && !e.repeat) {
      state.useQueued = true;
      onUse();
    }
  });
  addEventListener("keyup", (e) => keys.delete(e.code));
  addEventListener("blur", () => keys.clear());

  const stick = root.querySelector<HTMLElement>(".stick")!;
  const knob = root.querySelector<HTMLElement>(".knob")!;
  const dashBtn = root.querySelector<HTMLElement>(".dash-btn")!;
  const useBtn = root.querySelector<HTMLElement>(".use-btn")!;
  let touchId: number | null = null;
  let origin = { x: 0, y: 0 };
  const R = 60;

  root.addEventListener("touchstart", (e) => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.target === dashBtn || useBtn.contains(t.target as Node)) continue;
      if (touchId === null && t.clientX < innerWidth * 0.6) {
        touchId = t.identifier;
        origin = { x: t.clientX, y: t.clientY };
        stick.style.display = "block";
        stick.style.left = `${origin.x}px`;
        stick.style.top = `${origin.y}px`;
      }
    }
  }, { passive: true });
  root.addEventListener("touchmove", (e) => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier !== touchId) continue;
      let dx = t.clientX - origin.x;
      let dy = t.clientY - origin.y;
      const len = Math.hypot(dx, dy);
      if (len > R) {
        dx = (dx / len) * R;
        dy = (dy / len) * R;
      }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      state.touchX = dx / R;
      state.touchY = dy / R;
    }
  }, { passive: true });
  const end = (e: TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier !== touchId) continue;
      touchId = null;
      state.touchX = state.touchY = 0;
      stick.style.display = "none";
      knob.style.transform = "";
    }
  };
  root.addEventListener("touchend", end);
  root.addEventListener("touchcancel", end);
  // pointerdown fires on first contact; send the press right away instead of waiting for the next input tick
  const button = (btn: HTMLElement, press: () => void) => {
    btn.addEventListener("pointerdown", (e) => {
      press();
      btn.classList.add("down");
      e.preventDefault();
    });
    for (const ev of ["pointerup", "pointercancel", "pointerleave"]) btn.addEventListener(ev, () => btn.classList.remove("down"));
    btn.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
  };
  button(dashBtn, () => {
    state.dashQueued = true;
    onDash();
  });
  button(useBtn, () => {
    state.useQueued = true;
    onUse();
  });

  /** Screen-space input; up on screen is -y. */
  return function read(): Controls {
    let x = 0;
    let y = 0;
    if (keys.has("KeyA") || keys.has("ArrowLeft")) x -= 1;
    if (keys.has("KeyD") || keys.has("ArrowRight")) x += 1;
    if (keys.has("KeyW") || keys.has("ArrowUp")) y -= 1;
    if (keys.has("KeyS") || keys.has("ArrowDown")) y += 1;
    x += state.touchX;
    y += state.touchY;
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    const dash = state.dashQueued;
    const use = state.useQueued;
    state.dashQueued = state.useQueued = false;
    return { x, y, dash, use };
  };
}
