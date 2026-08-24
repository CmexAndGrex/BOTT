export type RosterMember = {
  pid: string | null;
  handle: string | null;
  name: string;
  rankName: string | null;
  post: string | null;
  minutes: number;
  hours: number;
};

export type RosterResult = {
  members: RosterMember[];
  fetchedAt: string;
};

/**
 * Забирает состав подразделения с rs-red.com.
 * Использует тот же приватный JSON-эндпоинт, что и фронт сайта:
 * GET /api/subdivision/{id} (нужна сессионная cookie Steam-входа).
 */
export async function fetchRoster(
  cookie: string,
  baseUrl: string,
  subdivId: string
): Promise<RosterResult> {
  const base = (baseUrl || "https://rs-red.com").replace(/\/+$/, "");
  const id = encodeURIComponent(subdivId || "5");
  const url = `${base}/api/subdivision/${id}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  let res: Response;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) RED-OPS-Control/1.0",
        Cookie: cookie,
        Referer: `${base}/divisions/${id}`,
      },
    });
  } catch (e) {
    throw new Error(
      `Не удалось подключиться к ${base}: ${e instanceof Error ? e.message : "сеть недоступна"}`
    );
  } finally {
    clearTimeout(timeout);
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      "Сайт отклонил доступ (403). Cookie устарела или отсутствует — обновите её в настройках."
    );
  }
  if (!res.ok) {
    throw new Error(`rs-red.com ответил кодом ${res.status}`);
  }

  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      "rs-red.com вернул не JSON — скорее всего, cookie недействительна. Обновите её в настройках."
    );
  }
  if (!Array.isArray(data)) {
    throw new Error("Неожиданный формат ответа rs-red.com (ожидался массив бойцов).");
  }

  const members: RosterMember[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    const minutes =
      typeof p.online === "number" && Number.isFinite(p.online) ? p.online : 0;
    const name =
      typeof p.name === "string" && p.name.trim() ? p.name.trim() : "Без имени";
    members.push({
      pid: typeof p.pid === "string" && p.pid ? p.pid : null,
      handle:
        typeof p.forum_handle === "string" && p.forum_handle
          ? p.forum_handle
          : null,
      name,
      rankName:
        typeof p.rankname === "string" && p.rankname ? p.rankname : null,
      post:
        typeof p.subdivpost === "string" && p.subdivpost ? p.subdivpost : null,
      minutes,
      hours: Math.floor((minutes / 60) * 10) / 10,
    });
  }

  return { members, fetchedAt: new Date().toISOString() };
}
