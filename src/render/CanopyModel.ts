/**
 * The canopy you look up at.
 *
 * The wing is built out of nothing: a row of cells along an arc, a bulge in
 * each cell, ribs between them, three cascades of lines down to two risers,
 * the slider and the brake lines. It is the canopy as a first-person player
 * sees it: the arc and the cells from below, the lines coming down to the
 * shoulders, and the trailing edge dropping when a toggle is pulled.
 *
 * The object is the jumper's. Its origin is at the risers, on the jumper's
 * shoulders, and the wing is six metres above them, up the lines. The
 * jumper hangs below the canopy, so the swing moves the wing the opposite
 * way to the jumper: a jumper swung ahead of the canopy leaves the wing
 * behind them, tipped back.
 */

import * as THREE from 'three';
import type { CanopySpec } from '@/data/canopies';
import { FT } from '@/sim/units';
import { cross, normalize, quatFromAxisAngle, quatMultiply, type Vec3 } from '@/sim/vec3';

/** The length of the lines, from the jumper's shoulders to the canopy, in metres. */
const LINE_LENGTH_M = 6;

/**
 * The most the arc of the wing may bend on each side, in radians.
 *
 * The lines run from the jumper's shoulders to the wing at about the same
 * length, so the span curves around the jumper on a radius close to the line
 * length: about 35 degrees each side for a 210. The cap keeps a big student
 * canopy from curling into a half pipe.
 */
const MAX_HALF_ARC_RAD = (40 * Math.PI) / 180;

/** How far the brake pulls the trailing edge down at the tip, in metres. */
const BRAKE_DROP_M = 0.6;

/** Where the brake starts to pull, and where it pulls all the way. */
const BRAKE_START = 0.45;
const BRAKE_FULL = 0.95;

/** How thick the wing is at its thickest, as a fraction of the chord. */
const THICKNESS_RATIO = 0.13;

/** How much thinner the wing is at a rib than in the middle of a cell. */
const RIB_THINNING = 0.8;

/** How far the chord of the wing sweeps back at the tips. */
const SWEEP = 0.25;

/** The number of stations along the chord of the wing. */
const CHORD_COUNT = 8;

/** Where the two risers come down to the jumper's shoulders, in metres. */
const RISER_X = 0.22;

/** Where the toggles hang, at the jumper's hands, in metres. */
const TOGGLE_X = 0.3;
const TOGGLE_Y = -0.3;

/** The fraction of the chord the middle cascade of lines comes off at. */
const MIDDLE_CASCADE = 0.345;

/** The colours of a canopy: the top, the ribs and the nose, and the shade. */
interface Palette {
  top: THREE.Color;
  accent: THREE.Color;
  bottom: THREE.Color;
}

/** The colours of each of the canopies. */
function paletteFor(spec: CanopySpec): Palette {
  switch (spec.id) {
    case 'student-280':
      return {
        top: new THREE.Color('#2f6fd0'),
        accent: new THREE.Color('#f0f3f8'),
        bottom: new THREE.Color('#4f86d8'),
      };
    case 'sport-210':
    case 'sport-170':
      return {
        top: new THREE.Color('#c0392b'),
        accent: new THREE.Color('#16181c'),
        bottom: new THREE.Color('#7c2b21'),
      };
    case 'elliptical-150':
      return {
        top: new THREE.Color('#e0b01e'),
        accent: new THREE.Color('#16181c'),
        bottom: new THREE.Color('#8f7418'),
      };
    case 'reserve-220':
      return {
        top: new THREE.Color('#f2f4f7'),
        accent: new THREE.Color('#dfe3e8'),
        bottom: new THREE.Color('#c8cdd4'),
      };
  }
}

/** One spanwise station of the wing: a rib, or the middle of a cell. */
interface Station {
  /** The spanwise position, from -1 at the left tip to 1 at the right tip. */
  u: number;
  /** How inflated the cell is here: full in a cell, less at a rib. */
  bulge: number;
  /** True at a rib, where the cells either side of it are gathered. */
  rib: boolean;
}

