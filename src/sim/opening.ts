/**
 * The opening of the canopy.
 *
 * From the throw to the canopy flying there are six stages, and each one
 * has its own drag: the pilot chute hanging on the hand, the bag coming
 * out, the lines going tight, the snivel with the slider up, the inflation
 * and then full flight. The whole thing is driven by the clock and by the
 * speed at the throw, so the same seed opens the same way every time.
 *
 * The drag areas here are the starting values of the plan, tuned until the
 * opening pulled the load the spec asks for (three to five g over about a
 * second, five hundred and seventy to nine hundred and forty five feet of
 * altitude) and until a hard opening really hurt. This module imports
 * nothing from three.js or the DOM.
 */

import type { Rng } from '@/sim/rng';

/** The stages the opening goes through, in order. */
export type OpeningStage =
  | 'pilot-chute'
  | 'bag'
  | 'line-stretch'
  | 'snivel'
  | 'inflation'
  | 'open';

/** What the opening is going to do, drawn from the seeded generator. */
export interface OpeningPlan {
  /** The main or the reserve. */
  kind: 'main' | 'reserve';
  /** How long the pilot chute hangs before the bag moves, in seconds. */
  hesitationS: number;
  /** How long the canopy snivels before it inflates, in seconds. */
  snivelS: number;
  /** Whether this opening is a hard one. */
  hard: boolean;
}

/**
 * The parts of the opening the plan fixes.
 *
 * The hesitation and the snivel of the main are the ranges of the spec; the
 * reserve's are quicker, and a hard opening snivels briefly and inflates
 * fast.
 */
export const OPENING = {
  /** How long the bag lifts for before the lines start to pay out, in seconds. */
  bagLiftS: 0.5,
  /** How long the lines take to pay out, in seconds. */
  linesS: 0.3,
  /** How long the main takes to inflate, in seconds. */
  inflationS: 0.8,
  /** The range the reserve's pilot chute hangs for, in seconds. */
  reserveHesitation: [0.1, 0.3] as const,
  /** The range the reserve snivels for, in seconds. */
  reserveSnivel: [0.8, 1.2] as const,
  /** The speed at which a hard opening starts to be likely, in m/s (140 mph). */
  hardAboveMs: 62.6,
  /** The speed at which every opening is hard, in m/s (160 mph). */
  hardFullMs: 71.5,
};

/** The rest of the timeline, which the plan does not fix. */
export const OPENING_TIMING = {
  /** How long the snatch of the lines going tight lasts, in seconds. */
  snatchS: 0.15,
  /** How long a hard opening snivels, in seconds. */
  hardSnivelS: 0.3,
  /** How long a hard opening takes to inflate, in seconds. */
  hardInflationS: 0.4,
  /** How long the reserve takes to inflate, in seconds. */
  reserveInflationS: 0.6,
  /** The range the main's pilot chute hangs for, in seconds. */
  mainHesitation: [0.3, 1.0] as const,
  /** The range the main snivels for, in seconds. */
  mainSnivel: [1.8, 2.4] as const,
};

/**
 * The drag areas of the opening, in square metres.
 *
 * These are added to the jumper's own body drag along the airflow. They
 * came out of the plan's starting values, which pulled the load too early
 * and lost too little altitude: the bag, the lines and the snatch are thin
 * things and drag little, and the canopy only takes up its flying shape at
 * the end of the inflation.
 */
export const OPENING_DRAG = {
  /** The pilot chute, the bridle and the hand, in m². */
  pilotChute: 0.05,
  /** The bag lifting out of the container, in m². */
  bag: 0.3,
  /** The lines paying out, in m². */
  lines: 0.4,
  /** The snatch of the lines coming tight, in m². */
  snatch: 0.8,
  /** The drag at the start of the snivel, in m². */
  snivelFrom: 0.5,
  /** The drag at the end of the snivel, in m². */
  snivelTo: 1.2,
  /**
   * How late the canopy takes up its flying shape.
   *
   * Through the inflation the cloth leaves the jumper's drag and the
   * canopy's own flight force takes over. Both happen on the same curve:
   * the flight force grows with the power of this and the cloth's drag
   * falls with the power of one minus it.
   */
  handoverPow: 2.4,
};

