type GenerateLlmTextParams = {
  prompt: string;
  maxTokens?: number;
};

type OpenModelTextBlock = {
  type?: string;
  text?: string;
};

type OpenModelMessagesResponse = {
  content?: OpenModelTextBlock[];
  error?: {
    message?: string;
    type?: string;
  };
};

export function getOpenModelConfig() {
  const apiKey = Deno.env.get("OPENMODEL_API_KEY");
  const baseUrl = Deno.env.get("OPENMODEL_BASE_URL");
  const model = Deno.env.get("OPENMODEL_MODEL");
  const apiFormat = Deno.env.get("OPENMODEL_API_FORMAT") || "messages";

  if (!apiKey || !baseUrl || !model) {
    return null;
  }

  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    model,
    apiFormat,
  };
}

export async function generateLlmText(params: GenerateLlmTextParams): Promise<string> {
  const config = getOpenModelConfig();

  if (!config) {
    throw new Error("OpenModel credentials are not configured");
  }

  if (config.apiFormat !== "messages") {
    throw new Error(`Unsupported OpenModel API format: ${config.apiFormat}`);
  }

  const response = await fetch(`${config.baseUrl}/messages`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: params.maxTokens || 1200,
      messages: [
        {
          role: "user",
          content: params.prompt,
        },
      ],
    }),
  });

  const data = await response.json() as OpenModelMessagesResponse;

  if (!response.ok) {
    throw new Error(data.error?.message || `OpenModel API error: ${response.status}`);
  }

  const text = data.content
    ?.filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();

  if (!text) {
    throw new Error("OpenModel API returned empty text response");
  }

  return text;
}
