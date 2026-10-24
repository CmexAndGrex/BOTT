/**
 * Гибридная сессия бойца: вход через Discord OAuth2 или по позывному/паролю.
 *
 * Почему не NextAuth: панель уже работает на собственной проверенной схеме —
 * JWT (jose) в httpOnly-cookie, версия токена в БД (token_version), единые
 * гварды requireAuth/requireRole и CSRF-защита в middleware. Второй, внешний
 * стек авторизации дал бы две несвязанные сессии на один продукт: отзыв
 * токена и смену пароля пришлось бы реализовывать дважды. Поэтому вход
 * бойца выпускает ТОТ ЖЕ тип токена — но в отдельной cookie `member_token`,
 * чтобы сессия бойца не пересекалась с сессией администратора панели.
 *
 * Здесь — серверная часть: выпуск/проверка сессии и клиент Discord OAuth2
 * (authorize → token → users/@me). Чистые правила лежат в recruits.ts.
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { SignJWT, jwtVerify } from "jose";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { memberSessions, members, recruitApplications, users } from "@/db/schema";
import { getJwtSecret } from "@/lib/auth";
import { getAuthUser, isSecureRequest } from "@/lib/api-auth";
import {
  hasProfileAccess,
  MANUAL_DISCORD_ID,
  MEMBER_STATUS,
  normalizeMemberStatus,
  type MemberRole,
  type MemberStatus,
} from "@/lib/recruits";
import { pickMemberForPanelAccount, CABINET_STATE_MESSAGES, type CabinetState, type PanelMemberCandidate } from "@/lib/panel-link";
import { normalizeCommanderRole, resolvePanelRights } from "@/lib/panel-rights";
import { browserOrigin } from "@/lib/validation";

/* ------------------------------------------------------------------ */
/* Константы                                                           */
/* ------------------------------------------------------------------ */

/** Cookie сессии бойца (сессия панели — auth_token, они не пересекаются) */
export const MEMBER_COOKIE = "member_token";

/** Cookie подписанного state: привязывает OAuth-продолжение к этому браузеру */
export const MEMBER_OAUTH_STATE_COOKIE = "member_oauth_state";
/** Id бойца, начавшего привязку Discord (проверяется в callback) */
export const MEMBER_OAUTH_LINK_COOKIE = "member_oauth_link";
/** Контакт Discord из входа: id|ник|аватар, для предзаполнения формы рапорта */
export const MEMBER_OAUTH_PENDING_COOKIE = "member_oauth_pending";

/** Срок жизни сессии бойца */
export const MEMBER_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Время на прохождение OAuth-редиректа (успеть ввести пароль Discord) */
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

/** Назначение токена: защищает от подстановки токена другого вида */
const MEMBER_PURPOSE = "member_session";
const OAUTH_STATE_PURPOSE = "discord_oauth_state";

/** Способ входа — пишется в журнал входов */
export type MemberLoginKind = "discord" | "password";

/* ------------------------------------------------------------------ */
/* Сессия                                                              */
/* ------------------------------------------------------------------ */

/** Данные сессии для интерфейса (наличие пароля и Discord — флагами) */
export type SessionMember = {
  id: number;
  callsign: string;
  /**
   * ФИО бойца из табеля.
   *
   * Нужно карточке рапорта: в Embed поле «Боец» показывает реальное ФИО, а не
   * голый «#id». В строках синхронизации rs-red.com ФИО может совпадать с
   * позывным — форма подписи это учитывает (fighterDisplayName в reports.ts).
   */
  name: string;
  discordId: string | null;
  rank: string;
  unit: string | null;
  /**
   * Должность из табеля.
   *
   * Нужна для прав: должность «Командир подразделения» даёт командира даже
   * без роли штаба в колонке role (см. resolvePanelRights). Без неё страница
   * «Контроль» и правка Discord ID отказывали командиру с сессией кабинета.
   */
  post: string | null;
  status: MemberStatus;
  role: MemberRole;
  avatarUrl: string | null;
  hasPassword: boolean;
  hasDiscord: boolean;
  createdAt: Date;
  /**
   * Как подтверждён текущий вход. Нужен смене пароля: Discord-сессию выдал
   * OAuth2, поэтому текущий пароль у неё спрашивать не за что; `panel` —
   * вход по cookie панели (auth_token), а не по cookie бойца.
   */
  sessionKind?: MemberLoginKind | "panel";
};

