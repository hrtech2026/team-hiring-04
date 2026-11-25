const modelDemoAvailable = location.protocol === "http:" && location.hostname === "127.0.0.1";
let modelBusy = false;

async function requestGigaChat(stage, prompt, input, label) {
  const response = await fetch("/api/gigachat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stage, prompt, input, synthetic: true })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${label}: ${data.error || "GigaChat недоступен."}`);
  const content = data.content.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/gi, "");
  try {
    const result = JSON.parse(content);
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
    return result;
  } catch {
    throw new Error(`${label}: GigaChat вернул некорректный JSON. Данные на экране сохранены.`);
  }
}

async function runModelDemo(task, confirmMessage) {
  if (modelBusy || !window.confirm(confirmMessage)) return;
  modelBusy = true;
  screen.inert = true;
  const progress = document.getElementById("modelProgress");
  try {
    await task(message => { progress.textContent = message; });
  } catch (error) {
    progress.textContent = error.message;
    return;
  } finally {
    screen.inert = false;
    modelBusy = false;
  }
  render();
}

function validDraft(draft) {
  if (draft?.status !== "draft") throw new Error("GigaChat не вернул черновик. Проверьте исходные данные.");
}

function verifiedItems(items, source, field) {
  if (!Array.isArray(items)) throw new Error("В черновике GigaChat отсутствует ожидаемый список.");
  return items.filter(item => typeof item?.[field] === "string" && item[field].trim() &&
    typeof item.source_quote === "string" && item.source_quote.trim() && source.includes(item.source_quote));
}

function prepareWithGigaChat() {
  syncCurrentScreen();
  if (!state.vacancyRaw.trim() || !state.candidates.length || state.candidates.some(c => !c.raw.trim())) {
    notify("Добавьте исходный текст вакансии и каждого резюме.");
    return;
  }
  return runModelDemo(async progress => {
    progress("GigaChat готовит профиль вакансии…");
    const vacancy = await requestGigaChat("vacancy", state.prompts.vacancy, state.vacancyRaw, "Профиль вакансии");
    validDraft(vacancy);
    const required = verifiedItems(vacancy.required, state.vacancyRaw, "criterion");
    const desirable = verifiedItems(vacancy.desirable, state.vacancyRaw, "criterion");
    const profiles = [];
    for (const [index, candidate] of state.candidates.entries()) {
      progress(`GigaChat готовит резюме ${index + 1} из ${state.candidates.length}…`);
      const draft = await requestGigaChat("resume", state.prompts.resume, candidate.raw, `Резюме ${index + 1}`);
      validDraft(draft);
      if (draft.privacy_review_required !== false) {
        throw new Error(`Резюме ${index + 1} требует ручной проверки обезличивания.`);
      }
      const groups = ["experience", "skills", "tools", "projects", "achievements", "education"];
      const facts = groups.map(group => verifiedItems(draft[group], candidate.raw, "fact"));
      profiles.push({
        experience: [facts[0], facts[3], facts[4], facts[5]].flat().map(item => item.fact).join("\n"),
        skills: [...facts[1], ...facts[2]].map(item => item.fact).join("\n"),
        evidence: [...new Set(facts.flat().map(item => item.source_quote))].join("\n"),
        note: [draft.comment, "Проверьте подтверждения перед сопоставлением."].filter(Boolean).join("\n"),
        modelReport: undefined
      });
    }
    state.vacancy = {
      title: typeof vacancy.title === "string" ? vacancy.title : "",
      required: required.map(item => item.criterion).join("\n"),
      desirable: desirable.map(item => item.criterion).join("\n"),
      note: [vacancy.comment, ...(Array.isArray(vacancy.questions) ? vacancy.questions : []),
        ...[...required, ...desirable].filter(item => typeof item.evidence_to_look_for === "string")
          .map(item => `${item.criterion} — ${item.evidence_to_look_for}`)].filter(Boolean).join("\n")
    };
    state.candidates.forEach((candidate, index) => Object.assign(candidate, profiles[index]));
    state.reportMode = "offline";
  }, "Отправить в GigaChat только синтетическую вакансию и синтетические резюме без реальных персональных данных?");
}

