import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import * as iflytek from "./iflytek.mjs";

loadEnv();

const PORT = Number(process.env.API_PORT ?? 8787);
const LLM_API_KEY = process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY;
const LLM_BASE_URL = process.env.DEEPSEEK_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://api.deepseek.com";
const LLM_MODEL = process.env.DEEPSEEK_MODEL ?? process.env.OPENAI_MODEL ?? "deepseek-v4-flash";
const HOST = process.env.API_HOST ?? "127.0.0.1";
const DIST_DIR = resolve(process.cwd(), "dist");

const server = createServer(async (request, response) => {
  setCors(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  try {
    if (request.method === "GET" && request.url === "/api/health") {
      sendJson(response, 200, {
        ok: true,
        llm: Boolean(LLM_API_KEY),
        asr: iflytek.ENABLED(),
        tts: iflytek.ENABLED(),
        pronunciation: Boolean(iflytek.ENABLED() || (process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION)),
      });
      return;
    }

    if (request.method === "POST" && request.url === "/api/dialogue") {
      const body = await readJson(request);
      sendJson(response, 200, await createDialogue(body));
      return;
    }

    if (request.method === "POST" && request.url === "/api/dialogue-stream") {
      const body = await readJson(request);
      await streamDialogue(body, response);
      return;
    }

    if (request.method === "POST" && request.url === "/api/translate") {
      const body = await readJson(request);
      sendJson(response, 200, await createTranslation(body));
      return;
    }

    if (request.method === "POST" && request.url === "/api/scenario") {
      const body = await readJson(request);
      sendJson(response, 200, await createScenarioDraft(body));
      return;
    }

    if (request.method === "POST" && request.url === "/api/pronunciation") {
      const body = await readJson(request, 18 * 1024 * 1024);
      sendJson(response, 200, await assessPronunciation(body));
      return;
    }

    if (request.method === "POST" && request.url === "/api/asr") {
      const body = await readJson(request, 18 * 1024 * 1024);
      sendJson(response, 200, await handleAsr(body));
      return;
    }

    if (request.method === "POST" && request.url === "/api/tts") {
      const body = await readJson(request);
      sendJson(response, 200, await handleTts(body));
      return;
    }

    if (request.url?.startsWith("/api/")) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    serveStaticAsset(request, response);
  } catch (error) {
    sendJson(response, 500, { error: error instanceof Error ? error.message : "Unknown server error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`App server listening on http://${HOST}:${PORT}`);
});

server.on("error", (error) => {
  if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Close the old dev server or set API_PORT=${PORT + 1} in .env.`);
  } else {
    console.error(error instanceof Error ? error.message : error);
  }
  process.exitCode = 1;
});

async function createScenarioDraft(body) {
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return { mode: "fallback", scenario: null };
  if (!LLM_API_KEY) return { mode: "fallback", scenario: buildFallbackScenarioDraft(prompt) };

  const apiResponse = await fetch(`${LLM_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LLM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Create an English speaking practice scenario from the learner request. Return valid JSON only with keys: title, role, context, openingMessage, goals, keyExpressions, sampleAnswers, evaluationFocus. Use Simplified Chinese for title/context/goals/evaluationFocus, English for openingMessage/keyExpressions/sampleAnswers. goals/keyExpressions/sampleAnswers/evaluationFocus must be arrays of 4 strings.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!apiResponse.ok) return { mode: "fallback", scenario: buildFallbackScenarioDraft(prompt) };
  const data = await apiResponse.json();
  const content = data?.choices?.[0]?.message?.content ?? "";
  try {
    const scenario = normalizeScenarioDraft(JSON.parse(content), prompt);
    return { mode: "llm", scenario };
  } catch {
    return { mode: "fallback", scenario: buildFallbackScenarioDraft(prompt) };
  }
}

function normalizeScenarioDraft(draft, prompt) {
  const fallback = buildFallbackScenarioDraft(prompt);
  return {
    title: stringOr(draft.title, fallback.title),
    role: stringOr(draft.role, fallback.role),
    context: stringOr(draft.context, fallback.context),
    openingMessage: stringOr(draft.openingMessage, fallback.openingMessage),
    goals: arrayOr(draft.goals, fallback.goals).slice(0, 4),
    keyExpressions: arrayOr(draft.keyExpressions, fallback.keyExpressions).slice(0, 4),
    sampleAnswers: arrayOr(draft.sampleAnswers, fallback.sampleAnswers).slice(0, 4),
    evaluationFocus: arrayOr(draft.evaluationFocus, fallback.evaluationFocus).slice(0, 4),
  };
}

function buildFallbackScenarioDraft(prompt) {
  return {
    title: prompt.slice(0, 18) || "自定义场景",
    role: "场景对话伙伴",
    context: `围绕“${prompt}”进行真实英语口语练习。`,
    openingMessage: `Hi, let's practice this situation: ${prompt}. Could you start by telling me what you need?`,
    goals: ["说明你的需求", "回答对方追问", "使用礼貌表达", "自然结束对话"],
    keyExpressions: ["I would like to...", "Could you tell me more about...?", "What do you recommend?", "Thank you for your help."],
    sampleAnswers: [
      "I would like to explain what I need in this situation.",
      "Could you tell me what options I have?",
      "That sounds good. I have one more question.",
      "Thank you for your help. That is very clear.",
    ],
    evaluationFocus: ["场景词汇", "表达完整度", "互动自然度", "礼貌程度"],
  };
}

function stringOr(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function arrayOr(value, fallback) {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : fallback;
}

async function createTranslation(body) {
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return { mode: "fallback", translation: "" };
  const targetLanguage = body.targetLanguage === "en" ? "en" : "zh";

  if (!LLM_API_KEY) return { mode: "fallback", translation: createFallbackTranslation(text, targetLanguage) };

  const apiResponse = await fetch(`${LLM_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LLM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            targetLanguage === "en"
              ? "Translate Simplified Chinese into natural spoken English for an English speaking-practice app. Keep it concise, conversational, and suitable as the learner's answer. Return only the English sentence or sentences, no explanation."
              : "Translate English speaking-practice dialogue into natural Simplified Chinese. Return only the translation, no explanation.",
        },
        { role: "user", content: text },
      ],
    }),
  });

  if (!apiResponse.ok) return { mode: "fallback", translation: createFallbackTranslation(text, targetLanguage) };
  const data = await apiResponse.json();
  const translation = data?.choices?.[0]?.message?.content?.trim();
  return { mode: "llm", translation: translation || createFallbackTranslation(text, targetLanguage) };
}

function createFallbackTranslation(text, targetLanguage = "zh") {
  if (targetLanguage === "en") return createFallbackEnglishTranslation(text);
  const dictionary = [
    ["could you", "你可以"],
    ["would you", "你愿意/你可以"],
    ["please", "请"],
    ["experience", "经验"],
    ["project", "项目"],
    ["recommend", "推荐"],
    ["order", "点餐/订单"],
    ["drink", "饮品"],
    ["baggage", "行李"],
    ["reservation", "预订"],
    ["meeting", "会议"],
    ["blocker", "阻塞"],
  ];
  const hits = dictionary.filter(([phrase]) => text.toLowerCase().includes(phrase));
  if (!hits.length) return "当前未接入 LLM 翻译：请结合场景理解这句英文。";
  return `关键词：${hits.map(([, translation]) => translation).join("、")}。当前未接入 LLM，已提供关键词辅助理解。`;
}

function createFallbackEnglishTranslation(text) {
  const normalized = text.replace(/\s+/g, "").toLowerCase();
  const phraseMap = [
    [/会员|办卡|卡/, "I would like to ask about membership options."],
    [/价格|多少钱|费用|收费/, "Could you tell me about the price and fees?"],
    [/设施|设备/, "Could you tell me what facilities and equipment you have?"],
    [/开放|营业|时间|几点/, "What are your opening hours?"],
    [/试用|体验/, "Do you offer a trial visit?"],
    [/优惠|促销|折扣/, "Do you have any promotions or discounts?"],
    [/付款|支付/, "What payment methods do you accept?"],
    [/推荐|建议/, "What do you recommend?"],
    [/谢谢|感谢/, "Thank you for your help."],
  ];
  const hits = phraseMap.filter(([pattern]) => pattern.test(normalized)).map(([, translation]) => translation);
  return hits.length
    ? [...new Set(hits)].join(" ")
    : "I would like to explain my question in English, but translation needs the LLM service.";
}

async function createDialogue(body) {
  if (!LLM_API_KEY) return { mode: "fallback", reply: "", endReason: "none" };

  const apiResponse = await fetch(`${LLM_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LLM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      temperature: 0.7,
      messages: buildChatMessages(body),
    }),
  });

  if (!apiResponse.ok) {
    const errorText = await apiResponse.text();
    throw new Error(`LLM request failed: ${apiResponse.status} ${errorText}`);
  }

  const data = await apiResponse.json();
  const reply = data?.choices?.[0]?.message?.content?.trim() || "";
  return { mode: "llm", reply, endReason: inferEndReason(reply) };
}

function buildChatMessages(body) {
  const scenario = body.scenario ?? {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const cleanMessages = messages.filter((message) => message?.text && message.text !== "Thinking about a natural reply...");
  const memory = buildConversationMemory(cleanMessages);
  return [
    {
      role: "system",
      content: [
        "You are an English speaking coach inside a scenario-based role-play app.",
        "Reply only in English because the learner is practicing speaking.",
        "Stay in the assigned role and continue the same conversation, not a new one.",
        "Use the learner's previous answers as context. Refer to concrete facts they already mentioned when it helps.",
        "Do not repeat a question that was already answered. Move the scenario forward naturally.",
        "For normal practice turns, keep replies under 75 words and ask one natural follow-up question.",
        "If the conversation has reached a clear refusal, rejection, safety boundary, goodbye, or final decision, end firmly and professionally. Do not ask another question.",
        "When ending, make the final sentence decisive, for example: 'We cannot continue this conversation.' or 'This conversation is over.'",
        "Do not over-correct. Only correct blocking errors in-line; leave minor issues for the report.",
        `Scenario: ${scenario.title ?? "English practice"}`,
        `Role: ${scenario.role ?? "Coach"}`,
        `Level: ${body.level ?? "B1"}`,
        `Training goals: ${(scenario.goals ?? []).join("; ")}`,
        `Useful expressions: ${(scenario.keyExpressions ?? []).join("; ")}`,
        `Conversation memory: ${memory}`,
      ].join("\n"),
    },
    ...cleanMessages.slice(-12).map((message) => ({
      role: message.role === "coach" ? "assistant" : "user",
      content: message.text,
    })),
  ];
}

function buildConversationMemory(messages) {
  const userTexts = messages
    .filter((message) => message.role === "user")
    .map((message) => String(message.text).replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (!userTexts.length) return "No learner answers yet.";
  return userTexts
    .slice(-6)
    .map((text, index) => `${index + 1}. ${text.slice(0, 180)}`)
    .join(" | ");
}

function inferEndReason(text) {
  const normalized = String(text).toLowerCase();
  if (/\b(interview is over|conversation is over|we cannot continue|cannot continue|meeting is over|process is over|this is over)\b/.test(normalized)) {
    return "terminated";
  }
  if (/\b(all set|we have covered|that completes|this concludes|nice chatting|goodbye|see you next time)\b/.test(normalized)) {
    return "completed";
  }
  return "none";
}

async function streamDialogue(body, response) {
  if (!LLM_API_KEY) {
    sendJson(response, 200, { mode: "fallback", reply: "", endReason: "none" });
    return;
  }

  const apiResponse = await fetch(`${LLM_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LLM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      temperature: 0.7,
      stream: true,
      messages: buildChatMessages(body),
    }),
  });

  if (!apiResponse.ok || !apiResponse.body) {
    const errorText = await apiResponse.text();
    throw new Error(`LLM stream request failed: ${apiResponse.status} ${errorText}`);
  }

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  for await (const chunk of apiResponse.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const data = JSON.parse(payload);
        const delta = data?.choices?.[0]?.delta?.content;
        if (delta) {
          fullText += delta;
          response.write(`data: ${JSON.stringify({ delta })}\n\n`);
        }
      } catch {
        // Ignore malformed provider chunks and continue streaming.
      }
    }
  }

  response.write(`data: ${JSON.stringify({ endReason: inferEndReason(fullText) })}\n\n`);
  response.write("data: [DONE]\n\n");
  response.end();
}

async function assessPronunciation(body) {
  if (!body.audioBase64 || !body.referenceText) return { mode: "heuristic", assessment: null };

  // Try iFlytek first (best latency in China)
  if (iflytek.ENABLED()) {
    try {
      const result = await iflytek.pronounce(body.audioBase64, body.referenceText);
      if (result.assessment) return result;
    } catch { /* fall through to Azure/heuristic */ }
  }

  // Fall back to Azure
  if (process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION) {
    try {
      return await azurePronounce(body);
    } catch { /* fall through to heuristic */ }
  }

  return { mode: "heuristic", assessment: null };
}

async function azurePronounce(body) {
  const region = process.env.AZURE_SPEECH_REGION;
  const pronunciationConfig = Buffer.from(
    JSON.stringify({
      ReferenceText: body.referenceText,
      GradingSystem: "HundredMark",
      Granularity: "Phoneme",
      Dimension: "Comprehensive",
      EnableMiscue: true,
    }),
  ).toString("base64");

  const audioBuffer = Buffer.from(body.audioBase64, "base64");
  const apiResponse = await fetch(
    `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US`,
    {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": process.env.AZURE_SPEECH_KEY,
        "Content-Type": body.mimeType || "audio/webm; codecs=opus",
        "Pronunciation-Assessment": pronunciationConfig,
      },
      body: audioBuffer,
    },
  );

  if (!apiResponse.ok) return { mode: "heuristic", assessment: null, warning: `Azure pronunciation request failed: ${apiResponse.status}` };
  const data = await apiResponse.json();
  const assessment = data?.NBest?.[0]?.PronunciationAssessment;
  if (!assessment) return { mode: "heuristic", assessment: null };

  return {
    mode: "azure",
    assessment: {
      accuracyScore: Math.round(assessment.AccuracyScore ?? 0),
      fluencyScore: Math.round(assessment.FluencyScore ?? 0),
      completenessScore: Math.round(assessment.CompletenessScore ?? 0),
      pronunciationScore: Math.round(assessment.PronScore ?? 0),
    },
  };
}

async function handleAsr(body) {
  if (!body.audioBase64) return { error: "audioBase64 is required" };
  if (!iflytek.ENABLED()) return { error: "iFlytek not configured" };
  try {
    const text = await iflytek.asr(body.audioBase64, body.encoding || "raw", body.rate || 16000);
    return { text };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "ASR failed" };
  }
}

async function handleTts(body) {
  if (!body.text) return { error: "text is required" };
  if (!iflytek.ENABLED()) return { error: "iFlytek not configured" };
  try {
    const audio = await iflytek.tts(body.text, body.voice || "xiaoyan");
    return { audio: audio.toString("base64"), mimeType: "audio/mpeg" };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "TTS failed" };
  }
}

function loadEnv() {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!process.env[key]) process.env[key] = value.replace(/^["']|["']$/g, "");
  }
}

function readJson(request, limit = 1024 * 1024) {
  return new Promise((resolveJson, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > limit) {
        reject(new Error("Request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolveJson(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function serveStaticAsset(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  if (!existsSync(DIST_DIR)) {
    sendJson(response, 404, { error: "Frontend build not found. Run npm run build first." });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);
  const normalizedPath = normalize(pathname).replace(/^([/\\])+/, "");
  const requestedPath = join(DIST_DIR, normalizedPath || "index.html");
  const filePath = requestedPath.startsWith(DIST_DIR) && existsSync(requestedPath) && !pathname.endsWith("/")
    ? requestedPath
    : join(DIST_DIR, "index.html");

  response.writeHead(200, { "Content-Type": getContentType(filePath) });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  response.end(readFileSync(filePath));
}

function getContentType(filePath) {
  const contentTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
  };
  return contentTypes[extname(filePath)] ?? "application/octet-stream";
}

function setCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}