type MemberTokenPayload = {
  memberId?: unknown;
  callsign?: unknown;
  role?: unknown;
  tokenVersion?: unknown;
  kind?: unknown;
  purpose?: unknown;
};

/**
 * Выпускает сессию бойцу: подписывает JWT и записывает вход в журнал.
 * Возвращает параметры cookie, а ставит её вызывающий роут — так флаг Secure
 * вычисляется по фактической схеме запроса (как в /api/auth).
 */
export async function issueMemberSession(
  member: {
    id: number;
    callsign: string;
    role: MemberRole;
    memberTokenVersion: number;
  },
  kind: MemberLoginKind,
  meta: { ip: string }
): Promise<{ token: string; maxAge: number; expiresAt: Date }> {
  const jti = `${member.id}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const expiresAt = new Date(Date.now() + MEMBER_SESSION_TTL_SECONDS * 1000);

  const token = await new SignJWT({
    purpose: MEMBER_PURPOSE,
    memberId: member.id,
    callsign: member.callsign,
    role: member.role,
    // Сверяется на каждом запросе: смена пароля, отклонение рапорта или
    // отвязка Discord обрывают уже выданные сессии одним UPDATE.
    tokenVersion: member.memberTokenVersion,
    kind,
    jti,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(`${MEMBER_SESSION_TTL_SECONDS}s`)
    .sign(getJwtSecret());

  // Журнал входов не должен ломать сам вход: он уже состоялся, запись — учёт
  try {
    await db.insert(memberSessions).values({
      id: jti,
      memberId: member.id,
      kind,
      ip: meta.ip.slice(0, 100),
      expiresAt,
    });
  } catch (e) {
    console.error("[member-auth] Не удалось записать журнал входов:", e);
  }

  return { token, maxAge: MEMBER_SESSION_TTL_SECONDS, expiresAt };
}

/** Проверяет подпись токена бойца и возвращает его полезную нагрузку */
async function verifyMemberToken(token: string): Promise<MemberTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    const data = payload as MemberTokenPayload;
    if (data.purpose !== MEMBER_PURPOSE) return null;
    return data;
  } catch {
    return null;
  }
}
/** Карточка бойца из БД вместе с версией токена (нужна для сверки отзыва) */
type LoadedMember = { member: SessionMember; tokenVersion: number };

/**
 * Самоисцеление статуса при входе (требование «железной» авторизации).
 *
 * Проблема, которую это лечит. Боец уже есть в `division_members`, но его
 * статус остался `pending` (или NULL) — например, карточку создала
 * синхронизация, а ручная правка сбросила статус, либо заявку одобрили до
 * появления автоперевода. Такой человек видел «Ваш рапорт находится на
 * рассмотрении штаба» при каждом входе, хотя он давно в составе, и решал, что
 * доступ сломан.
 *
 * Правило: если запись в табеле есть и статус НЕ `dismissed`, это действующий
 * боец — вход разрешён, а статус в БД приводится к `active`. Заявки этого бойца
 * в `recruit_applications` одновременно переводятся в `approved`: очередь
 * модерации не должна показывать уже принятого человека.
 *
 * `dismissed` не трогаем никогда — это осознанное исключение, и «лечить» его
 * автопереводом в строй значило бы вернуть доступ уволенному.
 *
 * Ошибки записи не отменяют вход: человек уже подтвердил личность, а статус —
 * производное поле. Возвращается тот статус, по которому принимается решение.
 */
export async function healMemberAccessOnLogin(member: {
  id: number;
  status: unknown;
}): Promise<MemberStatus> {
  const status = normalizeMemberStatus(member.status);

  // Не pending — лечить нечего. `dismissed` — осознанное исключение.
  if (status !== MEMBER_STATUS.PENDING) return status;

  try {
    await db
      .update(members)
      .set({ status: MEMBER_STATUS.ACTIVE, active: true, updatedAt: new Date() })
      .where(eq(members.id, member.id));

    /**
     * Заявки закрываются тем же действием. `new` — наследие старых записей:
     * в типе ReviewStatus его нет, но строка в БД осталась бы «в очереди»
     * навсегда, поэтому фильтр идёт SQL-условием, а не значением типа.
     */
    await db
      .update(recruitApplications)
      .set({
        status: "approved",
        reviewedBy: "автоматически (вход бойца)",
        updatedAt: new Date(),
      })
      .where(
        sql`${recruitApplications.memberId} = ${member.id} AND ${recruitApplications.status} IN ('pending', 'new')`
      );

    console.info(
      `[member-auth] Статус бойца #${member.id} самоисцелён: pending → active`
    );
  } catch (e) {
    // Вход важнее записи статуса: решение «допустить» уже принято
    console.error("[member-auth] Не удалось самоисцелить статус бойца:", e);
  }

  // Даже при сбое записи доступ выдаётся: правило «есть в табеле → боец»
  return MEMBER_STATUS.ACTIVE;
}

