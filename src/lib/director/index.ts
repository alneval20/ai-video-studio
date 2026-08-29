import { getEnv } from "@/lib/config/env";
import { createLogger } from "@/lib/core/logger";
import { HeuristicDirector } from "./heuristic-director";
import { LlmDirector } from "./llm-director";
import type { Director } from "./types";

const log = createLogger("director");

/**
 * Chooses a director.
 *
 * `auto` (the default) uses the LLM when a key is present and the deterministic
 * heuristic director otherwise — so a fresh clone with an empty `.env` still
 * produces a real, complete brief.
 */
export function createDirector(mode?: "auto" | "llm" | "heuristic"): Director {
  const env = getEnv();
  const resolved = mode ?? env.DIRECTOR_MODE;

  if (resolved === "heuristic") return new HeuristicDirector();

  if (resolved === "llm" || (resolved === "auto" && env.hasDirectorKey)) {
    try {
      return new LlmDirector();
    } catch (error) {
      if (resolved === "llm") throw error;
      log.warn("LLM director unavailable; using the heuristic director.");
      return new HeuristicDirector();
    }
  }

  return new HeuristicDirector();
}

export { HeuristicDirector, LlmDirector };
export * from "./types";
export * from "./spec-assembler";
