import { cleanText } from "./security.mjs";
import { redactSecrets } from "./redaction.mjs";

export function buildAuxiliaryContext({ provider, project, message }) {
  const raw = [
    "Bạn là chuyên gia phụ trợ cho một Codex agent đang triển khai dự án.",
    "Hãy phân tích yêu cầu, nêu rủi ro, phương án và các bước kiểm chứng. Không giả vờ đã đọc file ngoài nội dung được cung cấp.",
    `Dự án: ${project.name}`,
    `Mục tiêu/checkpoint: ${project.summary || "Chưa ghi"}`,
    `Việc tiếp theo: ${project.nextStep || "Chưa ghi"}`,
    `Yêu cầu hiện tại: ${message}`
  ].join("\n\n");
  const redacted = redactSecrets(raw);
  const estimatedInputTokens = Math.ceil(redacted.text.length / 4);
  return {
    prompt: cleanText(redacted.text, 100000),
    preview: {
      providerId: provider.id,
      providerLabel: provider.label,
      providerType: provider.type,
      model: provider.model,
      reason: "Phân tích độc lập trước khi Codex triển khai yêu cầu hiện tại.",
      dataItems: ["Tên dự án", "Checkpoint dự án", "Việc tiếp theo", "Yêu cầu hiện tại"],
      files: [],
      estimatedInputTokens,
      maxOutputTokens: provider.maxOutputTokens,
      estimatedMaximumTokens: estimatedInputTokens + Number(provider.maxOutputTokens || 0),
      redactions: redacted.redactions
    }
  };
}