/**
 * Читает карточку бойца по id в виде, нужном кабинету.
 * null — бойца нет или у него нет доступа (рапорт на рассмотрении / исключён).
 */
async function loadSessionMember(memberId: number): Promise<LoadedMember | null> {
  const [row] = await db
    .select({
      id: members.id,
      callsign: members.callsign,
      name: members.name,
      discordId: members.discordId,
      rank: members.rank,
      unit: members.unit,
      post: members.post,
      status: members.status,
      role: members.role,
      avatarUrl: members.avatarUrl,
      passwordHash: members.passwordHash,
      memberTokenVersion: members.memberTokenVersion,
      createdAt: members.createdAt,
    })
    .from(members)
    .where(eq(members.id, memberId));

  if (!row) return null;
  /**
   * Статус читается через normalizeMemberStatus: в БД встречаются `in_service`,
   * `service` и русские подписи «В строю». Точное сравнение со строкой
   * "pending" отсекало бы действующего бойца с альтернативным написанием, и
   * сессия кабинета «исчезала» сразу после успешного входа через Discord.
   */
  /**
   * Статус: исключённый боец доступа не получает, а `pending` самоисцеляется.
   *
   * Раньше здесь стояло `status === "dismissed" || status === "pending" →
   * null`, и боец со статусом pending в табеле не мог открыть кабинет никогда:
   * даже после входа через Discord он возвращался на экран «рапорт на
   * рассмотрении». По требованию плашка ожидания теперь возможна ТОЛЬКО когда
   * бойца нет в division_members, поэтому запись в табеле = доступ.
   */
  let status = normalizeMemberStatus(row.status);
  if (status === MEMBER_STATUS.DISMISSED) return null;
  if (status === MEMBER_STATUS.PENDING) {
    status = await healMemberAccessOnLogin({ id: row.id, status: row.status });
  }

  return {
    member: {
      id: row.id,
      callsign: row.callsign || "",
      name: row.name || "",
      discordId: row.discordId,
      rank: row.rank,
      unit: row.unit,
      post: row.post,
      status,
      role: row.role,
      avatarUrl: row.avatarUrl,
      hasPassword: !!row.passwordHash,
      hasDiscord: !!row.discordId && row.discordId !== MANUAL_DISCORD_ID,
      createdAt: row.createdAt,
    },
    tokenVersion: row.memberTokenVersion,
  };
}

/**
 * Боец, связанный с учётной записью панели, по данным самой учётной записи.
 *
 * Вынесено отдельно от getPanelSessionMember, потому что этим же правилом
 * пользуется вход: на момент выдачи cookie сессии панели её ещё нет в запросе,
 * и «прочитать сессию» невозможно — а связать бойца нужно именно тогда, чтобы
 * кабинет открылся сразу, без второго входа.
 *
 * Порядок: явная связка users.member_id, затем подтверждённый Discord ID, затем
 * позывной (правило в panel-link.ts). Отсутствие связи — это null, а не ошибка:
 * у администратора может не быть записи в табеле.
 */