const REPORT_JSON = `Верни один JSON-объект по схеме API. В rows перечисли все переданные ID по одному разу и закончи список.
Для «нет данных» верни evidence_id: null. Для остальных статусов укажи evidence_id одного подтверждающего фрагмента из массива resume_evidence. Номер фрагмента заменяет текст цитаты в ответе модели. Дословную цитату добавит сайт.
В summary напиши одно короткое предложение, в gap — до 12 слов или пустую строку. В questions — до двух коротких вопросов или пустой список.
Заполни privacy_review_required по результату проверки, без повторения персональных данных. После закрытия JSON заверши ответ.`;

function approvedCriteria() {
  return [["required", "Обязательный"], ["desirable", "Желательный"]]
    .flatMap(([key, kind]) => state.vacancy[key].split(/\n+/).map(s => s.trim())
      .filter(Boolean).map(criterion => ({ criterion, kind })))
    .map((row, index) => ({ id: index + 1, ...row }));
}

function matchWithGigaChat() {
  syncCurrentScreen();
  const criteria = approvedCriteria();
  if (!state.vacancy.title.trim() || !criteria.some(row => row.kind === "Обязательный")) {
    notify("Заполните название вакансии и обязательные критерии.");
    return;
  }
  if (!state.candidates.length || state.candidates.some(c => !c.evidence.trim())) {
    notify("Заполните дословные подтверждения для каждого резюме.");
    return;
  }
  return runModelDemo(async progress => {
    const reports = [];
    const classes = { "соответствует": "good", "частично": "partial", "не соответствует": "none", "нет данных": "none" };
    for (const [index, candidate] of state.candidates.entries()) {
      progress(`GigaChat сопоставляет резюме ${index + 1} из ${state.candidates.length}…`);
      const evidence = candidate.evidence.split(/\n+/).map(text => text.trim()).filter(Boolean)
        .map((text, position) => ({ id: position + 1, text }));
      const matchPrompt = state.prompts.match.replace(/ФОРМАТ ОТВЕТА \(строго\)[\s\S]*?(?=ЯЗЫК И ТОН)/, "");
      const report = await requestGigaChat("match", `${matchPrompt}\n\n${REPORT_JSON}`,
        JSON.stringify({ approved: true, vacancy: state.vacancy.title, criteria, resume_evidence: evidence }),
        `Сопоставление резюме ${index + 1}`);
      if (report?.privacy_review_required !== false) throw new Error(`Проверьте обезличивание резюме ${index + 1}.`);
      if (!Array.isArray(report.rows) || report.rows.length !== criteria.length ||
          new Set(report.rows.map(row => row?.id)).size !== criteria.length) {
        throw new Error("GigaChat вернул неполный список критериев.");
      }
      const rows = criteria.map(criterion => {
        const row = report.rows.find(item => item?.id === criterion.id);
        if (!row || !Object.hasOwn(classes, row.status)) throw new Error("GigaChat вернул неизвестный статус или критерий.");
        const source = evidence.find(item => item.id === row.evidence_id);
        if (row.status !== "нет данных" && !source) return {
          ...criterion, status: "none", label: "Требуется проверка", quote: "Цитаты нет",
          gap: "Модель не указала доступный фрагмент резюме. Проверьте критерий вручную."
        };
        return { ...criterion, status: classes[row.status], label: row.status,
          quote: row.status === "нет данных" ? "Цитаты нет" : source.text,
          gap: typeof row.gap === "string" ? row.gap : "" };
      });
      reports.push({
        rows,
        summary: typeof report.summary === "string" ? report.summary : "",
        questions: Array.isArray(report.questions) ? report.questions.filter(q => typeof q === "string") : []
      });
    }
    state.candidates.forEach((candidate, index) => { candidate.modelReport = reports[index]; });
    state.reportMode = "gigachat";
    state.step = 2;
    window.scrollTo(0, 0);
  }, "Подтвердить утверждённые критерии и отправить в GigaChat только проверенные фрагменты синтетических резюме?");
}
