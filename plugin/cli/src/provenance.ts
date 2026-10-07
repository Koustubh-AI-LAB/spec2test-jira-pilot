import { loadPrompt } from './prompts.ts';
import { contentHash } from './hash.ts';

export interface Provenance {
  drafted_by_model: string;
  prompt_version: string;
  grounding_hash: string;
  temperature?: number;
}

/** Self-reported: the skill passes its own model id via --model, and the CLI
 *  can only check the shape, not verify it independently. Recorded as such,
 *  not presented as verified. */
const MODEL_ID_RE = /^claude-[a-z0-9.\-]+$/;

export class ModelIdInvalidError extends Error {
  readonly event: string;
  readonly model: string;

  // No parameter properties - see prompts.ts's comment; strip-only mode
  // doesn't support them.
  constructor(model: string) {
    super(`--model "${model}" does not look like a Claude model id (expected /^claude-[a-z0-9.-]+$/)`);
    this.event = 'model_id_invalid';
    this.model = model;
  }
}

/**
 * Assembles model id + prompt version + prompt hash + grounding hash +
 * temperature for every draft POST. `groundingText` is deliberately the
 * caller's choice, not always the OpenAPI document: criteria are drafted
 * from the ticket's own text, not the schema, so their honest grounding_hash
 * is contentHash(ticket.requirementText); a TestCaseSpec is drafted against
 * the OpenAPI grounding, so its grounding_hash is that document's hash.
 */
export function buildProvenance(args: {
  model: string;
  promptFile: string;
  groundingText: string;
  temperature?: number;
}): Provenance {
  if (!MODEL_ID_RE.test(args.model)) throw new ModelIdInvalidError(args.model);
  const prompt = loadPrompt(args.promptFile);
  return {
    drafted_by_model: args.model,
    prompt_version: `${prompt.id}@${prompt.hash.slice(0, 12)}`,
    grounding_hash: contentHash(args.groundingText),
    ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
  };
}