export async function findMemberForPanelAccount(account: {
  username: string;
  memberId?: number | null;
  discordId?: string | null;
}): Promise<SessionMember | null> {
  if (account.memberId) {
    const linked = await loadSessionMember(account.memberId);
    // Связка есть, но боец потерял доступ (исключён, рапорт на рассмотрении) —
    // дальше не ищем: подменять одного бойца другим по совпадению позывного
    // значило бы показать чужое личное дело.
    return linked?.member ?? null;
  }

  const roster = await db
    .select({
      id: members.id,
      callsign: members.callsign,
      name: members.name,
      discordId: members.discordId,
      status: members.status,
      role: members.role,
    })
    .from(members);

  const candidate: PanelMemberCandidate | null = pickMemberForPanelAccount(
    { username: account.username, discordId: account.discordId ?? null },
    roster
  );
  if (!candidate) return null;

  const loaded = await loadSessionMember(candidate.id);
  return loaded?.member ?? null;
}

/**
 * Боец, связанный с учётной записью панели, по сессии панели.
 *
 * Зачем: командир или администратор входит в панель (логин и пароль, Discord
 * или dev-вход) и должен видеть своё личное дело, не вводя данные второй раз.
 * Раньше связка искалась только при входе через Discord, поэтому после входа по
 * паролю /profile показывал заглушку «войдите в личный кабинет» — а кнопка
 * «Войти» вела на /login и возвращала туда же (цикл из отчёта).
 *
 * Права проверяются по сессии панели: роль берётся из БД в getAuthUser, значит
 * понижение прав действует немедленно. Гость и боец без прав штаба связи не
 * получают: сессия панели у них и не появится.
 */
export async function getPanelSessionMember(req: NextRequest): Promise<SessionMember | null> {
  const user = await getAuthUser(req);
  if (!user || (user.role !== "admin" && user.role !== "officer")) return null;

  const [account] = await db
    .select({ memberId: users.memberId, discordId: users.discordId })
    .from(users)
    .where(eq(users.username, user.username ?? ""));
  if (!account) return null;

  const member = await findMemberForPanelAccount({
    username: user.username ?? "",
    memberId: account.memberId,
    discordId: account.discordId,
  });
  return member ? { ...member, sessionKind: "panel" } : null;
}

/**
 * Открывает кабинет бойцу, связанному с только что вошедшей учётной записью.
 *
 * Вызывается роутами входа в панель сразу после выдачи cookie панели: одна
 * сессия панели даёт и личное дело. Cookie кабинета при этом настоящая
 * (выпускается сервером и сверяется с БД), а не «право на чтение» — иначе смена
 * пароля или исключение бойца не отзывали бы доступ.
 *
 * null — связи нет или боец не в строю. Это НЕ ошибка входа: сессия панели уже
 * выдана, и вход не должен рушиться из-за отсутствия записи в табеле.
 */
export async function attachCabinetSession(
  response: NextResponse,
  req: NextRequest,
  account: { username: string; memberId?: number | null; discordId?: string | null },
  kind: MemberLoginKind = "password"
): Promise<SessionMember | null> {
  try {
    const member = await findMemberForPanelAccount(account);
    if (!member) return null;
    // Кабинет открывается только зачисленным: кандидату со статусом pending
    // личное дело не показывается (правило hasProfileAccess — одно на проект).
    if (!hasProfileAccess(member.status)) return null;

    const [row] = await db
      .select({ memberTokenVersion: members.memberTokenVersion })
      .from(members)
      .where(eq(members.id, member.id));
    if (!row) return null;

    const session = await issueMemberSession(
      {
        id: member.id,
        callsign: member.callsign,
        role: member.role,
        memberTokenVersion: row.memberTokenVersion,
      },
      kind,
      { ip: requestIp(req) }
    );
    setMemberCookie(response, session, req);
    return member;
  } catch (e) {
    // Кабинет — дополнение к входу в панель: сбой в нём не должен отменять
    // уже состоявшийся вход (человек просто откроет кабинет отдельно).
    console.error("[member-auth] Не удалось открыть кабинет по сессии панели:", e);
    return null;
  }
}

/**
 * Текущий боец по cookie. null — токена нет, он просрочен, подделан, отозван
 * или боец удалён/отклонён.
 *
 * Роль и статус читаются из БД, а не из токена: понижение прав, одобрение
 * рапорта и исключение действуют немедленно, без перевыпуска cookie. Токены,
 * выданные до смены пароля, отсекаются по memberTokenVersion.
 *
 * Если cookie кабинета нет или она недействительна, пробуем сессию панели:
 * командир, вошедший в панель, — тот же человек, и требовать от него второго
 * входа значило бы показывать ему заглушку вместо собственного личного дела.
 */
