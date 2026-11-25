import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { getCACertificates, setDefaultCACertificates } from "node:tls";

try {
  loadEnvFile(fileURLToPath(new URL(".gigachat.local", import.meta.url)));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

try {
  const ca = await readFile(new URL(".gigachat-ca.pem", import.meta.url), "utf8");
  const certificates = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (!certificates?.length) throw new Error("Файл .gigachat-ca.pem не содержит сертификат.");
  setDefaultCACertificates([...getCACertificates(), ...certificates]);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const port = Number(process.env.GIGACHAT_DEMO_PORT || 8787);
const origin = `http://127.0.0.1:${port}`;
const files = new Map([
  ["/", ["index.html", "text/html"]],
  ["/index.html", ["index.html", "text/html"]],
  ...["preparation-system-prompts.js", "match-system-prompt.js", "model-demo.js"]
    .map(name => [`/${name}`, [name, "text/javascript"]])
]);
let token;
let refreshAfter = 0;
let active = false;

const string = { type: "string" };
const nullableString = { type: ["string", "null"] };
const boolean = { type: "boolean" };
const array = items => ({ type: "array", items });
const object = properties => ({
  type: "object", properties, required: Object.keys(properties), additionalProperties: false
});
const draftStatus = { type: "string", enum: ["draft", "missing_input"] };
const criterion = object({ criterion: string, source_quote: string, evidence_to_look_for: string });
const fact = object({ fact: string, source_quote: string });
const schemas = new Map([
  ["vacancy", object({
    status: draftStatus, title: nullableString, level: nullableString, responsibilities: array(string),
    work_context: nullableString, conditions: array(string), required: array(criterion),
    desirable: array(criterion), questions: array(string), comment: string
  })],
  ["resume", object({
    status: draftStatus, experience: array(fact), skills: array(fact), tools: array(fact),
    projects: array(fact), achievements: array(fact), education: array(fact),
    privacy_review_required: boolean, comment: string
  })],
  ["match", object({
    summary: string, rows: array(object({
      id: { type: "integer" },
      status: { type: "string", enum: ["соответствует", "частично", "не соответствует", "нет данных"] },
      evidence_id: { type: ["integer", "null"] }, gap: string
    })), questions: array(string), privacy_review_required: boolean
  })]
]);

async function getToken() {
  if (token && Date.now() < refreshAfter) return token;
  const key = process.env.GIGACHAT_AUTH_KEY;
  if (!key) throw new Error("На сервере не задан GIGACHAT_AUTH_KEY.");
  const response = await fetch("https://ngw.devices.sberbank.ru:9443/api/v2/oauth", {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: `Basic ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
      RqUID: randomUUID()
    },
    body: new URLSearchParams({ scope: process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS" }),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Авторизация GigaChat: HTTP ${response.status}.`);
  const result = await response.json();
  if (typeof result.access_token !== "string" || !result.access_token) {
    throw new Error("GigaChat не вернул токен доступа.");
  }
  token = result.access_token;
  refreshAfter = Date.now() + 28 * 60_000;
  return token;
}

async function generate(prompt, input, schema, retryAuth = true, retryLength = true) {
  const response = await fetch("https://api.giga.chat/v1/chat/completions", {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${await getToken()}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.GIGACHAT_MODEL || "GigaChat-2",
      messages: [{ role: "system", content: prompt }, { role: "user", content: input }],
      temperature: 0.2,
      max_tokens: retryLength ? 2200 : 4096,
      response_format: { type: "json_schema", schema, strict: true }
    }),
    signal: AbortSignal.timeout(90000)
  });
  if (response.status === 401 && retryAuth) {
    token = undefined;
    return generate(prompt, input, schema, false, retryLength);
  }
  if (!response.ok) throw new Error(`GigaChat: HTTP ${response.status}.`);
  const choice = (await response.json()).choices?.[0];
  if (choice?.finish_reason === "length" && retryLength) {
    return generate(prompt + "\nОтвет должен быть коротким. Заверши JSON сразу после заполнения обязательных полей.", input, schema, retryAuth, false);
  }
  if (choice?.finish_reason === "length") throw new Error("GigaChat дважды обрезал ответ. Попробуйте обработать кандидата отдельно или сократить текст.");
  if (!choice?.message?.content) throw new Error("GigaChat вернул пустой ответ.");
  return choice.message.content;
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

createServer(async (req, res) => {
  if (req.headers.host !== new URL(origin).host) return json(res, 403, { error: "Недопустимый адрес." });
  if (req.method === "GET" && files.has(req.url)) {
    const [name, type] = files.get(req.url);
    try {
      const data = await readFile(new URL(name, import.meta.url));
      res.writeHead(200, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store" });
      return res.end(data);
    } catch {
      return json(res, 500, { error: "Файл прототипа недоступен." });
    }
  }
  if (req.method !== "POST" || req.url !== "/api/gigachat") return json(res, 404, { error: "Страница не найдена." });
  if (req.headers.origin !== origin || req.headers["content-type"] !== "application/json") {
    return json(res, 403, { error: "Откройте прототип через локальный сервер." });
  }
  if (active) return json(res, 429, { error: "Дождитесь завершения текущего запроса." });
  active = true;
  try {
    let size = 0;
    const parts = [];
    for await (const part of req) {
      size += part.length;
      if (size > 160_000) return json(res, 413, { error: "Слишком большой запрос." });
      parts.push(part);
    }
    let data;
    try { data = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch {
      return json(res, 400, { error: "Некорректный запрос." });
    }
    const { prompt, input, synthetic, stage } = data || {};
    const schema = schemas.get(stage);
    if (!schema || synthetic !== true || typeof prompt !== "string" || typeof input !== "string" ||
        !prompt.trim() || !input.trim() || prompt.length > 12000 || input.length > 30000) {
      return json(res, 400, { error: "Нужны промт, синтетический текст и подтверждение перед отправкой." });
    }
    return json(res, 200, { content: await generate(prompt, input, schema) });
  } catch (error) {
    const detail = error.cause?.code;
    const message = detail ? `Ошибка соединения с GigaChat (${detail}).` :
      error.name === "TimeoutError" ? "GigaChat не ответил вовремя." :
      error.message === "fetch failed" ? "Ошибка соединения с GigaChat." : error.message;
    return json(res, 502, { error: message });
  } finally {
    active = false;
  }
}).listen(port, "127.0.0.1", () => console.log(`Прототип: ${origin}`));
