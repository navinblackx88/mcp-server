// Google Gemini (Google AI Studio / Gemini API) with native function calling,
// via Google's official @google/genai SDK. Get a key at https://aistudio.google.com/apikey
//
// History stays in Gemini's own format ({ role: 'user' | 'model', parts: [...] }). The model's
// parts are kept exactly as returned, including `thoughtSignature`: Gemini 3 models require
// those signatures back on the next request, or multi-step tool use fails.
import { GoogleGenAI } from '@google/genai';

// Gemini accepts JSON Schema in `parametersJsonSchema`, but not the `$schema` marker MCP adds.
function cleanSchema(schema) {
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === '$schema' || k === '$id') continue;
    out[k] = cleanSchema(v);
  }
  if (out.type === 'object' && !out.properties) out.properties = {};
  return out;
}

const FINISH_HINTS = {
  SAFETY: 'Gemini blocked the answer for safety reasons.',
  RECITATION: 'Gemini stopped because the answer would repeat copyrighted text.',
  MAX_TOKENS: 'Gemini hit the output limit before answering. Raise LLM_MAX_TOKENS.',
  MALFORMED_FUNCTION_CALL: 'Gemini produced an invalid tool call. Try rephrasing the question.',
  BLOCKLIST: 'Gemini blocked the answer (blocklist).',
  PROHIBITED_CONTENT: 'Gemini blocked the answer (prohibited content).',
};

export class GeminiProvider {
  constructor({ apiKey, baseURL, model, maxTokens, temperature }) {
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set. Create one at https://aistudio.google.com/apikey');
    this.client = new GoogleGenAI({
      apiKey,
      httpOptions: {
        ...(baseURL ? { baseUrl: baseURL } : {}),
        timeout: 120000,
        retryOptions: { attempts: 3 }, // retries transient 429/5xx with backoff
      },
    });
    this.name = 'gemini';
    Object.assign(this, { model, maxTokens, temperature });
    this.syntheticIds = new Set(); // ids we made up for calls that came without one
    this.counter = 0;
  }

  userMessage(text) {
    return { role: 'user', parts: [{ text }] };
  }

  // Trim history only at a user message that carries text, never at a tool-result message.
  isTurnStart(msg) {
    return msg.role === 'user' && msg.parts.some((p) => typeof p.text === 'string') && !msg.parts.some((p) => p.functionResponse);
  }

  async step({ system, messages, tools }) {
    const res = await this.client.models.generateContent({
      model: this.model,
      contents: messages,
      config: {
        systemInstruction: system,
        ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
        maxOutputTokens: this.maxTokens,
        ...(tools.length ? {
          tools: [{
            functionDeclarations: tools.map((t) => ({
              name: t.name,
              description: t.description,
              parametersJsonSchema: cleanSchema(t.inputSchema),
            })),
          }],
        } : {}),
      },
    });

    const candidate = res.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const text = parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('').trim();
    const toolCalls = parts.filter((p) => p.functionCall).map((p) => {
      let id = p.functionCall.id;
      if (!id) {
        id = `gemini_call_${++this.counter}`;
        this.syntheticIds.add(id);
      }
      return { id, name: p.functionCall.name, args: p.functionCall.args ?? {} };
    });

    let reply = text;
    if (!text && !toolCalls.length) {
      const blocked = res.promptFeedback?.blockReason;
      reply = blocked
        ? `Gemini refused the request (${blocked}).`
        : FINISH_HINTS[candidate?.finishReason] ?? `Gemini returned no answer${candidate?.finishReason ? ` (${candidate.finishReason})` : ''}.`;
    }

    // Keep the model's parts exactly as returned (thought signatures included). Gemini rejects
    // a model turn with no parts, so an empty reply is stored as text.
    const assistantMessage = { role: 'model', parts: parts.length ? parts : [{ text: reply }] };
    return { text: reply, toolCalls, assistantMessage, usage: res.usageMetadata };
  }

  // All results of one round go back together in a single user turn, matched by name (and id when Gemini gave one).
  toolResultMessages(results) {
    return [{
      role: 'user',
      parts: results.map((r) => ({
        functionResponse: {
          ...(this.syntheticIds.has(r.id) ? {} : { id: r.id }),
          name: r.name,
          response: r.ok ? { output: r.text } : { error: r.text },
        },
      })),
    }];
  }
}