export async function getSessionMember(req: NextRequest): Promise<SessionMember | null> {
  const token = req.cookies.get(MEMBER_COOKIE)?.value;
  if (token) {
    const payload = await verifyMemberToken(token);
    if (payload && typeof payload.memberId === "number") {
      const loaded = await loadSessionMember(payload.memberId);
      if (loaded) {
        const tokenVersion = typeof payload.tokenVersion === "number" ? payload.tokenVersion : 0;
        if (tokenVersion === loaded.tokenVersion) {
          return {
            ...loaded.member,
            sessionKind: payload.kind === "discord" ? "discord" : "password",
          };
        }
      }
      // Токен отозван или боец потерял доступ — сессия панели всё ещё может
      // быть действующей, поэтому не выходим сразу, а идём в общую ветку.
    }
  }

  return getPanelSessionMember(req);
}
/* ------------------------------------------------------------------ */
/* Гварды                                                              */
/* ------------------------------------------------------------------ */

export type MemberAuthResult =
  | { ok: true; member: SessionMember }
  | { ok: false; response: NextResponse };

/** Обязательная сессия бойца: для роутов кабинета */
export async function requireMember(req: NextRequest): Promise<MemberAuthResult> {
  const member = await getSessionMember(req);
  if (!member) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "Нет доступа: войдите в личный кабинет" },
        { status: 401 }
      ),
    };
  }
  return { ok: true, member };
}

/** Сессия бойца со статусом «в строю» или «в отпуске»: только для /profile */
export async function requireActiveMember(req: NextRequest): Promise<MemberAuthResult> {
  const result = await requireMember(req);
  if (!result.ok) return result;
  if (!hasProfileAccess(result.member.status)) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "Личный кабинет доступен бойцам, зачисленным в подразделение" },
        { status: 403 }
      ),
    };
  }
  return result;
}

/**
 * Доступ к личному кабинету с различимым состоянием.
 *
 * Отличие от requireActiveMember: тот на любую неудачу отвечает одним и тем же
 * «войдите в личный кабинет» (401). Из-за этого вошедший в панель командир без
 * связки видел заглушку с кнопкой «Войти» и попадал в цикл: /profile → /login →
 * /profile. Здесь состояние названо точно, и страница может предложить верное
 * действие: войти, связать аккаунт с бойцом в «Доступах» или обратиться к штабу.
 */
export type CabinetAccessResult =
  | { ok: true; member: SessionMember }
  | { ok: false; state: Exclude<CabinetState, "ok">; response: NextResponse };

export async function requireCabinetMember(req: NextRequest): Promise<CabinetAccessResult> {
  const member = await getSessionMember(req);
  if (member) {
    if (hasProfileAccess(member.status)) return { ok: true, member };
    return {
      ok: false,
      state: "no_access",
      response: NextResponse.json(
        { ok: false, state: "no_access", error: CABINET_STATE_MESSAGES.no_access },
        { status: 403 }
      ),
    };
  }

  // Сессии кабинета нет: различаем «гость» и «штаб без связки с бойцом».
  // Второе — не ошибка входа: человек авторизован, но его учётная запись панели
  // не привязана к записи в табеле, и личного дела у неё попросту нет.
  const user = await getAuthUser(req);
  const staff = user?.role === "admin" || user?.role === "officer";
  const state: Exclude<CabinetState, "ok"> = staff ? "not_linked" : "no_session";

  return {
    ok: false,
    state,
    response: NextResponse.json(
      { ok: false, state, error: CABINET_STATE_MESSAGES[state] },
      { status: staff ? 409 : 401 }
    ),
  };
}

/**
 * Доступ к модерации рапортов.
 *
 * Допускаются роль officer/admin у бойца ИЛИ действующая сессия панели: у
 * администратора, который ведёт бота и статистику, рапорта может не быть
 * вовсе, и требовать от него регистрацию — абсурдно. Так доступ не
 * расширяется: обе ветки означают «командир или администратор».
 */
