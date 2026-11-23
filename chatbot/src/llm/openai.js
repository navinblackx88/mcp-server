// OpenAI Chat Completions with function calling. Also works with any OpenAI-compatible
// server: Ollama (local), LM Studio, vLLM, Groq, OpenRouter, Azure OpenAI, etc. via LLM_BASE_URL.
import OpenAI from 'openai';

export class OpenAIProvider {
  constructor({ apiKey, baseURL, model, maxTokens, temperature, name = 'openai' }) {
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
    this.client = new OpenAI({ apiKey, baseURL });
    this.name = name;
    Object.assign(this, { model, maxTokens, temperature });
  }

  userMessage(text) {
    return { role: 'user', content: text };
  }

  isTurnStart(msg) {
    return msg.role === 'user';
  }

  async step({ system, messages, tools }) {
    const res = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      messages: [{ role: 'system', content: system }, ...messages],
      tools: tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
      tool_choice: 'auto',
    });
    const msg = res.choices?.[0]?.message ?? { role: 'assistant', content: '' };
    const toolCalls = (msg.tool_calls ?? []).filter((c) => c.type === 'function' || c.function).map((c) => {
      let args = {};
      try { args = c.function.arguments ? JSON.parse(c.function.arguments) : {}; } catch { args = { _unparsed: c.function.arguments }; }
      return { id: c.id, name: c.function.name, args };
    });
    // Keep only fields the API accepts back in history.
    const assistantMessage = { role: 'assistant', content: msg.content ?? '' };
    if (msg.tool_calls?.length) assistantMessage.tool_calls = msg.tool_calls;
    return { text: (msg.content ?? '').trim(), toolCalls, assistantMessage, usage: res.usage };
  }

  toolResultMessages(results) {
    return results.map((r) => ({ role: 'tool', tool_call_id: r.id, content: r.ok ? r.text : `ERROR: ${r.text}` }));
  }
}
