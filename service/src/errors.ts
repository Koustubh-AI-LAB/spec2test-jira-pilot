/**
 * Single hierarchy; every error carries a machine-readable `event`.
 *
 * Written without TypeScript parameter properties on purpose: the service runs
 * under Node's strip-only type removal, which does not support them.
 */
export class ServiceError extends Error {
  readonly event: string;
  readonly status: number;

  constructor(event: string, message: string, status = 400) {
    super(message);
    this.name = new.target.name;
    this.event = event;
    this.status = status;
  }
}

export class NotFoundError extends ServiceError {
  constructor(message: string) {
    super('not_found', message, 404);
  }
}

export class GateError extends ServiceError {
  constructor(event: string, message: string) {
    super(event, message, 409);
  }
}

export class EnvironmentNotAllowedError extends ServiceError {
  constructor(message: string) {
    super('environment_not_allowed', message, 403);
  }
}
