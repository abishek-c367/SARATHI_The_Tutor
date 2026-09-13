// Groq's API is OpenAI-compatible, so this is a plain fetch - no SDK needed.
// Free tier: sign up at https://console.groq.com , create an API key, no card required.
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// If your GROQ_MODEL stops working (Groq's free-model lineup changes over time),
// check https://console.groq.com/docs/models for the current list of free models
// and update GROQ_MODEL in your .env - no code changes needed.
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

async function callLLM({ system, messages, maxTokens = 1024 }) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is not set on the server.');
  }
  const model = process.env.GROQ_MODEL || DEFAULT_MODEL;

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + process.env.GROQ_API_KEY,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, ...messages],
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    const msg = (data.error && data.error.message) || ('Groq request failed (' + res.status + ')');
    throw new Error(msg);
  }
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
}

module.exports = { callLLM };
