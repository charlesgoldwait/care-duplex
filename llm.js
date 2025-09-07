// llm.js — minimal OpenAI chat wrapper (CommonJS; no extra deps)
// Requires: Node 18+ (built-in fetch) and OPENAI_API_KEY in env.

const SYSTEM_PROMPT = [
  "You are a warm, concise phone companion for an older adult.",
  "Guidelines:",
  "- Keep replies under 15 words.",
  "- One sentence, natural speech.",
  "- Acknowledge then answer directly.",
  "- No emojis."
].join("\n");

function createLlm({ apiKey, model = "gpt-4o-mini", temperature = 0.4 }) {
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  async function reply(userText) {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: String(userText || "").slice(0, 800) },
        ],
      }),
    });

    if (!res.ok) {
      const errTxt = await res.text().catch(() => "");
      throw new Error(`OpenAI ${res.status}: ${errTxt}`);
    }

    const data = await res.json();
    return (data?.choices?.[0]?.message?.content || "").trim();
  }

  return { reply };
}

module.exports = { createLlm };
