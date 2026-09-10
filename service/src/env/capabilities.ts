export const ENVIRONMENT_CLASSES = [
  'ephemeral',
  'dedicated',
  'shared-staging',
  'production',
] as const;

export type EnvironmentClass = (typeof ENVIRONMENT_CLASSES)[number];

export interface Capabilities {
  readonly tier1Injection: boolean;
  readonly tier2StateSeeding: boolean;
  readonly tier3ConfigFlip: boolean;
  readonly smokeOnly: boolean;
}

/**
 * Capabilities are derived from the class, never stored per environment row.
 * A stored column is something a person can edit; a derivation is not, so
 * there is no path by which tier-2 seeding becomes enabled against production.
 */
const BY_CLASS: Record<EnvironmentClass, Capabilities> = {
  ephemeral: { tier1Injection: true, tier2StateSeeding: true, tier3ConfigFlip: true, smokeOnly: false },
  dedicated: { tier1Injection: true, tier2StateSeeding: true, tier3ConfigFlip: true, smokeOnly: false },
  'shared-staging': { tier1Injection: true, tier2StateSeeding: false, tier3ConfigFlip: false, smokeOnly: false },
  production: { tier1Injection: false, tier2StateSeeding: false, tier3ConfigFlip: false, smokeOnly: true },
};

export function capabilitiesFor(cls: EnvironmentClass): Capabilities {
  return BY_CLASS[cls];
}

export function isEnvironmentClass(value: string): value is EnvironmentClass {
  return (ENVIRONMENT_CLASSES as readonly string[]).includes(value);
}