/** The shape of the wing at one spanwise station. */
interface WingFrame {
  /** The middle of the chord. */
  centre: Vec3;
  /** The direction from the leading edge to the trailing edge. */
  chord: Vec3;
  /** The direction of the top of the wing. */
  up: Vec3;
}

/** One line of the canopy, from a point on the wing to a point on the jumper. */
interface Segment {
  kind: 'riser' | 'cascade' | 'brake';
  /** The point on the wing, in the wing's own frame. */
  wing: Vec3;
  /** The point on the jumper: a riser, a toggle or a shoulder. */
  jumper: Vec3;
  /** Which side of the canopy the line is on: -1 left, 1 right. */
  side: number;
}

/** The wing as it is built: the geometry and the shapes it is made of. */
interface BuiltWing {
  geometry: THREE.BufferGeometry;
  /** The positions of the wing before the brakes are pulled. */
  positions: Float32Array;
  /** The colours of the wing before the light is baked into them. */
  colours: Float32Array;
}

/**
 * The stations of the wing: a rib at every cell boundary and the middle of
 * each cell between them.
 */
function stationsFor(cells: number): Station[] {
  const stations: Station[] = [];
  for (let cell = 0; cell < cells; cell++) {
    stations.push({ u: -1 + (2 * cell) / cells, bulge: RIB_THINNING, rib: true });
    stations.push({ u: -1 + (2 * (cell + 0.5)) / cells, bulge: 1, rib: false });
  }
  stations.push({ u: 1, bulge: RIB_THINNING, rib: true });
  return stations;
}

/**
 * The shape of the wing at a station: where the chord is, which way it
 * points and which way is up.
 *
 * The span of the wing is an arc, so the tips hang below the middle of it,
 * and the chord sweeps back a little at the tips, so the leading edge
 * curves.
 */
function frameAt(u: number, halfSpan: number): WingFrame {
  const half = Math.min(Math.asin(Math.min(1, halfSpan / LINE_LENGTH_M)), MAX_HALF_ARC_RAD);
  const angle = u * half;
  const radius = halfSpan / Math.sin(half);

  const centre: Vec3 = {
    x: radius * Math.sin(angle),
    y: -radius * (1 - Math.cos(angle)),
    z: 0,
  };
  const chord = normalize({ x: SWEEP * Math.sin(angle), y: 0, z: 1 });
  const tangent: Vec3 = { x: Math.cos(angle), y: -Math.sin(angle), z: 0 };
  return { centre, chord, up: normalize(cross(chord, tangent)) };
}

/**
 * The chordwise station of the wing, as a fraction of the chord.
 *
 * The nose is round and the trailing edge is thin, so the stations crowd
 * towards the nose.
 */
function chordFraction(index: number): number {
  return Math.pow(index / (CHORD_COUNT - 1), 1.7);
}

/**
 * The thickness of the wing at a fraction of the chord, in metres.
 *
 * The section is deepest about a third of the way back and closes up at
 * both ends, though never quite to a knife edge.
 */
function thicknessAt(fraction: number, maxThickness: number): number {
  const shape = Math.pow(fraction, 0.45) * Math.pow(1 - fraction, 0.85) * 2.31;
  return maxThickness * (0.015 + 0.985 * shape);
}

/** A point on the surface of the wing. */
function surfacePoint(
  frame: WingFrame,
  chordLength: number,
  fraction: number,
  thickness: number,
  top: boolean,
): Vec3 {
  const along = scaleOf(frame.chord, chordLength * (fraction - 0.5));
  const off = scaleOf(frame.up, thickness * (top ? 1 : -1));
  return {
    x: frame.centre.x + along.x + off.x,
    y: frame.centre.y + along.y + off.y,
    z: frame.centre.z + along.z + off.z,
  };
}

