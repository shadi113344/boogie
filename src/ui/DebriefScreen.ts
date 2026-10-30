/**
 * The debrief.
 *
 * The debrief is the account of the jump: the outcome in one line of plain
 * words, the numbers of the jump in the units of the drop zone, the flags
 * the jumper has to think about, the altitude against the time, and the
 * ground track from above with the landing area, the target and the wind.
 *
 * The screen is the jumper's own: it lies over the world, it scrolls on a
 * phone, and it has one button, which asks for the next jump.
 *
 * The numbers come from the simulation (`computeDebrief`), and the track
 * comes from the jump that was flown. Nothing here steps the simulation, so
 * the same jump always gives the same debrief.
 */

import type { DebriefData, DebriefFlag } from '@/sim/debrief';
import type { TrackSample } from '@/sim/Jump';
import { FT, formatAltitude, formatDistance, formatSpeed, type UnitSystem } from '@/sim/units';

/** The height a turn has to reach below to be a low turn, in feet. */
const LOW_TURN_FT = 500;

/** How far below the plan a pull has to be to be late, in feet. */
const LATE_PULL_FT = 500;

/** The width of the drawing of the ground track, in pixels. */
const TRACK_WIDTH_PX = 320;

/** The height of the drawing of the ground track, in pixels. */
const TRACK_HEIGHT_PX = 260;

/** The height of the drawing of the altitude profile, in pixels. */
const PROFILE_WIDTH_PX = 320;

/** The height of the drawing of the altitude profile, in pixels. */
const PROFILE_HEIGHT_PX = 96;

/** The margin around the drawing of the ground track, in pixels. */
const TRACK_MARGIN_PX = 18;

/** Builds an element with a class and, maybe, some text. */
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The drawing context of a canvas, or nothing when the browser has none. */
function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext('2d');
  } catch {
    return null;
  }
}

/**
 * The outcome of the landing, in one line of plain words.
 *
 * @param data the debrief of the jump
 * @param units the units of the drop zone
 */
function outcomeSentence(data: DebriefData, units: UnitSystem): string {
  const landing = data.landing;
  if (!landing) return 'The jump ended without a landing.';

  const distance = formatDistance(landing.distanceFromTargetM, units);
  const speed = formatSpeed(landing.verticalMs, units);

  switch (landing.outcome) {
    case 'stand-up':
      return `Stand-up landing, ${distance} from the target.`;
    case 'run-out':
      return `You ran it out on your feet, ${distance} from the target.`;
    case 'slide':
      return `You slid on the landing, ${distance} from the target.`;
    case 'plf':
      return `PLF. Good roll, ${distance} from the target.`;
    case 'sprain':
      return `Sprained ankle: you landed at ${speed} without a PLF.`;
    case 'injury':
      return `Injury: you hit the ground at ${speed}.`;
    case 'fatal':
      return `You hit the ground at ${speed}. It was fatal.`;
  }
}

/**
 * The sentence a flag is given.
 *
 * @param flag the flag of the debrief
 * @param units the units of the drop zone
 */
function flagSentence(flag: DebriefFlag, units: UnitSystem): string {
  switch (flag) {
    case 'low-turn':
      return `Low turn: you turned more than 90 degrees below ${formatAltitude(LOW_TURN_FT * FT, units)}.`;
    case 'late-pull':
      return `Late pull: you threw the canopy more than ${formatAltitude(LATE_PULL_FT * FT, units)} below your plan.`;
    case 'no-pull':
      return 'You never pulled: the canopy came out on its own.';
    case 'downwind-landing':
      return 'You landed downwind, into the wind.';
    case 'hard-opening':
      return 'That was a hard opening.';
    case 'aad-fire':
      return 'The AAD fired the reserve for you.';
    case 'impact':
      return 'You hit the ground without a canopy over you.';
  }
}

/** How a turn of the pattern is described. */
function turnSentence(
  turn: DebriefData['patternTurns'][number],
  units: UnitSystem,
): string {
  const way = turn.headingChangeDeg >= 0 ? 'right' : 'left';
  const degrees = Math.round(Math.abs(turn.headingChangeDeg));
  return (
    `${degrees}° to the ${way}, from ${formatAltitude(turn.startAglM, units)} ` +
    `to ${formatAltitude(turn.endAglM, units)}`
  );
}

