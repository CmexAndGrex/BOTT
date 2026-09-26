/**
 * Доступ к обслуживанию системы.
 *
 * Правило одно на шесть мест (четыре роута, страница настроек и middleware),
 * поэтому живёт отдельным модулем: копия правила в роуте разошлась бы с
 * проверкой в интерфейсе, и кнопка «Создать резервную копию» либо показывалась
 * бы бойцу, либо исчезала у администратора.
 *
 * Кто допущен: только администратор панели. Обслуживание необратимо — ротация
 * удаляет копии, очистка стирает журнал, синхронизация правит состав. Командиру
 * доступны рабочие разделы (рапорта, выкладки, состав), но не эти действия.
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getAuthUser, type AuthUser } from "@/lib/api-auth";
import { isUnsafeMethod, isCrossSiteRequest } from "@/lib/csrf";
import { getSessionMember, type SessionMember } from "@/lib/member-auth";

/** Роли, допущенные к обслуживанию */
export const MAINTENANCE_ROLES = ["admin"] as const;

/**
 * Доступен ли раздел обслуживания для роли.
 * Принимаются оба пространства ролей — панели (admin/officer) и бойца
 * (recruit/member/officer/admin): правило одно, «администратор или нет».
 */
export function canManageMaintenance(role: unknown): boolean {
  return role === "admin";
}

/**
 * Итог проверки доступа. Вынесен отдельной функцией, потому что это и есть
 * правило RBAC: его проверяет тест матрицей ролей, не поднимая базу.
 */
export type MaintenanceDecision = "allow" | "forbidden" | "unauthenticated";

/**
 * Решение по двум найденным сессиям (панель и боец).
 *
 * Админ в любой из сессий допускается; вошедший, но не админ, получает
 * «forbidden» (403), а не «unauthenticated» (401) — код ответа должен
 * соответствовать реальности, иначе администратор, потерявший права, будет
 * искать проблему в cookie вместо роли.
 */
export function maintenanceDecision(
  panelRole: unknown,
  memberRole: unknown
): MaintenanceDecision {
  if (canManageMaintenance(panelRole) || canManageMaintenance(memberRole)) return "allow";
  if (panelRole !== undefined || memberRole !== undefined) return "forbidden";
  return "unauthenticated";
}

/** Проверка доступа к странице обслуживания (для серверных страниц и middleware) */
export async function hasMaintenanceAccess(req: NextRequest): Promise<boolean> {
  const user = await getAuthUser(req);
  return canManageMaintenance(user?.role);
}

export type MaintenanceAuthResult =
  | { ok: true; username: string | null }
  | { ok: false; response: NextResponse };

/**
 * Источники сессий.
 *
 * Параметр существует ради тестов: без базы подписанный токен не проверяется
 * (роль читается из users/division_members), поэтому «настоящий» 403 для
 * командира иначе не проверить — а именно это требование ТЗ. Боевой код
 * использует значения по умолчанию, подмены в продакшене нет.
 */
export type MaintenanceResolvers = {
  panel?: (req: NextRequest) => Promise<AuthUser | null>;
  member?: (req: NextRequest) => Promise<SessionMember | null>;
};

/** Отказ 403: вошедший, но не администратор */
function denyForbidden(): NextResponse {
  return NextResponse.json({ ok: false, error: "Недостаточно прав: раздел доступен администратору" }, { status: 403 });
}

/** Отказ 401: сессии нет вовсе */
function denyUnauthorized(): NextResponse {
  return NextResponse.json({ ok: false, error: "Нет доступа: авторизуйтесь" }, { status: 401 });
}

/** Отказ 503: база недоступна, состояние доступа проверить нельзя */
function denyUnavailable(): NextResponse {
  return NextResponse.json(
    { ok: false, error: "База данных недоступна: повторите попытку позже" },
    { status: 503 }
  );
}

/**
 * Проверка доступа к роутам обслуживания.
 *
 * Порядок шагов намеренный:
 *   1. роль (админ панели или админ бойца) — рядовой боец получает честный 403
 *      «недостаточно прав», а не «запрос с чужого источника»: иначе по коду
 *      ответа можно было бы выяснить, кто в системе администратор;
 *   2. источник запроса (CSRF) — для методов, меняющих состояние.
 *
 * Проверяются обе сессии, потому что администратор панели и боец кабинета —
 * разные cookie, и один человек может иметь только одну из них.
 */
export async function requireMaintenance(
  req: NextRequest,
  resolvers: MaintenanceResolvers = {}
): Promise<MaintenanceAuthResult> {
  let panel: AuthUser | null = null;
  let member: SessionMember | null = null;

  try {
    // 1. Сессия панели: роль читается из БД, понижение прав действует сразу
    panel = await (resolvers.panel ?? getAuthUser)(req);
    // 2. Сессия бойца: тот же уровень «admin» в её пространстве ролей
    member = panel ? null : await (resolvers.member ?? getSessionMember)(req);
  } catch {
    // БД недоступна. Отдаём 503, а не 500: администратору важно понять, что
    // дело в базе, а не в правах — иначе он пойдёт «чинить» доступ.
    return { ok: false, response: denyUnavailable() };
  }

  const decision = maintenanceDecision(
    panel ? panel.role : undefined,
    member ? member.role : undefined
  );

  if (decision === "unauthenticated") return { ok: false, response: denyUnauthorized() };
  if (decision === "forbidden") return { ok: false, response: denyForbidden() };

  return finishAuth(req, panel?.username ?? member?.callsign ?? null);
}

/**
 * CSRF-проверка источника для действий, меняющих состояние.
 *
 * Middleware тоже её выполняет, но роут не должен от него зависеть: matcher
 * middleware может быть сужен, и тогда чужой сайт смог бы отправить POST —
 * снять дамп, запустить ротацию (то есть УДАЛИТЬ копии) или очистить журнал.
 */
async function finishAuth(
  req: NextRequest,
  username: string | null
): Promise<MaintenanceAuthResult> {
  if (isUnsafeMethod(req.method) && isCrossSiteRequest(req)) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "Запрос с чужого источника отклонён" },
        { status: 403 }
      ),
    };
  }
  return { ok: true, username };
}

/** Подпись автора для журнала: в bot_logs пишем роль и логин */
export function maintenanceAuthor(username: string | null | undefined): string {
  const name = (username || "").trim();
  return name ? `Администратор ${name}` : "Администратор";
}