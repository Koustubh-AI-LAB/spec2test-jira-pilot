/**
 * Mirrors service/src/errors.ts - a single hierarchy, every error carries a
 * machine-readable `event`. Not imported across the workspace boundary on
 * purpose: runner/ stays decoupled from service/ until step 5 wires them
 * together through the State Service's HTTP API, never through shared code.
 */
export class RunnerError extends Error {
  readonly event: string;

  constructor(event: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.event = event;
  }
}
