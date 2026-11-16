/**
 * Historical entry point for the Notices LLM calls. The client is now
 * provider-neutral (Groq, Claude, OpenAI, Gemini — one active per firm) and
 * lives in ../integrations/llm.ts; this module re-exports it so callers and
 * tests importing from here keep working.
 */
export {
  AI_DISABLED_MESSAGE,
  DEFAULT_GROQ_MODEL,
  assertAiAllowed,
  complete,
  resolveLlmConfig,
} from '../integrations/llm.js'
