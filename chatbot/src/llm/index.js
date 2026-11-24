// Provider factory. Every provider implements:
//   userMessage(text)           -> message in the provider's own history format
//   isTurnStart(msg)            -> true if history may be trimmed to start at msg
//   step({system,messages,tools}) -> { text, toolCalls:[{id,name,args}], assistantMessage }
//   toolResultMessages(results) -> messages carrying tool results back
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { RulesProvider } from './rules.js';

export function createProvider(cfg) {
  switch (cfg.provider) {
    case 'anthropic': case 'claude': return new AnthropicProvider(cfg);
    case 'openai': return new OpenAIProvider(cfg);
    case 'ollama': case 'openai-compatible': return new OpenAIProvider({ ...cfg, name: cfg.provider });
    case 'rules': case 'offline': return new RulesProvider();
    default: throw new Error(`Unknown LLM_PROVIDER "${cfg.provider}". Use anthropic, openai, ollama or rules.`);
  }
}
