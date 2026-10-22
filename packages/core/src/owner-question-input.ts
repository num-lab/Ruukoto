// Note: 见 .agents/notes/implemented/feature/2026-10-21-personal-owner-questions.md
export type OwnerQuestionOption = string | { label: string; description?: string; recommended?: boolean };
export interface OwnerQuestionItem { question: string; options?: OwnerQuestionOption[]; multiple?: boolean }
export interface OwnerAnswer { text: string; option?: number; options?: number[] }
export class OwnerQuestionError extends Error {
  constructor(readonly code: "invalid_params" | "question_pending" | "question_not_pending" | "question_version" | "question_not_found" | "question_source_invalid" | "request_conflict" | "question_corrupt", message: string = `操作未接纳（${code}）；结束本轮并向拥有者说明。`) {
    super(message);
    this.name = "OwnerQuestionError";
  }
}

export function parseOwnerQuestions(value: unknown): OwnerQuestionItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) throw new OwnerQuestionError("invalid_params", "一次提交1–3题，修正题目后重试。");
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new OwnerQuestionError("invalid_params");
    const record = item as Record<string, unknown>;
    if (Object.keys(record).some(key => !["question", "options", "multiple"].includes(key)) || typeof record.question !== "string" || !record.question.trim() || record.question.length > 2000) throw new OwnerQuestionError("invalid_params", "题目须非空且最多2000字符，修正后重试。");
    let options: OwnerQuestionOption[] | undefined;
    if (record.options !== undefined) {
      if (!Array.isArray(record.options) || record.options.length < 2 || record.options.length > 5) throw new OwnerQuestionError("invalid_params", "选择题须有2–5个选项，修正后重试。");
      options = record.options.map(option => {
        if (typeof option === "string") {
          if (!option.trim() || option.length > 200) throw new OwnerQuestionError("invalid_params", "选项名须非空且最多200字符，修正后重试。");
          return option;
        }
        if (!option || typeof option !== "object" || Array.isArray(option)) throw new OwnerQuestionError("invalid_params");
        const entry = option as Record<string, unknown>;
        if (Object.keys(entry).some(key => !["label", "description", "recommended"].includes(key)) || typeof entry.label !== "string" || !entry.label.trim() || entry.label.length > 200 ||
          (entry.description !== undefined && (typeof entry.description !== "string" || entry.description.length > 500)) ||
          (entry.recommended !== undefined && typeof entry.recommended !== "boolean")) throw new OwnerQuestionError("invalid_params", "选项名须非空且最多200字符，说明最多500字符，recommended须为布尔值；修正后重试。");
        return { label: entry.label, ...(typeof entry.description === "string" ? { description: entry.description } : {}), ...(typeof entry.recommended === "boolean" ? { recommended: entry.recommended } : {}) };
      });
      if (new Set(options.map(option => typeof option === "string" ? option : option.label)).size !== options.length) throw new OwnerQuestionError("invalid_params", "选项名须互异，修正后重试。");
    }
    if ((record.multiple !== undefined && typeof record.multiple !== "boolean") || (record.multiple === true && !options)) throw new OwnerQuestionError("invalid_params", "multiple须为布尔值，多选题须提供选项；修正后重试。");
    return { question: record.question, ...(options ? { options } : {}), ...(typeof record.multiple === "boolean" ? { multiple: record.multiple } : {}) };
  });
}

export function parseOwnerAnswers(value: unknown, questions: OwnerQuestionItem[]): OwnerAnswer[] {
  if (!Array.isArray(value) || value.length !== questions.length) throw new OwnerQuestionError("invalid_params", "请逐题作答或跳过。");
  return value.map((answer, index) => {
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw new OwnerQuestionError("invalid_params");
    const record = answer as Record<string, unknown>, question = questions[index];
    if (Object.keys(record).some(key => !["text", "option", "options"].includes(key)) || typeof record.text !== "string" || record.text.length > 4096 ||
      (record.text !== "" && !record.text.trim())) throw new OwnerQuestionError("invalid_params", "答案最多4096字符，跳过请提交空字符串；核对后重试。");
    const labels = question.options?.map(option => typeof option === "string" ? option : option.label);
    if ("option" in record) {
      if ("options" in record || question.multiple || typeof record.option !== "number" || !Number.isInteger(record.option) || record.option < 0 || !labels || record.option >= labels.length || record.text !== labels[record.option]) throw new OwnerQuestionError("invalid_params", "单选答案须匹配所选选项；核对后重试。");
      return { text: record.text, option: record.option };
    }
    if ("options" in record) {
      const selected = record.options;
      if (!question.multiple || !labels || !Array.isArray(selected) || selected.length < 1 || selected.length > labels.length ||
        selected.some((option, selectedIndex) => typeof option !== "number" || !Number.isInteger(option) || option < 0 || option >= labels.length || (selectedIndex > 0 && option <= selected[selectedIndex - 1])) ||
        record.text !== selected.map(option => labels[option]).join("\n")) throw new OwnerQuestionError("invalid_params", "多选索引须按选项顺序互异，答案须为选项名以换行连接；核对后重试。");
      return { text: record.text, options: [...selected] as number[] };
    }
    return { text: record.text };
  });
}
