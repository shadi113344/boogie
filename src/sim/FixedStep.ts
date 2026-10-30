/**
 * The fixed 120 Hz step the simulation runs at.
 *
 * The physics only knows one time step, so a frame that arrives late is
 * caught up in whole steps. The catch-up is capped: a frame that is very
 * late (a tab that comes back from the background, a phone that was
 * asleep) lets the time go rather than jumping the jumper ahead. This
 * module imports nothing from three.js or the DOM.
 */

/** The rate the simulation steps at. */
export const SIM_HZ = 120;

/** The length of one step, in seconds. */
export const SIM_DT = 1 / 120;

/** The most steps one frame may catch up: 12 steps is 100 ms. */
export const DEFAULT_MAX_STEPS = 12;

export class FixedStep {
  private accumulator = 0;

  /**
   * @param step the simulation, called once per step with the step length
   *   and a flag that is true on the first step of every call, so that edge
   *   inputs (the pull, the unstow, the PLF) are delivered once
   * @param maxStepsPerAdvance the most steps one call may run
   */
  constructor(
    private readonly step: (dt: number, first: boolean) => void,
    private readonly maxStepsPerAdvance: number = DEFAULT_MAX_STEPS,
  ) {}

  /**
   * Runs the steps the time since the last call allows, and returns how
   * many it ran. The time left over under one step is kept for the next
   * call; the time beyond the cap is dropped.
   */
  advance(realDtS: number): number {
    if (realDtS > 0) this.accumulator += realDtS;
    let steps = 0;
    while (this.accumulator >= SIM_DT && steps < this.maxStepsPerAdvance) {
      this.accumulator -= SIM_DT;
      this.step(SIM_DT, steps === 0);
      steps++;
    }
    if (steps >= this.maxStepsPerAdvance && this.accumulator >= SIM_DT) {
      // The frame was too late: let the time go instead of banking it.
      const dropped = Math.floor(this.accumulator / SIM_DT);
      this.accumulator = Math.max(0, this.accumulator - dropped * SIM_DT);
    }
    return steps;
  }

  /** Forgets the time left over, e.g. when the jump is reset. */
  reset(): void {
    this.accumulator = 0;
  }
}
