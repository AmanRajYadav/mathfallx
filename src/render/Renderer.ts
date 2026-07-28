/**
 * Canvas renderer.
 *
 * Two rules keep this fast enough for a mid-range phone:
 *
 *   1. Anything that does not change every frame is pre-rendered once into an
 *      offscreen canvas and blitted. The sky gradient, the sun with its
 *      scanline cutouts, and the mountain silhouettes are all static until the
 *      viewport resizes, and redrawing them per frame is pure waste.
 *
 *   2. `shadowBlur` is the single most expensive thing in the 2D API and it is
 *      what makes neon look like neon. It is budgeted: used for blocks and
 *      beams at high quality, replaced with a cheap double-stroke at low
 *      quality, and the quality tier drops itself automatically if the frame
 *      rate sags.
 */

import type { Block, GameCore } from '../engine/GameCore';
import { POWER_UPS } from '../engine/powerups';

export type Quality = 'low' | 'high';

interface Star {
  x: number;
  y: number;
  z: number;
  tw: number;
}

const FONT_UI = "800 16px ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const FONT_MATH = "800 ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, Consolas, monospace";

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private bg: HTMLCanvasElement;
  private bgCtx: CanvasRenderingContext2D;

  private dpr = 1;
  private w = 0;
  private h = 0;
  private horizonY = 0;

  private stars: Star[] = [];
  private gridScroll = 0;
  private time = 0;

  quality: Quality = 'high';
  private autoQuality = true;
  private frameTimes: number[] = [];
  private lastFrame = 0;

  constructor(canvas: HTMLCanvasElement, quality: 'auto' | Quality = 'auto') {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;

    this.bg = document.createElement('canvas');
    const bgCtx = this.bg.getContext('2d');
    if (!bgCtx) throw new Error('2D canvas context unavailable');
    this.bgCtx = bgCtx;

    this.setQuality(quality);
  }

  setQuality(q: 'auto' | Quality): void {
    if (q === 'auto') {
      this.autoQuality = true;
      const cores = navigator.hardwareConcurrency ?? 4;
      const dpr = window.devicePixelRatio || 1;
      // A dense display on a modest CPU is the combination that struggles:
      // lots of pixels, not much fill rate.
      this.quality = cores <= 4 && dpr >= 2 ? 'low' : 'high';
    } else {
      this.autoQuality = false;
      this.quality = q;
    }
  }

  resize(cssWidth: number, cssHeight: number): void {
    // Capping DPR at 2 is close to free visually and saves a large amount of
    // fill on 3x phones, which is where the frame budget actually goes.
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    // Assigning canvas.width clears the canvas, and a ResizeObserver fires on
    // any layout change — including ones that leave our box identical. Without
    // this guard the scene is wiped and the backdrop re-rasterised for nothing,
    // which shows up as a flicker whenever the keypad opens.
    if (cssWidth === this.w && cssHeight === this.h && dpr === this.dpr) return;

    this.dpr = dpr;
    this.w = cssWidth;
    this.h = cssHeight;
    this.horizonY = Math.round(cssHeight * 0.58);

    this.canvas.width = Math.round(cssWidth * dpr);
    this.canvas.height = Math.round(cssHeight * dpr);
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.bg.width = this.canvas.width;
    this.bg.height = this.canvas.height;
    this.bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.buildStars();
    this.paintBackdrop();
  }

  private buildStars(): void {
    const count = this.quality === 'low' ? 40 : 80;
    this.stars = [];
    for (let i = 0; i < count; i++) {
      this.stars.push({
        x: Math.random() * this.w,
        y: Math.random() * this.horizonY,
        z: 0.25 + Math.random() * 0.75,
        tw: Math.random() * Math.PI * 2,
      });
    }
  }

  /** Draws the static half of the scene once per resize. */
  private paintBackdrop(): void {
    const c = this.bgCtx;
    const { w, h, horizonY } = this;
    c.clearRect(0, 0, w, h);

    // Sky.
    const sky = c.createLinearGradient(0, 0, 0, horizonY);
    sky.addColorStop(0, '#07021a');
    sky.addColorStop(0.45, '#160a3d');
    sky.addColorStop(0.8, '#4a1163');
    sky.addColorStop(1, '#8f1f66');
    c.fillStyle = sky;
    c.fillRect(0, 0, w, horizonY);

    // Ground.
    const ground = c.createLinearGradient(0, horizonY, 0, h);
    ground.addColorStop(0, '#1b0533');
    ground.addColorStop(1, '#05010f');
    c.fillStyle = ground;
    c.fillRect(0, horizonY, w, h - horizonY);

    // The sun, with horizontal cutouts widening toward the base.
    const sunR = Math.min(w * 0.34, horizonY * 0.52);
    const sunCx = w / 2;
    const sunCy = horizonY - sunR * 0.12;

    c.save();
    c.beginPath();
    c.arc(sunCx, sunCy, sunR, 0, Math.PI * 2);
    c.clip();

    const sunGrad = c.createLinearGradient(0, sunCy - sunR, 0, sunCy + sunR);
    sunGrad.addColorStop(0, '#ffe66d');
    sunGrad.addColorStop(0.42, '#ff9f45');
    sunGrad.addColorStop(0.75, '#ff2d95');
    sunGrad.addColorStop(1, '#c01a86');
    c.fillStyle = sunGrad;
    c.fillRect(sunCx - sunR, sunCy - sunR, sunR * 2, sunR * 2);

    c.globalCompositeOperation = 'destination-out';
    let y = sunCy + sunR * 0.08;
    let gap = sunR * 0.045;
    while (y < sunCy + sunR) {
      c.fillRect(sunCx - sunR, y, sunR * 2, gap);
      y += gap + sunR * 0.075;
      gap *= 1.28;
    }
    c.restore();

    // Horizon bloom.
    const glow = c.createLinearGradient(0, horizonY - 60, 0, horizonY + 24);
    glow.addColorStop(0, 'rgba(255,45,149,0)');
    glow.addColorStop(0.7, 'rgba(255,45,149,0.28)');
    glow.addColorStop(1, 'rgba(0,240,255,0.30)');
    c.fillStyle = glow;
    c.fillRect(0, horizonY - 60, w, 84);

    this.paintMountains(c, horizonY);

    c.fillStyle = '#00f0ff';
    c.fillRect(0, horizonY - 1, w, 2);
  }

  private paintMountains(c: CanvasRenderingContext2D, horizonY: number): void {
    const { w } = this;
    const ranges: Array<[number, number, string]> = [
      [0.16, 58, 'rgba(28,7,58,0.95)'],
      [0.11, 40, 'rgba(52,12,86,0.9)'],
    ];
    for (const [scale, seedStep, fill] of ranges) {
      c.beginPath();
      c.moveTo(0, horizonY);
      const peakH = this.h * scale;
      let x = 0;
      let i = 0;
      while (x < w + seedStep) {
        // Deterministic zig-zag: a fixed trig mix, so the skyline is stable
        // across resizes instead of reshuffling every rotation.
        const t = i * 1.7;
        const height = peakH * (0.45 + 0.55 * Math.abs(Math.sin(t) * Math.cos(t * 0.6)));
        c.lineTo(x + seedStep / 2, horizonY - height);
        c.lineTo(x + seedStep, horizonY);
        x += seedStep;
        i++;
      }
      c.lineTo(w, horizonY);
      c.closePath();
      c.fillStyle = fill;
      c.fill();
    }
  }

  // --------------------------------------------------------------------- draw

  render(game: GameCore, now: number): void {
    const dt = this.lastFrame === 0 ? 16 : Math.min(50, now - this.lastFrame);
    this.lastFrame = now;
    this.time += dt / 1000;

    if (this.autoQuality) this.sampleFrame(dt);

    const c = this.ctx;
    const { w, h } = this;

    c.save();

    // Directional screen shake: a strong kick away from the impact, plus a
    // little jitter. Purely random shake reads as noise; a biased offset reads
    // as recoil.
    if (game.shake > 0.2) {
      const s = game.shake;
      c.translate(
        game.shakeX * s * 0.7 + (Math.random() - 0.5) * s * 0.6,
        game.shakeY * s * 0.7 + (Math.random() - 0.5) * s * 0.6,
      );
    }

    c.drawImage(this.bg, 0, 0, w, h);

    this.drawStars(dt);
    this.drawGrid(game, dt);
    this.drawFloor(game);
    this.drawShockwaves(game);
    this.drawBeams(game);
    this.drawBlocks(game);
    this.drawParticles(game);
    this.drawPickups(game);
    this.drawShip(game);
    this.drawPopups(game);

    c.restore();

    if (game.flash > 0.01) {
      c.fillStyle = `rgba(255,60,140,${game.flash * 0.4})`;
      c.fillRect(0, 0, w, h);
    }

    if (game.overdriveActive()) {
      const pulse = 0.10 + Math.sin(this.time * 9) * 0.05;
      c.fillStyle = `rgba(150,60,255,${pulse})`;
      c.fillRect(0, 0, w, h);
    }
  }

  /** Drops to low quality if frames are consistently slow. */
  private sampleFrame(dt: number): void {
    this.frameTimes.push(dt);
    if (this.frameTimes.length < 80) return;
    let sum = 0;
    for (const t of this.frameTimes) sum += t;
    const avg = sum / this.frameTimes.length;
    this.frameTimes.length = 0;
    if (avg > 22 && this.quality === 'high') {
      this.quality = 'low';
      this.buildStars();
    }
  }

  private drawStars(dt: number): void {
    const c = this.ctx;
    c.save();
    for (const s of this.stars) {
      s.tw += dt / 620;
      s.y += s.z * dt * 0.006;
      if (s.y > this.horizonY) {
        s.y = 0;
        s.x = Math.random() * this.w;
      }
      const alpha = 0.35 + Math.sin(s.tw) * 0.3;
      c.fillStyle = `rgba(255,255,255,${Math.max(0.08, alpha) * s.z})`;
      c.fillRect(s.x, s.y, s.z * 1.7, s.z * 1.7);
    }
    c.restore();
  }

  /** Perspective floor grid, scrolling toward the viewer. */
  private drawGrid(game: GameCore, dt: number): void {
    const c = this.ctx;
    const { w, h, horizonY } = this;
    const speed = game.overdriveActive() ? 0.55 : 0.22;
    this.gridScroll = (this.gridScroll + (dt / 1000) * speed) % 1;

    const depth = h - horizonY;
    if (depth <= 0) return;

    c.save();
    c.lineWidth = 1;

    // Receding horizontals. The exponent is what sells the perspective.
    const rows = this.quality === 'low' ? 12 : 18;
    for (let i = 0; i < rows; i++) {
      const t = (i + this.gridScroll) / rows;
      const y = horizonY + depth * Math.pow(t, 2.4);
      const alpha = 0.10 + t * 0.5;
      c.strokeStyle = `rgba(0,240,255,${alpha})`;
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(w, y);
      c.stroke();
    }

    // Verticals fanning out from the vanishing point.
    const cols = this.quality === 'low' ? 11 : 17;
    const cx = w / 2;
    const spread = w * 1.9;
    c.strokeStyle = 'rgba(255,45,149,0.30)';
    c.beginPath();
    for (let i = 0; i <= cols; i++) {
      const t = i / cols - 0.5;
      c.moveTo(cx, horizonY);
      c.lineTo(cx + t * spread, h);
    }
    c.stroke();
    c.restore();
  }

  /** The line blocks must not cross. */
  private drawFloor(game: GameCore): void {
    const c = this.ctx;
    const y = game.playBottom;
    const danger = game.blocks.some((b) => b.dying <= 0 && b.y + b.h > y - 90);

    c.save();
    const grad = c.createLinearGradient(0, y - 46, 0, y);
    grad.addColorStop(0, 'rgba(255,45,149,0)');
    grad.addColorStop(1, danger ? 'rgba(255,60,90,0.38)' : 'rgba(0,240,255,0.18)');
    c.fillStyle = grad;
    c.fillRect(0, y - 46, this.w, 46);

    c.strokeStyle = danger ? '#ff3b64' : '#00f0ff';
    c.lineWidth = 2;
    if (this.quality === 'high') {
      c.shadowColor = c.strokeStyle;
      c.shadowBlur = danger ? 20 : 12;
    }
    c.beginPath();
    c.moveTo(0, y);
    c.lineTo(this.w, y);
    c.stroke();
    c.restore();
  }

  private drawBeams(game: GameCore): void {
    const c = this.ctx;
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.lineCap = 'round';
    for (const b of game.beams) {
      if (!b.alive) continue;
      const a = Math.max(0, b.life);
      c.strokeStyle = `hsla(${b.hue},100%,72%,${a})`;
      c.lineWidth = 2 + a * 5;
      if (this.quality === 'high') {
        c.shadowColor = `hsl(${b.hue},100%,65%)`;
        c.shadowBlur = 18 * a;
      }
      c.beginPath();
      c.moveTo(b.x1, b.y1);
      c.lineTo(b.x2, b.y2);
      c.stroke();
    }
    c.restore();
  }

  private drawBlocks(game: GameCore): void {
    const c = this.ctx;
    for (const b of game.blocks) {
      this.drawBlock(c, b, game);
    }
  }

  private drawBlock(c: CanvasRenderingContext2D, b: Block, game: GameCore): void {
    const intro = easeOutBack(b.intro);
    const dying = b.dying > 0 ? b.dying : 1;
    const scale = intro * (b.dying > 0 ? 1 + (1 - dying) * 0.5 : 1);
    const alpha = b.dying > 0 ? dying : Math.min(1, b.intro * 1.4);
    if (alpha <= 0.01) return;

    const w = b.w * scale;
    const h = b.h * scale;
    const x = b.x - w / 2;
    const y = b.y + (b.h - h) / 2;

    // Urgency: blocks near the floor pulse and shift warm.
    const proximity = clamp01((b.y + b.h - (game.playBottom - 200)) / 200);
    const hue = b.hue + (b.hue === 186 ? -proximity * 160 : 0);
    const pulse = proximity > 0.35 ? 0.5 + Math.sin(this.time * 14) * 0.5 : 0;

    c.save();
    c.globalAlpha = alpha;

    // Body.
    const grad = c.createLinearGradient(x, y, x, y + h);
    grad.addColorStop(0, `hsla(${hue},90%,22%,0.92)`);
    grad.addColorStop(1, `hsla(${hue},95%,11%,0.94)`);
    c.fillStyle = grad;
    roundRect(c, x, y, w, h, 12);
    c.fill();

    // Neon edge.
    const edge = `hsl(${hue},100%,${62 + pulse * 14}%)`;
    c.strokeStyle = edge;
    c.lineWidth = b.kind === 'boss' ? 3 : 2;
    if (this.quality === 'high') {
      c.shadowColor = edge;
      c.shadowBlur = 12 + pulse * 16 + (b.kind === 'boss' ? 10 : 0);
    } else {
      // Cheap stand-in for bloom: a translucent outer stroke.
      c.save();
      c.strokeStyle = `hsla(${hue},100%,60%,0.28)`;
      c.lineWidth = 6;
      roundRect(c, x, y, w, h, 12);
      c.stroke();
      c.restore();
    }
    roundRect(c, x, y, w, h, 12);
    c.stroke();
    c.shadowBlur = 0;

    // Armour pips.
    if (b.maxHp > 1) {
      for (let i = 0; i < b.maxHp; i++) {
        c.fillStyle = i < b.hp ? edge : 'rgba(255,255,255,0.18)';
        c.beginPath();
        c.arc(x + 11 + i * 9, y + 9, 3, 0, Math.PI * 2);
        c.fill();
      }
    }

    // Boss crown.
    if (b.kind === 'boss') {
      c.fillStyle = `hsl(45,100%,${60 + pulse * 15}%)`;
      const cw = 22 * scale;
      c.beginPath();
      c.moveTo(b.x - cw, y - 3);
      c.lineTo(b.x - cw * 0.5, y - 13);
      c.lineTo(b.x, y - 4);
      c.lineTo(b.x + cw * 0.5, y - 13);
      c.lineTo(b.x + cw, y - 3);
      c.closePath();
      c.fill();
    }

    this.drawFace(c, b, x, y, w, h, proximity, hue);

    // Equation, sitting below the face.
    const textY = y + h * 0.63;
    const fontSize = Math.min(h * 0.38, (w - 22) / Math.max(4, b.text.length) * 1.62);
    c.font = `800 ${Math.round(fontSize)}px ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, Consolas, monospace`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    if (this.quality === 'high') {
      c.shadowColor = edge;
      c.shadowBlur = 8;
    }
    c.fillStyle = '#ffffff';
    c.fillText(b.text, b.x, textY);

    c.restore();
  }

  /**
   * The block's face.
   *
   * Eyes cost almost nothing to draw and do an enormous amount of work: they
   * give each block a read at a glance (an angry one is dangerous, a boss is
   * a boss), and the expression shifting from calm to panicked as it nears the
   * floor communicates urgency far faster than a colour change. The pupils
   * track the ship, so the whole screen appears to be watching the player.
   */
  private drawFace(
    c: CanvasRenderingContext2D,
    b: Block,
    x: number, y: number, w: number, h: number,
    proximity: number,
    hue: number,
  ): void {
    const eyeY = y + h * 0.29;
    const spread = Math.min(13, w * 0.13);
    const boss = b.kind === 'boss';
    const base = boss ? 5.2 : 4;

    // Blink: mostly closed-mouth timing, offset per block so they never
    // blink in unison.
    const phase = (this.time * 0.9 + b.id * 0.37) % 3.4;
    const blinking = phase > 3.24;

    // Wider eyes the closer it gets to breaching.
    const panic = proximity;
    const radius = base * (1 + panic * 0.45);

    // Pupils look toward the ship.
    const shipX = this.w / 2;
    const shipY = this.h;

    for (const side of [-1, 1]) {
      const ex = b.x + side * spread;

      c.fillStyle = 'rgba(6,2,16,0.92)';
      c.beginPath();
      c.arc(ex, eyeY, radius + 1.6, 0, Math.PI * 2);
      c.fill();

      if (blinking) {
        c.strokeStyle = '#ffffff';
        c.lineWidth = 1.8;
        c.beginPath();
        c.moveTo(ex - radius, eyeY);
        c.lineTo(ex + radius, eyeY);
        c.stroke();
        continue;
      }

      c.fillStyle = '#ffffff';
      c.beginPath();
      c.arc(ex, eyeY, radius, 0, Math.PI * 2);
      c.fill();

      const dx = shipX - ex;
      const dy = shipY - eyeY;
      const len = Math.hypot(dx, dy) || 1;
      const reach = radius * 0.42;
      // Panicked eyes jitter rather than track.
      const jitter = panic > 0.7 ? (Math.random() - 0.5) * 2.2 : 0;
      c.fillStyle = boss ? '#ff2d95' : '#0a0320';
      c.beginPath();
      c.arc(ex + (dx / len) * reach + jitter, eyeY + (dy / len) * reach, radius * 0.5, 0, Math.PI * 2);
      c.fill();
    }

    // Brows carry the mood: angled inward for aggression, raised for panic.
    const angry = b.kind === 'fast' || b.kind === 'boss';
    if (angry || panic > 0.35) {
      c.strokeStyle = angry ? '#ff5a78' : `hsl(${hue},100%,78%)`;
      c.lineWidth = boss ? 2.6 : 2;
      c.lineCap = 'round';
      for (const side of [-1, 1]) {
        const ex = b.x + side * spread;
        const inner = angry ? -3.2 : 2.4;
        const outer = angry ? 1.6 : -1.6;
        c.beginPath();
        c.moveTo(ex - side * radius, eyeY - radius - 2.5 + outer);
        c.lineTo(ex + side * radius, eyeY - radius - 2.5 + inner);
        c.stroke();
      }
    }
  }

  private drawParticles(game: GameCore): void {
    const c = this.ctx;
    c.save();
    c.globalCompositeOperation = 'lighter';
    for (const p of game.particles) {
      if (!p.alive) continue;
      const a = p.life / p.maxLife;
      c.fillStyle = `rgba(${p.r},${p.g},${p.b},${a})`;
      const s = p.size * a;
      c.fillRect(p.x - s / 2, p.y - s / 2, s, s);
    }
    c.restore();
  }

  /** Expanding blast rings. Cheap, and the clearest read of "that died". */
  private drawShockwaves(game: GameCore): void {
    const c = this.ctx;
    c.save();
    c.globalCompositeOperation = 'lighter';
    for (const s of game.shockwaves) {
      if (!s.alive) continue;
      const a = Math.max(0, s.life);
      c.strokeStyle = `hsla(${s.hue},100%,72%,${a * 0.85})`;
      c.lineWidth = s.width * a;
      c.beginPath();
      c.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      c.stroke();
    }
    c.restore();
  }

  /** Power-up tokens in flight toward the ship. */
  private drawPickups(game: GameCore): void {
    const c = this.ctx;
    for (const p of game.pickups) {
      if (!p.alive) continue;
      const def = POWER_UPS[p.type];
      const wobble = Math.sin(p.spin * 2) * 0.18;

      c.save();
      c.translate(p.x, p.y);
      c.rotate(wobble);

      if (this.quality === 'high') {
        c.shadowColor = `hsl(${p.hue},100%,62%)`;
        c.shadowBlur = 16;
      }

      // Diamond capsule.
      c.fillStyle = `hsla(${p.hue},90%,18%,0.95)`;
      c.strokeStyle = `hsl(${p.hue},100%,68%)`;
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(0, -13);
      c.lineTo(12, 0);
      c.lineTo(0, 13);
      c.lineTo(-12, 0);
      c.closePath();
      c.fill();
      c.stroke();

      c.shadowBlur = 0;
      c.fillStyle = '#ffffff';
      c.font = '700 13px ui-sans-serif, system-ui, sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(def.icon, 0, 1);
      c.restore();
    }
  }

  /**
   * The player's ship.
   *
   * It banks toward whatever it last destroyed, so shots read as aimed rather
   * than as a beam appearing out of nowhere. The muzzle charge and the engine
   * both scale with the combo, which turns a long chain into something you can
   * see building.
   */
  private drawShip(game: GameCore): void {
    const c = this.ctx;
    const x = this.w / 2;
    const y = game.playBottom - 18;
    const od = game.overdriveActive();
    const hull = od ? '#c17bff' : '#00f0ff';
    const accent = od ? '#ffe66d' : '#ff2d95';
    const heat = Math.min(1, game.combo / 24);

    c.save();
    c.translate(x, y + Math.sin(this.time * 3) * 1.6);
    // Bank into the aim, but never fully — a slight lean reads better than a
    // ship pointing sideways.
    c.rotate(game.aim * 0.55);

    // Charge glow at the muzzle.
    if (game.charge > 0.01 || heat > 0.05) {
      const g = c.createRadialGradient(0, -20, 0, 0, -20, 26);
      const a = Math.max(game.charge, heat * 0.5);
      g.addColorStop(0, `rgba(255,255,255,${0.55 * a})`);
      g.addColorStop(0.4, od ? `rgba(193,123,255,${0.4 * a})` : `rgba(0,240,255,${0.4 * a})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.beginPath();
      c.arc(0, -20, 26, 0, Math.PI * 2);
      c.fill();
    }

    if (this.quality === 'high') {
      c.shadowColor = hull;
      c.shadowBlur = 14;
    }

    // Main hull.
    c.fillStyle = hull;
    c.beginPath();
    c.moveTo(0, -24);
    c.lineTo(7, -6);
    c.lineTo(15, 6);
    c.lineTo(5, 3);
    c.lineTo(0, 8);
    c.lineTo(-5, 3);
    c.lineTo(-15, 6);
    c.lineTo(-7, -6);
    c.closePath();
    c.fill();

    // Wing accents.
    c.shadowBlur = 0;
    c.fillStyle = accent;
    c.beginPath();
    c.moveTo(15, 6); c.lineTo(9, 1); c.lineTo(11, 9); c.closePath();
    c.moveTo(-15, 6); c.lineTo(-9, 1); c.lineTo(-11, 9); c.closePath();
    c.fill();

    // Cockpit.
    c.fillStyle = `rgba(255,255,255,${0.65 + heat * 0.35})`;
    c.beginPath();
    c.ellipse(0, -11, 3, 6, 0, 0, Math.PI * 2);
    c.fill();

    // Twin thrusters, longer and brighter as the chain grows.
    const flame = 10 + Math.sin(this.time * 26) * 4 + heat * 14;
    c.globalCompositeOperation = 'lighter';
    for (const side of [-1, 1]) {
      const fx = side * 4.5;
      const fg = c.createLinearGradient(fx, 4, fx, 4 + flame);
      fg.addColorStop(0, od ? 'rgba(255,230,109,0.9)' : 'rgba(255,45,149,0.9)');
      fg.addColorStop(1, 'rgba(255,45,149,0)');
      c.fillStyle = fg;
      c.beginPath();
      c.moveTo(fx - 3.2, 4);
      c.lineTo(fx + 3.2, 4);
      c.lineTo(fx, 4 + flame);
      c.closePath();
      c.fill();
    }

    c.restore();
  }

  private drawPopups(game: GameCore): void {
    const c = this.ctx;
    c.save();
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (const p of game.popups) {
      if (!p.alive) continue;
      const a = clamp01(p.life);
      const size = p.big ? 26 : 17;
      c.font = `900 ${size}px ${FONT_UI.replace('800 16px ', '')}`;
      c.font = `900 ${size}px ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
      c.globalAlpha = a;
      if (this.quality === 'high') {
        c.shadowColor = `hsl(${p.hue},100%,60%)`;
        c.shadowBlur = 12;
      }
      c.fillStyle = '#ffffff';
      c.fillText(p.text, p.x, p.y);
    }
    c.restore();
  }
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  c.beginPath();
  // Not available in older Safari, so fall back to arcs.
  if (typeof (c as unknown as { roundRect?: unknown }).roundRect === 'function') {
    (c as CanvasRenderingContext2D & { roundRect(x: number, y: number, w: number, h: number, r: number): void })
      .roundRect(x, y, w, h, radius);
    return;
  }
  c.moveTo(x + radius, y);
  c.arcTo(x + w, y, x + w, y + h, radius);
  c.arcTo(x + w, y + h, x, y + h, radius);
  c.arcTo(x, y + h, x, y, radius);
  c.arcTo(x, y, x + w, y, radius);
  c.closePath();
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function easeOutBack(t: number): number {
  if (t >= 1) return 1;
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const x = t - 1;
  return 1 + c3 * x * x * x + c1 * x * x;
}
