/**
 * The wrist altimeter.
 *
 * The altimeter is on the wrist, where a jumper reads it, and nowhere else:
 * a dark band, a bezel and a dial with a needle that reads the height above
 * the landing area. The face is drawn on a canvas, because the numerals and
 * the arcs are easier to draw than to model, and because the dial has to be
 * readable on a phone.
 *
 * The needle turns clockwise from the top, once for every 12,000 feet or
 * every 4,000 metres.
 */

import * as THREE from 'three';
import { FT, type UnitSystem } from '@/sim/units';

/** The height of the landing area on a full turn of the needle, in feet. */
const FULL_TURN_FT = 12000;

/** The height of the landing area on a full turn of the needle, in metres. */
const FULL_TURN_M = 4000;

/** The height at which the dial turns red, in feet. */
const RED_FT = 2000;

/** The height at which the dial turns yellow, in feet. */
const YELLOW_FT = 3000;

/** The height at which the dial turns red, in metres. */
const RED_M = 600;

/** The height at which the dial turns yellow, in metres. */
const YELLOW_M = 1000;

/** Where the watch sits on the wrist, in camera space. */
const WATCH_X = -0.09;
const WATCH_Y = -0.11;
const WATCH_Z = -0.3;

/** How far the face of the watch is tipped towards the eye, in radians. */
const TILT_RAD = (25 * Math.PI) / 180;

/** The radius of the dial, in metres. */
const FACE_RADIUS_M = 0.026;

/** The size of the canvas the dial is drawn on, in pixels. */
const CANVAS_SIZE = 512;

/** The radius of the coloured arcs on the dial, in pixels. */
const ARC_RADIUS = 244;

/** The radius of the outer end of the tick marks, in pixels. */
const TICK_RADIUS = 228;

/** The radius of the numerals, in pixels. */
const NUMERAL_RADIUS = 170;

/** The radius of the numeral of the full turn, in pixels. */
const FULL_SCALE_RADIUS = 126;

/**
 * The angle of the needle for a height, in radians clockwise from the top.
 *
 * The dial makes one turn for every 12,000 feet, or every 4,000 metres, and
 * the needle always sits inside that one turn.
 */
export function needleAngleRad(altitudeAglM: number, units: UnitSystem): number {
  const height = Math.max(0, altitudeAglM);
  const turns = units === 'ft' ? height / FT / FULL_TURN_FT : height / FULL_TURN_M;
  return (turns - Math.floor(turns)) * 2 * Math.PI;
}

/**
 * The analogue altimeter on the left wrist.
 *
 * The object is added to the camera: it sits at the lower left, a third of a
 * metre ahead, tipped towards the eye so that the dial can be read.
 */
export class WristAltimeter {
  /** The watch, to be added to the camera. */
  readonly object: THREE.Object3D;

  private readonly needle: THREE.Object3D;

  private readonly units: UnitSystem;

  constructor(units: UnitSystem) {
    this.units = units;
    this.object = new THREE.Object3D();
    this.object.name = 'wrist-altimeter';
    this.object.position.set(WATCH_X, WATCH_Y, WATCH_Z);
    faceTheEye(this.object);

    // The band of the watch, around the wrist and away from the eye.
    const band = new THREE.Mesh(
      bandGeometry(),
      new THREE.MeshBasicMaterial({ color: 0x191c21 }),
    );
    band.name = 'band';
    band.position.z = -0.045;
    this.object.add(band);

    // The case of the watch, and the bezel around the dial.
    const watchCase = new THREE.Mesh(
      caseGeometry(),
      new THREE.MeshBasicMaterial({ color: 0x24272c }),
    );
    watchCase.name = 'case';
    watchCase.position.z = -0.001;
    this.object.add(watchCase);

    const bezel = new THREE.Mesh(
      new THREE.RingGeometry(0.0252, 0.031, 24),
      new THREE.MeshBasicMaterial({ color: 0x3a3f47 }),
    );
    bezel.name = 'bezel';
    bezel.position.z = 0.005;
    this.object.add(bezel);

    // The dial itself.
    const face = new THREE.Mesh(this.faceGeometry(), this.faceMaterial());
    face.name = 'face';
    face.position.z = 0.0052;
    this.object.add(face);

    // The needle, on its own, so it can be turned.
    const needle = new THREE.Mesh(
      needleGeometry(),
      new THREE.MeshBasicMaterial({ color: 0xf2f4f8 }),
    );
    needle.name = 'needle';
    needle.position.z = 0.0068;
    this.object.add(needle);
    this.needle = needle;

    const hub = new THREE.Mesh(
      new THREE.CircleGeometry(0.0025, 8),
      new THREE.MeshBasicMaterial({ color: 0x9aa3ad }),
    );
    hub.name = 'hub';
    hub.position.z = 0.0072;
    this.object.add(hub);
  }

  /** Turn the needle to the height above the landing area. */
  setAltitude(aglM: number): void {
    this.needle.rotation.z = -needleAngleRad(aglM, this.units);
  }

  /** The face of the dial, with the drawing on it when there is one. */
  private faceGeometry(): THREE.CircleGeometry {
    return new THREE.CircleGeometry(FACE_RADIUS_M, 24);
  }

  /** The material of the dial: the drawing, or a dark face without one. */
  private faceMaterial(): THREE.MeshBasicMaterial {
    const texture = this.drawFace();
    if (!texture) return new THREE.MeshBasicMaterial({ color: 0x0d0f13 });
    return new THREE.MeshBasicMaterial({ map: texture });
  }