export async function requireStaff(req: NextRequest): Promise<MemberAuthResult> {
  const user = await getAuthUser(req);
  const member = await getSessionMember(req);

  // Права считает то же правило, что и /api/me: обе сессии, роль, должность и
  // звание. Раньше здесь были две ветки (карточка бойца, затем панель), и
  // роут /api/sync отказывал администратору с сессией кабинета — теперь
  // результат один и тот же независимо от того, откуда вошли.
  const rights = resolvePanelRights({
    panelRole: user?.role,
    memberRole: member?.role,
    memberPost: member?.post,
    memberRank: member?.rank,
  });

  if (rights.canControl) {
    /**
     * Роль берётся из ПАНЕЛЬНОЙ сессии, когда она есть, а не из карточки бойца.
     *
     * Администратор может быть связан с бойцом, у которого роль «member»
     * (привязка не понижает панельные права). Верни мы карточку бойца как есть
     * — подпись в журнале и решениях стала бы «Командир», хотя распорядился
     * администратор, и разбор истории запутался бы.
     *
     * Позывной бойца при этом сохраняем: он понятнее логина панели.
     */
    const panelRole = normalizeCommanderRole(user?.role);
    return {
      ok: true,
      member: {
        ...(member ?? EMPTY_SESSION_MEMBER),
        role: panelRole === "admin" || panelRole === "officer" ? panelRole : (member?.role ?? "officer"),
        callsign: member?.callsign || user?.username || "",
      },
    };
  }

  return {
    ok: false,
    response: NextResponse.json(
      { ok: false, error: "Недостаточно прав: раздел доступен командирам и администраторам" },
      { status: 403 }
    ),
  };
}

/**
 * Права штаба у бойца: роль officer/admin (в том числе в написании «commander»)
 * ИЛИ должность/звание командира подразделения из табеля.
 *
 * Должность учитывается намеренно: командир подразделения может не иметь роли
 * штаба в колонке role, но модерация и правка состава — его работа. Командир
 * НЕ получает прав администратора: /settings и обслуживание системы закрыты
 * отдельно (isAdminArea в middleware и requireMaintenance).
 */
export function hasStaffRights(member: { role: unknown; post?: unknown; rank?: unknown }): boolean {
  return resolvePanelRights({
    memberRole: member.role,
    memberPost: member.post,
    memberRank: member.rank,
  }).canControl;
}

/**
 * Пустая карточка бойца для сессий без строки в табеле.
 *
 * Нужна там, где гвард допускает панельную сессию без связанного бойца
 * (администратор ведёт бота и статистику, и требовать от него регистрацию в
 * составе абсурдно). Прав такая карточка не добавляет — решение о доступе уже
 * принято, — и служит только для подписи в журнале и ответа API.
 */
const EMPTY_SESSION_MEMBER: SessionMember = {
  id: 0,
  callsign: "",
  name: "",
  discordId: null,
  rank: "",
  unit: null,
  post: null,
  status: "active",
  role: "officer",
  avatarUrl: null,
  hasPassword: true,
  hasDiscord: false,
  createdAt: new Date(0),
};

/**
 * Доступ к правке строки состава (Discord ID, отпуск).
 *
 * Гвард отдельный от requireStaff намеренно: правка табеля — инструмент
 * командира подразделения, и он обязан работать у бойца, вошедшего в кабинет
 * (у него нет сессии панели), а также у командира, чья должность записана в
 * табеле, но роль штаба в колонке role не выставлена.
 *
 * Правило не дублируется: права считает resolvePanelRights — тот же модуль,
 * что и интерфейс. Иначе «на клиенте поле открыто, а сервер отвечает 403»
 * (ровно этот рассинхрон и пришёл как баг).
 */