/** The screen with the account of the jump. */
export class DebriefScreen {
  /** The screen, over the world behind it. */
  private readonly screen: HTMLDivElement;

  /** The panel the jumper reads. */
  private readonly panel: HTMLDivElement;

  /** The name of the drop zone. */
  private readonly title: HTMLHeadingElement;

  /** The canopy the jumper flew. */
  private readonly subtitle: HTMLParagraphElement;

  /** The outcome, in one line. */
  private readonly outcome: HTMLParagraphElement;

  /** The numbers of the jump. */
  private readonly numbers: HTMLDListElement;

  /** The flags of the jump. */
  private readonly flags: HTMLUListElement;

  /** The altitude against the time. */
  private readonly profile: HTMLCanvasElement;

  /** The ground track from above. */
  private readonly track: HTMLCanvasElement;

  /** The button that asks for the next jump. */
  private readonly againButton: HTMLButtonElement;

  /** Called when the jumper asks for another jump. */
  onAgain: (() => void) | null = null;

  /**
   * @param root where the screen is put
   * @param units the units of the drop zone the jump was made over
   */
  constructor(
    root: HTMLElement,
    private readonly units: UnitSystem,
  ) {
    this.screen = element('div', 'debrief');
    this.screen.dataset.role = 'debrief';
    this.screen.hidden = true;

    this.panel = element('div', 'debrief-panel');

    this.title = element('h2', 'debrief-title');
    this.title.dataset.role = 'debrief-title';
    this.panel.appendChild(this.title);

    this.subtitle = element('p', 'debrief-subtitle');
    this.subtitle.dataset.role = 'debrief-subtitle';
    this.panel.appendChild(this.subtitle);

    this.outcome = element('p', 'debrief-outcome');
    this.outcome.dataset.role = 'outcome';
    this.panel.appendChild(this.outcome);

    this.numbers = element('dl', 'debrief-numbers');
    this.numbers.dataset.role = 'numbers';
    this.panel.appendChild(this.numbers);

    this.flags = element('ul', 'debrief-flags');
    this.flags.dataset.role = 'flags';
    this.flags.hidden = true;
    this.panel.appendChild(this.flags);

    this.profile = element('canvas', 'debrief-profile');
    this.profile.dataset.role = 'profile';
    this.profile.width = PROFILE_WIDTH_PX;
    this.profile.height = PROFILE_HEIGHT_PX;
    this.panel.appendChild(this.figure('Altitude against time', this.profile));

    this.track = element('canvas', 'debrief-track');
    this.track.dataset.role = 'track';
    this.track.width = TRACK_WIDTH_PX;
    this.track.height = TRACK_HEIGHT_PX;
    this.panel.appendChild(this.figure('Ground track', this.track));

    this.againButton = element('button', 'debrief-again', 'Jump again');
    this.againButton.type = 'button';
    this.againButton.dataset.action = 'jump-again';
    this.againButton.addEventListener('click', () => this.onAgain?.());
    this.panel.appendChild(this.againButton);

    this.screen.appendChild(this.panel);
    root.appendChild(this.screen);
  }

  /**
   * Shows the account of a jump.
   *
   * @param data the numbers and the flags of the jump
   * @param o the drop zone, the canopy and the ground track of the jump
   */
  show(
    data: DebriefData,
    o: { dzName: string; canopyName: string; lzRadiusM: number; track?: TrackSample[] },
  ): void {
    this.title.textContent = o.dzName;
    this.subtitle.textContent = o.canopyName;
    this.outcome.textContent = outcomeSentence(data, this.units);

    this.fillNumbers(data);
    this.fillFlags(data);

    const track = o.track ?? [];
    this.drawProfile(track);
    this.drawTrack(track, o.lzRadiusM, data);

    this.screen.hidden = false;
  }

  /** Takes the screen off the page. */
  dispose(): void {
    this.screen.remove();
  }

  /** A drawing with its caption. */
  private figure(caption: string, canvas: HTMLCanvasElement): HTMLDivElement {
    const box = element('div', 'debrief-figure');
    box.appendChild(canvas);
    box.appendChild(element('p', 'debrief-caption', caption));
    return box;
  }