  /**
   * The drawing of the dial.
   *
   * A canvas without a drawing context (there is none in the tests) gives no
   * texture, and the face stays a dark disc with the needle on it.
   */
  private drawFace(): THREE.Texture | null {
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_SIZE;
    canvas.height = CANVAS_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    drawDial(ctx, this.units);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }
}

/** The band of the watch: a tube around the wrist. */
function bandGeometry(): THREE.CylinderGeometry {
  const geometry = new THREE.CylinderGeometry(0.033, 0.033, 0.07, 12, 1, true);
  geometry.rotateX(Math.PI / 2);
  return geometry;
}

/** The case of the watch: a short tube behind the dial. */
function caseGeometry(): THREE.CylinderGeometry {
  const geometry = new THREE.CylinderGeometry(0.0305, 0.0305, 0.012, 20, 1, true);
  geometry.rotateX(Math.PI / 2);
  return geometry;
}

/** The needle: a blade from the middle of the dial to its edge. */
function needleGeometry(): THREE.ShapeGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, -0.005);
  shape.lineTo(0.0016, 0);
  shape.lineTo(0, 0.0238);
  shape.lineTo(-0.0016, 0);
  shape.closePath();
  return new THREE.ShapeGeometry(shape);
}

/**
 * Tips the face of the watch towards the eye.
 *
 * The watch is below and to the left of the eye, so the face is turned up and
 * in towards it, and the numerals stay upright.
 */
function faceTheEye(object: THREE.Object3D): void {
  const eyeDir = new THREE.Vector3(-WATCH_X, -WATCH_Y, -WATCH_Z).normalize();
  const flat = new THREE.Vector3(0, 0, 1);
  const tangent = eyeDir
    .clone()
    .sub(flat.clone().multiplyScalar(eyeDir.dot(flat)))
    .normalize();
  const normal = flat
    .clone()
    .multiplyScalar(Math.cos(TILT_RAD))
    .addScaledVector(tangent, Math.sin(TILT_RAD))
    .normalize();
  const up = new THREE.Vector3(0, 1, 0).addScaledVector(normal, -normal.y).normalize();
  const right = new THREE.Vector3().crossVectors(up, normal);
  object.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, normal));
}

/** The angle of a height on the dial, in radians clockwise from the top. */
function turnAngle(height: number, fullTurn: number): number {
  return (height / fullTurn) * 2 * Math.PI;
}

/**
 * The drawing of the dial.
 *
 * The canvas has y downwards, so the angle of the dial, which runs clockwise
 * from the top, is the canvas angle less a quarter turn.
 */
function drawDial(ctx: CanvasRenderingContext2D, units: UnitSystem): void {
  const c = CANVAS_SIZE / 2;
  const fullTurn = units === 'ft' ? FULL_TURN_FT : FULL_TURN_M;
  const divisions = units === 'ft' ? 12 : 4;
  const red = units === 'ft' ? RED_FT : RED_M;
  const yellow = units === 'ft' ? YELLOW_FT : YELLOW_M;

  // The face of the dial.
  const shade = ctx.createRadialGradient(c, c, 20, c, c, c);
  shade.addColorStop(0, '#1b1f26');
  shade.addColorStop(1, '#0a0c0f');
  ctx.fillStyle = shade;
  ctx.beginPath();
  ctx.arc(c, c, c, 0, Math.PI * 2);
  ctx.fill();

  // The arcs that mark the height to pull at.
  ctx.lineWidth = 16;
  ctx.strokeStyle = '#c8322a';
  ctx.beginPath();
  ctx.arc(c, c, ARC_RADIUS, -Math.PI / 2, -Math.PI / 2 + turnAngle(red, fullTurn));
  ctx.stroke();
  ctx.strokeStyle = '#d8ae22';
  ctx.beginPath();
  ctx.arc(
    c,
    c,
    ARC_RADIUS,
    -Math.PI / 2 + turnAngle(red, fullTurn),
    -Math.PI / 2 + turnAngle(yellow, fullTurn),
  );
  ctx.stroke();

  // The tick marks: four to a division, the division itself the long one.
  const minor = fullTurn / (divisions * 4);
  for (let i = 0; i < divisions * 4; i++) {
    const major = i % 4 === 0;
    const angle = -Math.PI / 2 + turnAngle(i * minor, fullTurn);
    const inner = TICK_RADIUS - (major ? 30 : 16);
    ctx.strokeStyle = major ? '#e8ecf2' : '#8b939e';
    ctx.lineWidth = major ? 5 : 2;
    ctx.beginPath();
    ctx.moveTo(c + TICK_RADIUS * Math.cos(angle), c + TICK_RADIUS * Math.sin(angle));
    ctx.lineTo(c + inner * Math.cos(angle), c + inner * Math.sin(angle));
    ctx.stroke();
  }

  // The numerals, in thousands of the unit of the drop zone.
  ctx.fillStyle = '#eef1f6';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 46px system-ui, sans-serif';
  for (let i = 0; i < divisions; i++) {
    const value = (i * fullTurn) / divisions;
    const angle = -Math.PI / 2 + turnAngle(value, fullTurn);
    ctx.fillText(
      String(Math.round(value / 1000)),
      c + NUMERAL_RADIUS * Math.cos(angle),
      c + NUMERAL_RADIUS * Math.sin(angle),
    );
  }

  // The numeral of the full turn, inside the zero at the top.
  ctx.fillStyle = '#8b939e';
  ctx.font = 'bold 34px system-ui, sans-serif';
  ctx.fillText(String(units === 'ft' ? 12 : 4), c, c - FULL_SCALE_RADIUS);
}