/** A vector scaled by a factor. */
function scaleOf(v: Vec3, factor: number): Vec3 {
  return { x: v.x * factor, y: v.y * factor, z: v.z * factor };
}

/** Two colours mixed together. */
function mixColour(a: THREE.Color, b: THREE.Color, t: number): THREE.Color {
  return new THREE.Color(
    a.r + (b.r - a.r) * t,
    a.g + (b.g - a.g) * t,
    a.b + (b.b - a.b) * t,
  );
}

/** Keeps a number inside the range from zero to one. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * How much of the brake reaches a station of the span, from 0 in the
 * middle of the wing to 1 at the tip.
 */
function brakeWeight(u: number): number {
  const t = clamp01((Math.abs(u) - BRAKE_START) / (BRAKE_FULL - BRAKE_START));
  return t * t * (3 - 2 * t);
}

/**
 * The canopy, built out of nothing.
 *
 * The model is the jumper's: it sits at the risers and the wing is up the
 * lines from there. The caller puts the model in the scene at the jumper's
 * shoulders and tells it where the canopy is flying.
 */
export class CanopyModel {
  /** The canopy, to be added to the scene at the jumper's shoulders. */
  readonly object: THREE.Object3D;

  /** The number of vertices in the loop round a section of the wing. */
  private readonly loopCount = CHORD_COUNT * 2;

  private readonly spec: CanopySpec;

  /** The span of the wing, in metres. */
  private readonly spanM: number;

  /** The chord of the wing, in metres. */
  private readonly chordM: number;

  /** The stations of the wing, from the left tip to the right tip. */
  private readonly stations: Station[];

  /** The wing itself, inside the group that holds it up the lines. */
  private readonly wing: THREE.Mesh;

  /** The group that holds the wing up the lines. */
  private readonly wingGroup: THREE.Object3D;

  /** The geometry of the wing. */
  private readonly wingGeometry: THREE.BufferGeometry;

  /** The positions of the wing before the brakes are pulled. */
  private readonly basePositions: Float32Array;

  /** The colours of the wing before the light is baked into them. */
  private readonly baseColours: Float32Array;

  /** The lines from the wing to the jumper. */
  private readonly lines: THREE.LineSegments;

  /** The lines themselves, so they can be moved when the wing moves. */
  private readonly segments: Segment[];

  /** The slider, riding up and down the lines. */
  private readonly slider: THREE.Mesh;

  private brakeLeft = 0;
  private brakeRight = 0;

  /** How inflated the canopy is, from 0 to 1. */
  private inflation = 1;

  /** Where the slider is: 1 up at the canopy, 0 down at the risers. */
  private sliderAt = 0;

  /** How far the wing is up the lines, in metres. */
  private heightM = LINE_LENGTH_M;

  /** How the wing is scaled, from the inflation. */
  private scaleX = 1;
  private scaleY = 1;
  private scaleZ = 1;