/**
 * The drag area the canopy's own flight force stands in for, in square metres.
 *
 * Through the inflation the cloth leaves the jumper's drag and the canopy's
 * own flight force takes over, and this is the area that force is worth
 * while the jumper is still moving with the opening. The opening inside the
 * jump (task 14) uses the same number, so that the load of the opening is
 * the one this module was tuned against.
 */
export const OPENING_CANOPY_DRAG_M2 = 9.5;

/** Keeps a number inside a range. */
function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * Draws the plan of an opening.
 *
 * The numbers come out of the seeded generator in a fixed order: the
 * hesitation, then the snivel, then the hard opening, so the same seed and
 * the same speed always give the same plan.
 *
 * @param rng the seeded generator the plan is drawn from
 * @param verticalSpeedMs the speed at the throw, in m/s
 * @param kind the main or the reserve
 */
export function planOpening(
  rng: Rng,
  verticalSpeedMs: number,
  kind: 'main' | 'reserve',
): OpeningPlan {
  const hesitation = kind === 'reserve' ? OPENING.reserveHesitation : OPENING_TIMING.mainHesitation;
  const snivel = kind === 'reserve' ? OPENING.reserveSnivel : OPENING_TIMING.mainSnivel;
  const hesitationS = rng.range(hesitation[0], hesitation[1]);
  const snivelS = rng.range(snivel[0], snivel[1]);

  // The faster the jumper is going when the canopy comes out, the likelier
  // it is a hard one: nothing at 140 mph, everything at 160 mph.
  const chance = clamp(
    (verticalSpeedMs - OPENING.hardAboveMs) / (OPENING.hardFullMs - OPENING.hardAboveMs),
    0,
    1,
  );
  const hard = rng.next() < chance;

  return {
    kind,
    hesitationS,
    snivelS: hard ? OPENING_TIMING.hardSnivelS : snivelS,
    hard,
  };
}

/**
 * The opening, running.
 *
 * The caller advances it a step at a time and reads the drag area and the
 * flight blend to work out the forces on the jumper.
 */
export class Opening {
  /** The plan this opening is running to. */
  readonly plan: OpeningPlan;

  /** The time since the throw, in seconds. */
  tS = 0;

  /** The stage the opening is in. */
  stage: OpeningStage = 'pilot-chute';

  /** How inflated the canopy is: 0 packed, 1 flying. */
  inflation = 0;

  /** Where the slider is: 1 up at the canopy, 0 down at the risers. */
  slider = 1;

  /** The end of the pilot chute stage, in seconds. */
  private readonly tPilotEndS: number;

  /** The moment the lines come tight, in seconds. */
  private readonly tSnatchStartS: number;

  /** The end of the snatch, in seconds. */
  private readonly tSnivelStartS: number;

  /** The end of the snivel, in seconds. */
  private readonly tSnivelEndS: number;

  /** The moment the canopy is open, in seconds. */
  private readonly tOpenS: number;

  constructor(plan: OpeningPlan) {
    this.plan = plan;
    const h = plan.hesitationS;
    this.tPilotEndS = h;
    // The main comes out of a deployment bag, the reserve comes out of the
    // pouch on the jumper's back: its lines pay out as soon as it does.
    this.tSnatchStartS =
      plan.kind === 'reserve'
        ? h + OPENING.linesS
        : h + OPENING.bagLiftS + OPENING.linesS;
    this.tSnivelStartS = this.tSnatchStartS + OPENING_TIMING.snatchS;
    this.tSnivelEndS = this.tSnivelStartS + plan.snivelS;
    this.tOpenS = this.tSnivelEndS + this.inflationS();
  }

