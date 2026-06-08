// iFlytek (讯飞) API client — ASR / TTS / Pronunciation Assessment
import { createHmac } from "node:crypto";

function getConfig() {
  const appid = process.env.XF_APPID;
  const key = process.env.XF_API_KEY;
  const secret = process.env.XF_API_SECRET;
  return { appid, key, secret, enabled: Boolean(appid && key && secret) };
}
const ENABLED = () => getConfig().enabled;

// Build authenticated WebSocket URL for Xunfei
function buildUrl(host, path) {
  const { appid, key, secret } = getConfig();
  const date = new Date().toUTCString();
  const raw = `host: ${host}\ndate: ${date}\nGET ${path} HTTP/1.1`;
  const sig = createHmac("sha256", secret).update(raw).digest("base64");
  const auth = Buffer.from(
    `api_key="${key}", algorithm="hmac-sha256", headers="host date request-line", signature="${sig}"`,
  ).toString("base64");
  return `wss://${host}${path}?authorization=${encodeURIComponent(auth)}&date=${encodeURIComponent(date)}&host=${host}`;
}

// WebSocket helper: send frames, collect response
function wsRequest(url, frames, timeoutMs = 30000) {
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("iFlytek request timeout"));
    }, timeoutMs);
    const ws = new WebSocket(url);
    const result = { text: "", audio: null, raw: null };

    ws.onopen = () => {
      for (const frame of frames) {
        ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
      }
    };

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data.code !== 0 && data.code !== undefined) {
          clearTimeout(timeout);
          ws.close();
          reject(new Error(data.message || `iFlytek error ${data.code}`));
          return;
        }
        // Accumulate result text (ASR / ISE)
        if (data.data?.data) result.text += data.data.data;
        // Accumulate raw response (ISE assessment)
        if (data.data?.json) result.raw = data.data.json;
        // Accumulate audio (TTS)
        if (data.data?.audio) {
          const buf = Buffer.from(data.data.audio, "base64");
          result.audio = result.audio ? Buffer.concat([result.audio, buf]) : buf;
        }
        if (data.data?.status === 2) {
          clearTimeout(timeout);
          ws.close();
          resolvePromise(result);
        }
      } catch {
        // Ignore non-JSON messages (binary TTS data)
        if (msg.data instanceof Blob) {
          msg.data.arrayBuffer().then((buf) => {
            result.audio = result.audio
              ? Buffer.concat([result.audio, Buffer.from(buf)])
              : Buffer.from(buf);
          });
        }
      }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("iFlytek WebSocket error"));
    };
    ws.onclose = (e) => {
      if (e.code !== 1000 && e.code !== 1005) {
        clearTimeout(timeout);
        reject(new Error(`iFlytek WebSocket closed: ${e.code}`));
      }
    };
  });
}

// Speech-to-Text: audio → text
export async function asr(audioBase64, encoding = "raw", rate = 16000) {
  if (!ENABLED()) throw new Error("iFlytek not configured");
  const url = buildUrl("iat-api.xfyun.cn", "/v2/iat");
  const frames = [
    { common: { app_id: getConfig().appid } },
    { business: { language: "en", domain: "iat", accent: "en_us", dwa: "wpgs" } },
    { data: { status: 2, format: `audio/L16;rate=${rate}`, encoding, audio: audioBase64 } },
  ];
  const result = await wsRequest(url, frames);
  return result.text;
}

// Text-to-Speech: text → audio buffer
export async function tts(text, voice = "xiaoyan") {
  if (!ENABLED()) throw new Error("iFlytek not configured");
  const url = buildUrl("tts-api.xfyun.cn", "/v2/tts");
  const frames = [
    {
      common: { app_id: getConfig().appid },
      business: {
        aue: "lame",
        sfl: 1,
        auf: "audio/L16;rate=16000",
        voice_name: voice,
        speed: 50,
        volume: 50,
        pitch: 50,
        engine_type: "intp65",
      },
      data: { status: 2, text: Buffer.from(text).toString("base64") },
    },
  ];
  const result = await wsRequest(url, frames, 60000);
  return result.audio;
}

// Pronunciation Assessment: audio + referenceText → scores
// Returns same shape as Azure assessment for frontend compatibility
export async function pronounce(audioBase64, referenceText, encoding = "raw", rate = 16000) {
  if (!ENABLED()) throw new Error("iFlytek not configured");
  const url = buildUrl("ise-api.xfyun.cn", "/v2/open-ise");
  const frames = [
    { common: { app_id: APPID } },
    {
      business: {
        language: "en",
        category: "read_sentence",
        sub: "ise",
        rstcd: "utf8",
        group: "adult",
        tte: "utf-8",
      },
    },
    { data: { status: 2, format: `audio/L16;rate=${rate}`, encoding, audio: audioBase64 } },
  ];
  const result = await wsRequest(url, frames, 60000);

  // Parse ISE result JSON to extract scores
  try {
    const iseData = JSON.parse(result.raw || result.text);
    const info = iseData?.data?.info || {};
    const totalScore = info?.core?.result?.total ?? info?.ise_result?.total_score ?? 0;
    const accuracy = info?.core?.result?.accuracy ?? info?.ise_result?.accuracy_score ?? 0;
    const fluency = info?.core?.result?.fluency ?? info?.ise_result?.fluency_score ?? 0;
    const completeness = info?.core?.result?.integrity ?? info?.ise_result?.integrity_score ?? 0;

    return {
      mode: "iflytek",
      assessment: {
        accuracyScore: Math.round(accuracy),
        fluencyScore: Math.round(fluency),
        completenessScore: Math.round(completeness),
        pronunciationScore: Math.round(totalScore),
      },
    };
  } catch {
    return { mode: "iflytek", assessment: null };
  }
}

export { ENABLED };