  constructor(spec: CanopySpec) {
    this.spec = spec;
    const areaM2 = spec.areaFt2 * FT * FT;
    const aspect = spec.cells === 7 ? 2.0 : 2.4;
    this.spanM = Math.sqrt(areaM2 * aspect);
    this.chordM = areaM2 / this.spanM;
    this.stations = stationsFor(spec.cells);

    this.object = new THREE.Object3D();
    this.object.name = 'canopy';

    this.wingGroup = new THREE.Object3D();
    this.wingGroup.name = 'wing-group';
    this.object.add(this.wingGroup);

    const built = this.buildWing();
    this.wingGeometry = built.geometry;
    this.basePositions = built.positions;
    this.baseColours = built.colours;

    this.wing = new THREE.Mesh(
      this.wingGeometry,
      new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }),
    );
    this.wing.name = 'wing';
    this.wingGroup.add(this.wing);

    this.segments = this.buildSegments();
    this.lines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0x2b3038 }),
    );
    this.lines.name = 'lines';
    this.lines.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(this.segments.length * 6), 3),
    );
    this.object.add(this.lines);

    this.slider = new THREE.Mesh(
      new THREE.PlaneGeometry(0.13, 0.17),
      new THREE.MeshBasicMaterial({ color: 0x3c434c, side: THREE.DoubleSide }),
    );
    this.slider.name = 'slider';
    this.object.add(this.slider);

    this.applyInflation();
    this.applyBrakes();
    this.setPose({ headingRad: 0, bank: 0, swingFore: 0, swingSide: 0 });
  }

  /**
   * Where the canopy is flying and where the jumper is hanging.
   *
   * The object is turned by the heading and then by the swing, which is the
   * jumper's own body: the head hangs from the risers, so a jumper swung
   * ahead of the canopy has their head tipped back and the wing behind
   * them. The canopy itself is banked about its own forward axis.
   */
  setPose(o: { headingRad: number; bank: number; swingFore: number; swingSide: number }): void {
    const yaw = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, -o.headingRad);
    const pitch = quatFromAxisAngle({ x: 1, y: 0, z: 0 }, o.swingFore);
    const roll = quatFromAxisAngle({ x: 0, y: 0, z: 1 }, o.swingSide);
    const body = quatMultiply(quatMultiply(yaw, pitch), roll);
    this.object.quaternion.set(body.x, body.y, body.z, body.w);

    // The right wing of a canopy in a right turn goes down.
    const bank = quatFromAxisAngle({ x: 0, y: 0, z: 1 }, -o.bank);
    this.wing.quaternion.set(bank.x, bank.y, bank.z, bank.w);
  }

  /**
   * How inflated the canopy is and where the slider is.
   *
   * At zero the canopy is a bundle in the bag, at half it is snivelling
   * with the slider up, and at one it is flying.
   */
  setInflation(inflation: number, slider: number): void {
    this.inflation = clamp01(inflation);
    this.sliderAt = clamp01(slider);
    this.applyInflation();
  }

  /**
   * How far the brakes are pulled, from 0 to 1.
   *
   * The brake pulls the trailing edge down at the tip of its side of the
   * wing, and the brake line follows it.
   */
  setBrakes(left: number, right: number): void {
    this.brakeLeft = clamp01(left);
    this.brakeRight = clamp01(right);
    this.applyBrakes();
  }

  /** Let go of the geometry and the materials. */
  dispose(): void {
    this.wingGeometry.dispose();
    (this.wing.material as THREE.Material).dispose();
    this.lines.geometry.dispose();
    (this.lines.material as THREE.Material).dispose();
    this.slider.geometry.dispose();
    (this.slider.material as THREE.Material).dispose();
  }

  /**
   * The wing: a row of cells along an arc, with a top skin, a bottom skin
   * and a rib between every two cells.
   */
  private buildWing(): BuiltWing {
    const loopCount = this.loopCount;
    const vertexCount = this.stations.length * loopCount;

    const position = new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3);
    const color = new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3);
    const palette = paletteFor(this.spec);
    const maxThickness = this.chordM * THICKNESS_RATIO;

    for (const [index, station] of this.stations.entries()) {
      const frame = frameAt(station.u, this.spanM / 2);
      const base = index * loopCount;

      for (let c = 0; c < CHORD_COUNT; c++) {
        const fraction = chordFraction(c);
        const thickness = thicknessAt(fraction, maxThickness) * station.bulge;

        const top = surfacePoint(frame, this.chordM, fraction, thickness, true);
        const bottom = surfacePoint(frame, this.chordM, fraction, thickness, false);
        position.setXYZ(base + c, top.x, top.y, top.z);
        position.setXYZ(base + CHORD_COUNT + c, bottom.x, bottom.y, bottom.z);

        // The ribs, the nose and the trailing edge are the accent colour,
        // and the underside is in the shade of the top.
        const panel = station.rib ? mixColour(palette.top, palette.accent, 0.55) : palette.top;
        const topColour = fraction === 0 ? palette.accent : panel;
        const bottomColour = fraction === 0 ? palette.accent : palette.bottom;
        color.setXYZ(base + c, topColour.r, topColour.g, topColour.b);
        color.setXYZ(base + CHORD_COUNT + c, bottomColour.r, bottomColour.g, bottomColour.b);
      }
    }

    // The surface: a loop of the top skin, the trailing edge and the bottom
    // skin, run along the span.
    const indices: number[] = [];
    for (let s = 0; s < this.stations.length - 1; s++) {
      const here = s * loopCount;
      const next = (s + 1) * loopCount;
      for (let i = 0; i < loopCount; i++) {
        const a = here + this.loopVertex(i);
        const b = here + this.loopVertex((i + 1) % loopCount);
        const c = next + this.loopVertex((i + 1) % loopCount);
        const d = next + this.loopVertex(i);
        indices.push(a, b, c, a, c, d);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', position);
    geometry.setAttribute('color', color);
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    // The world is drawn unlit, so the shape of the canopy has to come from
    // its own colours: the top of the wing catches the sky and the
    // underside is in its shade.
    const colours = new Float32Array(color.array as Float32Array);
    const normals = geometry.getAttribute('normal');
    for (let i = 0; i < color.count; i++) {
      const light = 0.45 + 0.55 * (0.5 + 0.5 * normals.getY(i));
      color.setXYZ(
        i,
        (colours[i * 3] ?? 0) * light,
        (colours[i * 3 + 1] ?? 0) * light,
        (colours[i * 3 + 2] ?? 0) * light,
      );
    }

    geometry.computeBoundingSphere();
    return {
      geometry,
      positions: new Float32Array(position.array as Float32Array),
      colours,
    };
  }

  /**
   * The vertex of the loop of the section that the index points at.
   *
   * The loop runs along the top skin from the nose to the trailing edge,
   * down the trailing edge and back along the bottom skin to the nose.
   */
  private loopVertex(index: number): number {
    if (index < CHORD_COUNT) return index;
    return CHORD_COUNT * 3 - 1 - index;
  }

  /**
   * The lines: two risers to the jumper's shoulders, three cascades down
   * to the risers, and the brake lines to the toggles.
   */
  private buildSegments(): Segment[] {
    const segments: Segment[] = [];

    for (const side of [-1, 1] as const) {
      // The riser: from the shoulder up to the middle of the canopy.
      segments.push({
        kind: 'riser',
        wing: this.wingPointOf(0, MIDDLE_CASCADE),
        jumper: { x: side * RISER_X, y: 0, z: 0 },
        side,
      });

      // The cascades of lines, from the nose, the middle and the trailing
      // edge of the wing down to the riser.
      for (const fraction of [0, MIDDLE_CASCADE, 1]) {
        for (const u of side < 0 ? [-1, -0.66, -0.33] : [0.33, 0.66, 1]) {
          segments.push({
            kind: 'cascade',
            wing: this.wingPointOf(u, fraction),
            jumper: { x: side * RISER_X, y: 0, z: 0 },
            side,
          });
        }
      }

      // The brake line, from the trailing edge of the tip to the toggle.
      segments.push({
        kind: 'brake',
        wing: this.trailingEdge(side),
        jumper: { x: side * TOGGLE_X, y: TOGGLE_Y, z: 0 },
        side,
      });
    }

    return segments;
  }

  /** A point on the top skin of the wing, in the wing's own frame. */
  private wingPointOf(u: number, fraction: number): Vec3 {
    const frame = frameAt(u, this.spanM / 2);
    const station = this.stationNear(u);
    const thickness = thicknessAt(fraction, this.chordM * THICKNESS_RATIO) * station.bulge;
    return surfacePoint(frame, this.chordM, fraction, thickness, true);
  }

  /** The station of the wing nearest a spanwise position. */
  private stationNear(u: number): Station {
    let best: Station = { u: 0, bulge: 1, rib: false };
    let bestGap = Infinity;
    for (const station of this.stations) {
      const gap = Math.abs(station.u - u);
      if (gap < bestGap) {
        bestGap = gap;
        best = station;
      }
    }
    return best;
  }

  /** The trailing edge at a tip, with the brake pulled down on it. */
  private trailingEdge(side: number): Vec3 {
    const point = this.wingPointOf(side, 1);
    return { x: point.x, y: point.y - this.brakeDrop(side), z: point.z };
  }

  /** How far the brake has pulled the trailing edge down at a station. */
  private brakeDrop(u: number): number {
    const side = u >= 0 ? this.brakeRight : this.brakeLeft;
    return side * brakeWeight(u) * BRAKE_DROP_M;
  }

  /** Puts the wing where the inflation and the slider say. */
  private applyInflation(): void {
    const f = this.inflation;
    this.scaleX = 0.08 + 0.92 * Math.pow(f, 0.55);
    this.scaleY = 0.05 + 0.95 * Math.pow(f, 1.3);
    this.scaleZ = 0.15 + 0.85 * Math.pow(f, 0.5);
    this.heightM = LINE_LENGTH_M * Math.pow(f, 0.5);

    this.wingGroup.scale.set(this.scaleX, this.scaleY, this.scaleZ);
    this.wingGroup.position.set(0, this.heightM, 0);
    this.slider.position.set(0, this.sliderAt * this.heightM * 0.92, 0);

    this.updateLines();
  }

  /** Pulls the trailing edges down and puts the lines back. */
  private applyBrakes(): void {
    const position = this.wingGeometry.getAttribute('position');

    for (const [index, station] of this.stations.entries()) {
      const drop = this.brakeDrop(station.u);
      const base = index * this.loopCount;
      // The trailing edge of the section: the top of it and the bottom.
      for (const vertex of [base + CHORD_COUNT - 1, base + this.loopCount - 1]) {
        position.setY(vertex, (this.basePositions[vertex * 3 + 1] ?? 0) - drop);
      }
    }

    position.needsUpdate = true;
    this.wingGeometry.computeVertexNormals();
    this.bakeLight();
    this.wingGeometry.computeBoundingSphere();
    this.updateLines();
  }

  /** Moves the lines to follow the wing. */
  private updateLines(): void {
    const attribute = this.lines.geometry.getAttribute('position');

    for (const [index, segment] of this.segments.entries()) {
      const wing = segment.kind === 'brake' ? this.trailingEdge(segment.side) : segment.wing;
      const scaled = this.wingPointInScene(wing);
      attribute.setXYZ(index * 2, scaled.x, scaled.y, scaled.z);
      attribute.setXYZ(index * 2 + 1, segment.jumper.x, segment.jumper.y, segment.jumper.z);
    }

    attribute.needsUpdate = true;
    this.lines.geometry.computeBoundingSphere();
  }

  /** A point of the wing, in the jumper's frame. */
  private wingPointInScene(point: Vec3): Vec3 {
    return {
      x: point.x * this.scaleX,
      y: point.y * this.scaleY + this.heightM,
      z: point.z * this.scaleZ,
    };
  }

  /**
   * Bakes the light into the colours of the wing.
   *
   * The world is drawn unlit, so the shape of the canopy comes from its own
   * colours: the top of the wing catches the sky and the underside is in
   * its shade.
   */
  private bakeLight(): void {
    const normals = this.wingGeometry.getAttribute('normal');
    const color = this.wingGeometry.getAttribute('color');

    for (let i = 0; i < color.count; i++) {
      const light = 0.45 + 0.55 * (0.5 + 0.5 * normals.getY(i));
      color.setXYZ(
        i,
        (this.baseColours[i * 3] ?? 0) * light,
        (this.baseColours[i * 3 + 1] ?? 0) * light,
        (this.baseColours[i * 3 + 2] ?? 0) * light,
      );
    }
    color.needsUpdate = true;
  }
}