  /** The numbers of the jump, one row each. */
  private fillNumbers(data: DebriefData): void {
    this.numbers.textContent = '';

    this.row('Exit', formatAltitude(data.exitAltitudeAglM, this.units));
    this.row('Freefall', `${Math.round(data.freefallTimeS)} s`);
    this.row(
      'Deployment',
      data.deploymentAltitudeAglM === null
        ? 'never'
        : formatAltitude(data.deploymentAltitudeAglM, this.units),
    );
    this.row('Max vertical speed', formatSpeed(data.maxVerticalMs, this.units));
    this.row('Average vertical speed', formatSpeed(data.avgVerticalMs, this.units));
    this.row('Opening', `${data.maxOpeningG.toFixed(1)} g`);
    this.row('Canopy time', `${Math.round(data.canopyTimeS)} s`);

    for (const turn of data.patternTurns) {
      this.row('Turn', turnSentence(turn, this.units));
    }

    const landing = data.landing;
    if (landing) {
      this.row('Touchdown', formatSpeed(landing.verticalMs, this.units));
      this.row('Ground speed', formatSpeed(landing.groundSpeedMs, this.units));
      this.row('Distance from target', formatDistance(landing.distanceFromTargetM, this.units));
      this.row('Bearing from target', `${Math.round(landing.bearingFromTargetDeg)}°`);
      this.row(
        'Wind at touchdown',
        `${formatSpeed(landing.windMs, this.units)} from ${Math.round(landing.windFromDeg)}°`,
      );
    }
  }

  /** One row of the numbers. */
  private row(label: string, value: string): void {
    const row = element('div', 'debrief-row');
    row.appendChild(element('dt', 'debrief-label', label));
    row.appendChild(element('dd', 'debrief-value', value));
    this.numbers.appendChild(row);
  }

  /** The flags, one sentence each. */
  private fillFlags(data: DebriefData): void {
    this.flags.textContent = '';
    for (const flag of data.flags) {
      this.flags.appendChild(element('li', 'debrief-flag', flagSentence(flag, this.units)));
    }
    this.flags.hidden = data.flags.length === 0;
  }