  /**
   * How long the canopy takes to inflate, in seconds.
   *
   * A hard opening inflates in half the time, and the reserve is quicker
   * than the main.
   */
  private inflationS(): number {
    if (this.plan.hard) return OPENING_TIMING.hardInflationS;
    return this.plan.kind === 'reserve' ? OPENING_TIMING.reserveInflationS : OPENING.inflationS;
  }

  /** The stage the opening is in at a time, in seconds. */
  private stageAt(tS: number): OpeningStage {
    if (tS < this.tPilotEndS) return 'pilot-chute';
    if (tS < this.tSnatchStartS) {
      return this.plan.kind === 'reserve' ? 'line-stretch' : 'bag';
    }
    if (tS < this.tSnivelStartS) return 'line-stretch';
    if (tS < this.tSnivelEndS) return 'snivel';
    if (tS < this.tOpenS) return 'inflation';
    return 'open';
  }

  /**
   * The drag area of the opening, in square metres.
   *
   * It is added to the jumper's own body drag along the airflow.
   */
  dragArea(): number {
    const t = this.tS;
    if (t < this.tPilotEndS) return OPENING_DRAG.pilotChute;
    if (t < this.tSnatchStartS) return this.linesArea(t);
    if (t < this.tSnivelStartS) return OPENING_DRAG.snatch;
    if (t < this.tSnivelEndS) return this.snivelArea(t);
    if (t < this.tOpenS) return this.inflationArea(t);
    return 0;
  }

  /** The drag of the bag and the lines paying out, at a time. */
  private linesArea(tS: number): number {
    if (this.plan.kind === 'reserve') {
      const x = (tS - this.tPilotEndS) / (this.tSnatchStartS - this.tPilotEndS);
      return (
        OPENING_DRAG.pilotChute + (OPENING_DRAG.lines - OPENING_DRAG.pilotChute) * clamp(x, 0, 1)
      );
    }
    const bagEndS = this.tPilotEndS + OPENING.bagLiftS;
    if (tS < bagEndS) return OPENING_DRAG.bag;
    const x = (tS - bagEndS) / (this.tSnatchStartS - bagEndS);
    return OPENING_DRAG.bag + (OPENING_DRAG.lines - OPENING_DRAG.bag) * clamp(x, 0, 1);
  }

  /** The drag of the snivelling canopy, at a time. */
  private snivelArea(tS: number): number {
    const x = clamp((tS - this.tSnivelStartS) / this.plan.snivelS, 0, 1);
    return OPENING_DRAG.snivelFrom + (OPENING_DRAG.snivelTo - OPENING_DRAG.snivelFrom) * x;
  }

  /** The drag of the cloth on the jumper during the inflation, at a time. */
  private inflationArea(tS: number): number {
    const u = clamp((tS - this.tSnivelEndS) / this.inflationS(), 0, 1);
    return OPENING_DRAG.snivelTo * Math.pow(1 - u, OPENING_DRAG.handoverPow);
  }

  /**
   * How much of the canopy's own flight force acts, from 0 to 1.
   *
   * The canopy model (task 13) works out the force; this is the share of
   * it that the opening has let go of so far.
   */
  flightBlend(): number {
    if (this.tS < this.tSnivelEndS) return 0;
    if (this.tS >= this.tOpenS) return 1;
    const u = clamp((this.tS - this.tSnivelEndS) / this.inflationS(), 0, 1);
    return Math.pow(u, OPENING_DRAG.handoverPow);
  }

  /**
   * Runs the opening on by a step, in seconds.
   *
   * @returns the stage that began in this step, or null if none did
   */
  advance(dtS: number): OpeningStage | null {
    this.tS += dtS;
    const stage = this.stageAt(this.tS);
    const began = stage !== this.stage;
    this.stage = stage;
    if (stage === 'inflation') {
      const u = clamp((this.tS - this.tSnivelEndS) / this.inflationS(), 0, 1);
      this.inflation = u;
      this.slider = 1 - u;
    } else if (stage === 'open') {
      this.inflation = 1;
      this.slider = 0;
    }
    return began ? stage : null;
  }
}
