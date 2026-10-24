export const RANK_CATALOG = [
  "Рядовой", "Ефрейтор", "Младший сержант", "Сержант", "Старший сержант", "Старшина",
  "Прапорщик", "Старший прапорщик", "Младший лейтенант", "Лейтенант", "Старший лейтенант",
  "Капитан", "Майор", "Подполковник", "Полковник", "Генерал-майор", "Генерал-лейтенант",
  "Генерал-полковник", "Генерал армии",
] as const;

export type RankCatalogValue = (typeof RANK_CATALOG)[number];

const RANK_ALIASES: Record<string, RankCatalogValue> = {
  "Мл. Сержант": "Младший сержант",
  "Ст. Сержант": "Старший сержант",
  "Ст. Прапорщик": "Старший прапорщик",
  "Мл. Лейтенант": "Младший лейтенант",
  "Ст. Лейтенант": "Старший лейтенант",
};

export function normalizeRank(value: unknown): RankCatalogValue | "" {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if ((RANK_CATALOG as readonly string[]).includes(trimmed)) return trimmed as RankCatalogValue;
  return RANK_ALIASES[trimmed] ?? "";
}

export function normalizeSteamId64(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/^ID:\s*/i, "").replace(/\D/g, "");
}

export function isSteamId64(value: unknown): value is string {
  return typeof value === "string" && /^7656119\d{10}$/.test(value);
}