export async function requireRosterEditor(req: NextRequest): Promise<MemberAuthResult> {
  const user = await getAuthUser(req);
  const member = await getSessionMember(req);

  const rights = resolvePanelRights({
    panelRole: user?.role,
    memberRole: member?.role,
    memberPost: member?.post,
    memberRank: member?.rank,
  });

  if (rights.canEditRosterDiscordId) {
    /**
     * Роль в карточке — из ПАНЕЛЬНОЙ сессии, когда она есть: администратор,
     * связанный с бойцом-«member», остаётся администратором (привязка не
     * понижает панельные права), и подпись в журнале правки ШДС должна
     * отражать того, кто распорядился.
     *
     * Позывной бойца сохраняем: он понятнее логина панели.
     */
    const panelRole = normalizeCommanderRole(user?.role);
    return {
      ok: true,
      member: {
        ...(member ?? EMPTY_SESSION_MEMBER),
        role: panelRole === "admin" || panelRole === "officer" ? panelRole : (member?.role ?? "officer"),
        callsign: member?.callsign || user?.username || "",
      },
    };
  }

  return {
    ok: false,
    response: NextResponse.json(
      { ok: false, error: "Недостаточно прав: правка состава доступна командирам и администраторам" },
      { status: user ? 403 : 401 }
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Discord OAuth2 (authorize → token → users/@me)                      */
/* ------------------------------------------------------------------ */

/** Права приложения: identify — профиль бойца, guilds — список его серверов */
export const DISCORD_OAUTH_SCOPES = "identify guilds";

/** Профиль бойца из Discord API */
export type DiscordProfile = {
  id: string;
  username: string;
  globalName: string | null;
  avatarUrl: string | null;
};

/**
 * Настроен ли вход через Discord.
 *
 * Принимаем оба написания переменных: в .env проекта исторически есть
 * DISCROD_CLIENT_ID (опечатка), и без второго варианта вход молча считался бы
 * ненастроенным при полностью заполненном окружении.
 */
export function discordOAuthConfig(): { clientId: string; clientSecret: string } | null {
  const clientId = (process.env.DISCORD_CLIENT_ID || process.env.DISCROD_CLIENT_ID || "").trim();
  const clientSecret = (
    process.env.DISCORD_CLIENT_SECRET ||
    process.env.DISCROD_CLIENT_SECRET ||
    ""
  ).trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** Ссылка на согласие в Discord; state привязан к браузеру отдельной cookie */
export function discordAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: DISCORD_OAUTH_SCOPES,
    state,
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

/** Назначение OAuth-продолжения: обычный вход или привязка Discord к аккаунту */
export type OAuthIntent = "login" | "link";

/** Подписанный state: значение в cookie и в URL совпадают, подделка отсекается подписью */
export async function createOAuthState(intent: OAuthIntent): Promise<string> {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new SignJWT({ purpose: OAUTH_STATE_PURPOSE, intent, nonce })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(`${OAUTH_STATE_TTL_SECONDS}s`)
    .sign(getJwtSecret());
}

export type OAuthStateCheck = { ok: false } | { ok: true; intent: OAuthIntent };

/**
 * Проверяет, что OAuth-продолжение начато именно этим браузером.
 * Возвращает намерение из подписанного state — оно не может быть подменено
 * клиентом: привязка Discord к аккаунту (link) отличается от входа (login).
 */
export async function verifyOAuthState(
  state: string | null,
  cookieValue: string | null | undefined
): Promise<OAuthStateCheck> {
  if (!state || !cookieValue) return { ok: false };
  // Первый барьер — быстрый: cookie должна совпадать с параметром запроса
  if (state !== cookieValue) return { ok: false };
  try {
    const { payload } = await jwtVerify(state, getJwtSecret());
    const data = payload as { purpose?: unknown; intent?: unknown };
    if (data.purpose !== OAUTH_STATE_PURPOSE) return { ok: false };
    return { ok: true, intent: data.intent === "link" ? "link" : "login" };
  } catch {
    return { ok: false };
  }
}
/**
 * Обмен кода авторизации на токен и загрузка профиля Discord.
 * Ошибки не пробрасываются наружу: роут показывает пользователю сообщение.
 */
export async function exchangeDiscordCode(
  code: string,
  redirectUri: string
): Promise<{ ok: true; profile: DiscordProfile } | { ok: false; error: string }> {
  const config = discordOAuthConfig();
  if (!config) return { ok: false, error: "Вход через Discord не настроен на сервере" };

  try {
    const tokenRes = await fetch("https://discord.com/api/v10/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
      cache: "no-store",
    });
    if (!tokenRes.ok) {
      return { ok: false, error: `Discord отклонил код авторизации (${tokenRes.status})` };
    }
    const tokenData = (await tokenRes.json()) as { access_token?: string };
    if (!tokenData.access_token) {
      return { ok: false, error: "Discord не вернул токен доступа" };
    }

    const userRes = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
      cache: "no-store",
    });
    if (!userRes.ok) {
      return { ok: false, error: `Не удалось получить профиль Discord (${userRes.status})` };
    }
    const user = (await userRes.json()) as {
      id?: string;
      username?: string;
      global_name?: string | null;
      avatar?: string | null;
    };
    if (!user.id) return { ok: false, error: "Discord вернул профиль без идентификатора" };

    return {
      ok: true,
      profile: {
        id: user.id,
        username: user.username || "",
        globalName: user.global_name || null,
        // Аватар приходит хешем: без него Discord отдаёт букву-заглушку
        avatarUrl: user.avatar
          ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
          : null,
      },
    };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Сбой связи с Discord: ${reason}` };
  }
}

/* ------------------------------------------------------------------ */
/* Хелперы для роутов                                                  */
/* ------------------------------------------------------------------ */

/** IP клиента для журнала входов и ограничителя попыток */
export function requestIp(req: NextRequest): string {
  return (
    (req.headers.get("x-real-ip") || "").trim() ||
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "unknown_ip"
  );
}

/** Ставит cookie сессии бойца с корректным флагом Secure */
export function setMemberCookie(
  response: NextResponse,
  session: { token: string; maxAge: number },
  req: NextRequest
): NextResponse {
  response.cookies.set({
    name: MEMBER_COOKIE,
    value: session.token,
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    // Флаг Secure — по фактической схеме запроса: в dev на http://localhost
    // он снят, иначе cookie не сохранилась бы вовсе.
    secure: isSecureRequest(req),
    maxAge: session.maxAge,
  });
  return response;
}

/** Снимает cookie сессии бойца (выход из кабинета) */
export function clearMemberCookie(response: NextResponse): NextResponse {
  response.cookies.delete(MEMBER_COOKIE);
  return response;
}

/**
 * Адрес возврата после согласия в Discord.
 *
 * Порядок: явный DISCORD_REDIRECT_URI → публичный адрес приложения (APP_URL
 * или NEXT_PUBLIC_APP_URL) → заголовки запроса. Заголовки разбирает
 * browserOrigin: он учитывает x-forwarded-proto/x-forwarded-host и отсекает
 * адрес прослушивания (0.0.0.0), поэтому за Nginx редирект не ломается на
 * http://localhost. DISCORD_REDIRECT_URI нужен только когда внешний адрес
 * отличается от того, что видит приложение (например, прокси не пробрасывает
 * X-Forwarded-*), — этот адрес должен быть зарегистрирован в Discord Developer
 * Portal → OAuth2 → Redirects.
 */
export function discordRedirectUri(req: NextRequest): string {
  const explicit = (process.env.DISCORD_REDIRECT_URI || "").trim();
  if (explicit) return explicit;

  const appUrl = (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "").trim();
  if (appUrl) {
    return `${appUrl.replace(/\/+$/, "")}/api/auth/discord/callback`;
  }

  return `${browserOrigin(req.headers)}/api/auth/discord/callback`;
}
/* ------------------------------------------------------------------ */
/* Контакт Discord для формы рапорта                                   */
/* ------------------------------------------------------------------ */

/**
 * Упаковка контакта Discord в cookie: id|ник|аватар.
 *
 * Cookie httpOnly и ставится только нашим сервером из ответа Discord, поэтому
 * кандидат не может подменить в ней Discord ID и подать рапорт с чужим
 * аккаунтом — а именно это позволило бы увести чужую учётную запись себе.
 */
export function packDiscordProfile(profile: DiscordProfile): string {
  const name = (profile.globalName || profile.username || "").replace(/[|\r\n]/g, " ");
  return [profile.id, name, profile.avatarUrl || ""].join("|");
}

/** Разбор контакта Discord из cookie. null — значения нет или оно испорчено */
export function unpackDiscordProfile(raw: string | null | undefined): DiscordProfile | null {
  if (!raw) return null;
  const [id, name = "", avatar = ""] = raw.split("|");
  if (!/^\d{5,25}$/.test(id || "")) return null;
  return { id, username: name, globalName: name || null, avatarUrl: avatar || null };
}