  /**
   * The altitude against the time.
   *
   * The height is the height above the landing area, so the ground is the
   * bottom of the picture and the exit is the top.
   */
  private drawProfile(track: TrackSample[]): void {
    const ctx = context2d(this.profile);
    if (!ctx) return;
    const width = this.profile.width;
    const height = this.profile.height;
    ctx.clearRect(0, 0, width, height);
    if (track.length < 2) return;

    let maxAgl = 0;
    let maxT = 0;
    for (const sample of track) {
      if (sample.aglM > maxAgl) maxAgl = sample.aglM;
      if (sample.tS > maxT) maxT = sample.tS;
    }
    if (maxT <= 0) return;

    const margin = 6;
    const toX = (tS: number): number => margin + (tS / maxT) * (width - 2 * margin);
    const toY = (aglM: number): number =>
      height - margin - (aglM / maxAgl) * (height - 2 * margin);

    // The ground line and the shape of the jump.
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(margin, height - margin);
    ctx.lineTo(width - margin, height - margin);
    ctx.stroke();

    ctx.strokeStyle = '#f0f3f8';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let first = true;
    for (const sample of track) {
      const x = toX(sample.tS);
      const y = toY(sample.aglM);
      if (first) {
        ctx.moveTo(x, y);
        first = false;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    // The numbers at the corners: the height of the exit and the length of
    // the jump.
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(formatAltitude(maxAgl, this.units), margin, margin + 8);
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(maxT)} s`, width - margin, height - 2);
  }

  /**
   * The ground track from above.
   *
   * The landing area is the circle at the centre, the target is the cross in
   * the middle of it, and the track is the path the jumper took. North is up.
   */
  private drawTrack(
    track: TrackSample[],
    lzRadiusM: number,
    data: DebriefData,
  ): void {
    const ctx = context2d(this.track);
    if (!ctx) return;
    const width = this.track.width;
    const height = this.track.height;
    ctx.clearRect(0, 0, width, height);

    // The bounds of the track and of the landing area.
    let minX = -lzRadiusM;
    let maxX = lzRadiusM;
    let minZ = -lzRadiusM;
    let maxZ = lzRadiusM;
    for (const sample of track) {
      minX = Math.min(minX, sample.pos.x);
      maxX = Math.max(maxX, sample.pos.x);
      minZ = Math.min(minZ, sample.pos.z);
      maxZ = Math.max(maxZ, sample.pos.z);
    }

    // The same scale on both axes, so the shape of the track is true.
    const spanX = Math.max(maxX - minX, 1);
    const spanZ = Math.max(maxZ - minZ, 1);
    const scale = Math.min(
      (width - 2 * TRACK_MARGIN_PX) / spanX,
      (height - 2 * TRACK_MARGIN_PX) / spanZ,
    );
    const centreX = (minX + maxX) / 2;
    const centreZ = (minZ + maxZ) / 2;
    // North is up, so the south of the drop zone is down the picture.
    const toX = (x: number): number => width / 2 + (x - centreX) * scale;
    const toY = (z: number): number => height / 2 + (z - centreZ) * scale;

    // The landing area and the target.
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(toX(0), toY(0), Math.max(2, lzRadiusM * scale), 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = '#f0f3f8';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(toX(0) - 5, toY(0));
    ctx.lineTo(toX(0) + 5, toY(0));
    ctx.moveTo(toX(0), toY(0) - 5);
    ctx.lineTo(toX(0), toY(0) + 5);
    ctx.stroke();

    // The track: the freefall in grey, the canopy in white.
    this.strokeRun(ctx, track, 'freefall', 'rgba(255,255,255,0.45)', 1, toX, toY);
    this.strokeRun(ctx, track, 'canopy', '#f0f3f8', 2, toX, toY);

    // The scale bar, and the wind.
    this.drawScaleBar(ctx, scale, height);
    this.drawWindArrow(ctx, data, width);
  }

  /**
   * Draws the samples of one phase of the jump as a line.
   *
   * @param ctx the drawing context
   * @param track the samples of the track
   * @param phase the phase to draw
   * @param colour the colour of the line
   * @param lineWidth the width of the line
   * @param toX where a point of the ground is on the picture
   * @param toY where a point of the ground is on the picture
   */
  private strokeRun(
    ctx: CanvasRenderingContext2D,
    track: TrackSample[],
    phase: TrackSample['phase'],
    colour: string,
    lineWidth: number,
    toX: (x: number) => number,
    toY: (z: number) => number,
  ): void {
    ctx.strokeStyle = colour;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    let drawing = false;
    for (const sample of track) {
      if (sample.phase !== phase) {
        drawing = false;
        continue;
      }
      const x = toX(sample.pos.x);
      const y = toY(sample.pos.z);
      if (!drawing) {
        ctx.moveTo(x, y);
        drawing = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }

  /** The bar that says how big a part of the picture is. */
  private drawScaleBar(
    ctx: CanvasRenderingContext2D,
    scale: number,
    height: number,
  ): void {
    // A round length: 1, 2 or 5 times a power of ten, in metres.
    const targetPx = 60;
    const raw = targetPx / Math.max(scale, 1e-6);
    const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))));
    const nice = [1, 2, 5, 10].map((m) => m * magnitude).find((m) => m * scale >= 30) ?? raw;

    const x = TRACK_MARGIN_PX;
    const y = height - TRACK_MARGIN_PX;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + nice * scale, y);
    ctx.moveTo(x, y - 3);
    ctx.lineTo(x, y + 3);
    ctx.moveTo(x + nice * scale, y - 3);
    ctx.lineTo(x + nice * scale, y + 3);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(formatDistance(nice, this.units), x, y - 6);
  }

  /** The arrow that says which way the wind was blowing. */
  private drawWindArrow(ctx: CanvasRenderingContext2D, data: DebriefData, width: number): void {
    const landing = data.landing;
    if (!landing) return;

    // The wind comes FROM its bearing, so it blows towards the other side.
    const towards = ((landing.windFromDeg + 180) % 360) * (Math.PI / 180);
    const centreX = width - TRACK_MARGIN_PX - 16;
    const centreY = TRACK_MARGIN_PX + 16;
    const length = 14;

    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(centreX, centreY);
    ctx.lineTo(centreX + Math.sin(towards) * length, centreY - Math.cos(towards) * length);
    ctx.stroke();

    // The head of the arrow.
    const tipX = centreX + Math.sin(towards) * length;
    const tipY = centreY - Math.cos(towards) * length;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - Math.sin(towards - 0.4) * 6, tipY + Math.cos(towards - 0.4) * 6);
    ctx.lineTo(tipX - Math.sin(towards + 0.4) * 6, tipY + Math.cos(towards + 0.4) * 6);
    ctx.closePath();
    ctx.fill();

    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(formatSpeed(landing.windMs, this.units), centreX + 14, centreY + 4);
  }
}
