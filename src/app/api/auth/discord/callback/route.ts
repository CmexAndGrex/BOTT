/**
 * Возврат из Discord OAuth2.
 *
 * Четыре исхода:
 *  1. intent=link — привязка Discord к текущему аккаунту бойца;
 *  2. Discord привязан к учётной записи панели (users.discord_id) с ролью
 *     admin/officer — сразу выдаём сессию панели (auth_token): администратор и
 *     командир попадают в модерацию, /users и админ-функции без локального
 *     логина и пароля. Если такой человек ещё и боец в строю, дополнительно
 *     выдаётся сессия кабинета — обе cookie живут одновременно;
 *  3. боец найден по discord_id и рапорт одобрен — выдаём сессию кабинета
 *     (основной «быстрый вход»);
 *  4. ни аккаунта панели, ни бойца — сохраняем контакт Discord в
 *     короткоживущую cookie и уводим на /apply: форма рапорта подтянет ID и
 *     аватар автоматически.
 *
 * Ошибки передаются на /login кодом (?error=...), а не текстом: чужой текст в
 * интерфейсе показывать нельзя.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { members, recruitApplications } from "@/db/schema";
import {
  findPanelUserByDiscordId,
  isSecureRequest,
  issuePanelToken,
  logPanelLogin,
  setPanelCookie,
  type PanelAccount,
} from "@/lib/api-auth";
import { isPanelStaffRole, browserOrigin, normalizeDiscordSnowflake } from "@/lib/validation";
import {
  hasProfileAccess,
  normalizeMemberStatus,
  normalizePersonName,
  type MemberRole,
} from "@/lib/recruits";
import { resolvePanelRights } from "@/lib/panel-rights";
import {
  discordRedirectUri,
  exchangeDiscordCode,
  issueMemberSession,
  MEMBER_OAUTH_LINK_COOKIE,
  MEMBER_OAUTH_PENDING_COOKIE,
  MEMBER_OAUTH_STATE_COOKIE,
  packDiscordProfile,
  requestIp,
  setMemberCookie,
  verifyOAuthState,
  type DiscordProfile,
} from "@/lib/member-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Контакт Discord ждёт заполнения рапорта не дольше получаса */
const PENDING_TTL_SECONDS = 30 * 60;

/**
 * Куда вести браузер после возврата из Discord.
 *
 * Адрес берём из `browserOrigin`, а не из `req.url`: в standalone-сборке Next
 * собирает req.url из переменной окружения HOSTNAME, а Dockerfile задаёт
 * HOSTNAME=0.0.0.0. Браузер по такому адресу не идёт — пользователь видел
 * ERR_ADDRESS_INVALID уже после успешного согласия в Discord.
 */
function redirectTo(req: NextRequest, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, browserOrigin(req.headers)));
}

/**
 * Боец по Discord ID.
 *
 * Сравниваем не через eq, а по цифрам: в division_members значение могло
 * сохраниться с пробелами или как упоминание («<@123…>») из ручной правки или
 * синхронизации. Точное совпадение тогда не находило уже привязанного бойца —
 * вход через Discord отвечал «не привязан».
 *
 * ID приводятся к String на входе: Discord отдаёт строку, а в БД и в вызовах
 * из панели значение может оказаться number/bigint. Без приведения «11678…» и
 * 11678… сравнивались бы по-разному, и боец «пропадал» из поиска.
 *
 * shortcut: сравнение по regexp_replace не использует индекс discord_id;
 * при росте состава перейти на нормализованную колонку или выражение-индекс.
 */
async function findMemberByDiscordId(discordId: string) {
  const normalized = String(discordId ?? "").trim();
  if (!normalized) return undefined;
  const [row] = await db
    .select()
    .from(members)
    .where(
      sql`regexp_replace(coalesce(${members.discordId}, ''), '[^0-9]', '', 'g') = ${normalized}`
    )
    .orderBy(members.id)
    .limit(1);
  return row;
}

/**
 * Боец по Discord username / глобальному имени.
 *
 * Зачем: у части состава в division_members.discord_id пусто (ручная правка,
 * синхронизация без Discord), но ник Discord уже записан в карточке — в
 * позывном, ФИО или в application_data (поле contact). Требование входа:
 * сначала искать по ID, затем по нику, и при совпадении СРАЗУ сохранить
 * полученный snowflake в members.discord_id, чтобы следующий вход шёл по ID.
 *
 * Сравнение идёт по нормализованному ключу (normalizePersonName в recruits.ts):
 * регистр, «ё», неразрывные пробелы и латинские двойники не влияют.
 */
async function findMemberByDiscordHandle(profile: DiscordProfile) {
  const candidates = [profile.username, profile.globalName]
    .map((value) => normalizePersonName(value ?? ""))
    .filter(Boolean);
  if (!candidates.length) return undefined;

  const roster = await db
    .select({
      id: members.id,
      callsign: members.callsign,
      name: members.name,
      handle: members.handle,
      discordId: members.discordId,
      applicationData: members.applicationData,
    })
    .from(members)
    .orderBy(members.id);

  const matches = roster.filter((row) => {
    const app = (row.applicationData ?? {}) as Record<string, unknown>;
    const contact = typeof app.discordTag === "string" ? app.discordTag : "";
    const values = [row.callsign, row.name, row.handle, contact]
      .filter((value): value is string => typeof value === "string" && value.trim() !== "")
      .map((value) => normalizePersonName(value));
    return values.some((value) => candidates.includes(value));
  });

  // Неоднозначность трактуем как «не найдено»: показать чужое личное дело
  // хуже, чем попросить штаб привязать Discord вручную.
  if (matches.length !== 1) return undefined;
  return matches[0];
}

/**
 * Заявка на вступление со статусом pending по Discord ID.
 *
 * Экран «Ваш рапорт находится на рассмотрении штаба» показывается ТОЛЬКО по
 * ней: если человек не найден в members и у него нет актуальной заявки —
 * это не «рассмотрение», а «Discord не привязан» (разные действия).
 */
async function findPendingApplication(discordId: string) {
  const [row] = await db
    .select({ id: recruitApplications.id, status: recruitApplications.status })
    .from(recruitApplications)
    .where(
      and(
        sql`regexp_replace(coalesce(${recruitApplications.discordId}, ''), '[^0-9]', '', 'g') = ${String(discordId).trim()}`,
        // 'new' — legacy-статус старых заявок: колонка типизирована ReviewStatus,
        // и inArray по литералу "new" не проходит проверку типов
        sql`${recruitApplications.status} IN ('pending', 'new')`
      )
    )
    .orderBy(recruitApplications.id)
    .limit(1);
  return row;
}

/**
 * Закрывает «висящую» заявку бойца, который уже есть в составе.
 *
 * Баг, который это лечит: человек зачислен в division_members (статус «В строю»,
 * Discord привязан), но в recruit_applications осталась его старая заявка со
 * статусом pending. Модерация видит её в очереди, а вход — если бы порядок
 * проверок был обратный — показывал бы экран ожидания.
 *
 * Решение принимает не эта функция (оно уже состоялось при зачислении), здесь
 * лишь фиксируется факт: заявка переводится в approved с пометкой
 * reviewed_by = "автоматически" — иначе в журнале решений потерялся бы автор.
 */
async function closeStaleApplications(memberId: number): Promise<number> {
  try {
    const updated = await db
      .update(recruitApplications)
      .set({
        status: "approved",
        reviewedBy: "автоматически (боец уже в составе)",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(recruitApplications.memberId, memberId),
          sql`${recruitApplications.status} IN ('pending', 'new')`
        )
      )
      .returning({ id: recruitApplications.id });
    return updated.length;
  } catch (e) {
    // Сбой не должен прерывать вход: заявка — историческая запись
    console.error("[discord-callback] Не удалось закрыть устаревшую заявку:", e);
    return 0;
  }
}

/**
 * Роль в токене сессии бойца.
 *
 * Командир подразделения может не иметь роли штаба в колонке role — права ему
 * дают должность или звание (resolvePanelRights, то же правило, что /api/me).
 * Токен получает effective-роль, иначе middleware не пустил бы его в разделы
 * штаба, хотя интерфейс уже показывает флаги командира.
 */
function memberSessionRole(member: {
  role: MemberRole;
  post: string | null;
  rank: string;
}): MemberRole {
  const rights = resolvePanelRights({
    memberRole: member.role,
    memberPost: member.post,
    memberRank: member.rank,
  });
  return rights.isAdmin ? "admin" : rights.isCommander ? "officer" : member.role;
}

export async function GET(req: NextRequest) {
  const state = req.nextUrl.searchParams.get("state");
  const code = req.nextUrl.searchParams.get("code");
  const stateCheck = await verifyOAuthState(
    state,
    req.cookies.get(MEMBER_OAUTH_STATE_COOKIE)?.value
  );

  if (!stateCheck.ok) {
    return redirectTo(req, `/login?error=${encodeURIComponent("oauth_state")}`);
  }
  if (!code) {
    // Пользователь нажал «Отмена» в окне согласия Discord
    return redirectTo(req, `/login?error=${encodeURIComponent("oauth_cancelled")}`);
  }

  const exchanged = await exchangeDiscordCode(code, discordRedirectUri(req));
  if (!exchanged.ok) {
    console.error("[discord-callback] Обмен кода не удался:", exchanged.error);
    return redirectTo(req, `/login?error=${encodeURIComponent("oauth_failed")}`);
  }

  // Discord отдаёт ID строкой: очищаем от пробелов и приводим к цифрам до
  // любых запросов к БД — по этому значению ищется боец в division_members.
  const discordId = normalizeDiscordSnowflake(exchanged.profile.id);
  if (!discordId) {
    console.error("[discord-callback] Discord вернул некорректный ID профиля");
    return redirectTo(req, `/login?error=${encodeURIComponent("oauth_failed")}`);
  }
  const profile: DiscordProfile = { ...exchanged.profile, id: discordId };

  return stateCheck.intent === "link"
    ? handleLink(req, profile)
    : handleLogin(req, profile);
}

/**
 * Сессия панели по Discord ID.
 *
 * Выдаётся только роли штаба (admin/officer): вход через Discord не должен
 * повышать права — иначе боец с произвольной ролью в учётной записи получил бы
 * доступ к панели. null означает «аккаунта панели нет либо его роль прав не
 * даёт»; обе ветки дальше обрабатываются как обычный вход бойца.
 */
async function issuePanelSessionForDiscord(
  profile: DiscordProfile
): Promise<{ account: PanelAccount; token: string } | null> {
  const account = await findPanelUserByDiscordId(profile.id);
  if (!account || !isPanelStaffRole(account.role)) return null;

  const token = await issuePanelToken(account);
  await logPanelLogin(account.username, "вход в панель через Discord", {
    "Способ": "Discord OAuth2",
    "Учётная запись": account.username,
    "Роль": account.role,
  });
  return { account, token };
}
/**
 * Привязка Discord к текущему аккаунту бойца.
 *
 * Id берётся из httpOnly-cookie, а не из параметров запроса: иначе Discord
 * можно было бы привязать к чужому аккаунту, подставив его id в URL.
 */
async function handleLink(req: NextRequest, profile: DiscordProfile): Promise<NextResponse> {
  const memberId = Number.parseInt(req.cookies.get(MEMBER_OAUTH_LINK_COOKIE)?.value || "", 10);
  const finish = (params: string): NextResponse => {
    const response = redirectTo(req, `/profile?${params}`);
    response.cookies.delete(MEMBER_OAUTH_LINK_COOKIE);
    response.cookies.delete(MEMBER_OAUTH_STATE_COOKIE);
    return response;
  };

  if (!Number.isFinite(memberId)) return finish("error=oauth_session");

  // discord_id уникален: тот же Discord не должен уехать второму аккаунту
  const taken = await findMemberByDiscordId(profile.id);
  if (taken && taken.id !== memberId) return finish("error=discord_taken");

  const [updated] = await db
    .update(members)
    .set({
      discordId: profile.id,
      avatarUrl: profile.avatarUrl,
      // Инкремент версии отзывает прежние сессии (в т.ч. выданные по паролю)
      memberTokenVersion: sql`${members.memberTokenVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(members.id, memberId))
    .returning({
      id: members.id,
      callsign: members.callsign,
      role: members.role,
      post: members.post,
      rank: members.rank,
      memberTokenVersion: members.memberTokenVersion,
    });

  if (!updated) return finish("error=oauth_session");

  const session = await issueMemberSession(
    {
      id: updated.id,
      callsign: updated.callsign || "",
      role: memberSessionRole(updated),
      memberTokenVersion: updated.memberTokenVersion,
    },
    "discord",
    { ip: requestIp(req) }
  );

  const response = setMemberCookie(finish("linked=1"), session, req);

  // Привязанный Discord мог оказаться учётной записью штаба панели: тогда
  // человек получает и административную сессию. Кабинет при этом остаётся
  // рабочим — обе cookie по схеме гибридной авторизации сосуществуют.
  const panel = await issuePanelSessionForDiscord(profile);
  if (panel) setPanelCookie(response, panel.token, req);

  return response;
}

/** Боец из division_members вместе с нормализованным статусом */
type ResolvedMember = NonNullable<Awaited<ReturnType<typeof findMemberByDiscordId>>>;

/**
 * Поиск бойца по Discord: сначала по ID, затем по нику.
 *
 * Порядок жёсткий и важен: по ID связь подтверждена (её установил сам человек
 * или штаб), по нику — предположение, которое мы тут же закрепляем, записав
 * полученный снежинка-ID в карточку. Без этого следующий вход снова шёл бы
 * «по догадке», а при смене ника человек терял бы кабинет.
 */
async function resolveMemberForLogin(
  profile: DiscordProfile
): Promise<ResolvedMember | undefined> {
  const byId = await findMemberByDiscordId(profile.id);
  if (byId) return byId;

  const byHandle = await findMemberByDiscordHandle(profile);
  if (!byHandle) return undefined;

  // Найден по нику — закрепляем связь. Ошибку записи не считаем фатальной:
  // вход важнее, чем сохранение связки (при сбое БД он всё равно не состоится).
  try {
    const [updated] = await db
      .update(members)
      .set({ discordId: profile.id, updatedAt: new Date() })
      .where(eq(members.id, byHandle.id))
      .returning();

    if (updated) return updated;
  } catch (e) {
    console.error("[discord-callback] Не удалось сохранить Discord ID по нику:", e);
  }

  // Запись не удалась — работаем с тем, что прочитали, чтобы вход состоялся
  const [row] = await db.select().from(members).where(eq(members.id, byHandle.id)).limit(1);
  return row;
}

/**
 * Вход по Discord.
 *
 * Жёсткий порядок (требование ТЗ):
 *   1. division_members — если человек там есть, он боец, и никакая заявка
 *      из recruit_applications не имеет права показать ему «рапорт на
 *      рассмотрении». Ранее порядок был обратный по факту проверки статуса
 *      заявки, и действующий боец со статусом «В строю» получал экран ожидания;
 *   2. только если бойца нет — recruit_applications со статусом pending:
 *      это и есть единственный случай экрана «Ваш рапорт на рассмотрении»;
 *   3. иначе — «Discord не привязан» с явным действием для человека.
 *
 * Сессия панели (штаб) выдаётся независимо: администратор может не иметь
 * строки в табеле, и требовать от него рапорт абсурдно.
 */
async function handleLogin(req: NextRequest, profile: DiscordProfile): Promise<NextResponse> {
  const panel = await issuePanelSessionForDiscord(profile);
  const member = await resolveMemberForLogin(profile);
  const status = member ? normalizeMemberStatus(member.status) : null;
  const hasAccess = member ? hasProfileAccess(member.status) : false;

  /* --- 1. Боец есть в составе ---------------------------------------- */
  if (member) {
    if (hasAccess) {
      // Закрываем «висящую» заявку: она больше не должна триггерить экран
      // ожидания ни в панели, ни при следующем входе
      const closed = await closeStaleApplications(member.id);
      if (closed > 0) {
        console.info(
          `[discord-callback] Заявок переведено в approved по бойцу #${member.id}: ${closed}`
        );
      }

      // Аватар мог смениться в Discord — держим карточку бойца актуальной
      if (profile.avatarUrl && profile.avatarUrl !== member.avatarUrl) {
        await db
          .update(members)
          .set({ avatarUrl: profile.avatarUrl, updatedAt: new Date() })
          .where(eq(members.id, member.id));
      }

      const sessionRole = memberSessionRole(member);
      const session = await issueMemberSession(
        {
          id: member.id,
          callsign: member.callsign || "",
          role: sessionRole,
          memberTokenVersion: member.memberTokenVersion,
        },
        "discord",
        { ip: requestIp(req) }
      );

      // Командир подразделения по должности/званию сразу попадает в панель:
      // права сессии у него уже есть (resolvePanelRights), и кабинет для него —
      // не единственный раздел. Остальные бойцы — в личное дело.
      const isStaffSession =
        panel !== null || sessionRole === "admin" || sessionRole === "officer";
      const response = redirectTo(req, isStaffSession ? "/" : "/profile");
      response.cookies.delete(MEMBER_OAUTH_STATE_COOKIE);
      setMemberCookie(response, session, req);
      if (panel) setPanelCookie(response, panel.token, req);
      return response;
    }

    // Рапорт на рассмотрении / исключён — объясняем причину по нормализованному
    // статусу, а не по точному совпадению строки
    const code = status === "dismissed" ? "dismissed" : "pending";
    const response = redirectTo(req, `/login?error=${encodeURIComponent(code)}`);
    response.cookies.delete(MEMBER_OAUTH_STATE_COOKIE);
    if (panel) setPanelCookie(response, panel.token, req);
    return response;
  }

  /* --- 2. Бойца нет: может быть, он только подал рапорт -------------- */
  const pendingApplication = await findPendingApplication(profile.id);
  if (pendingApplication) {
    const response = redirectTo(req, `/login?error=${encodeURIComponent("pending")}`);
    response.cookies.delete(MEMBER_OAUTH_STATE_COOKIE);
    if (panel) setPanelCookie(response, panel.token, req);
    return response;
  }

  /* --- 3. Аккаунт панели без бойца ---------------------------------- */
  if (panel) {
    const response = redirectTo(req, "/");
    response.cookies.delete(MEMBER_OAUTH_STATE_COOKIE);
    setPanelCookie(response, panel.token, req);
    return response;
  }

  /* --- 4. Не найден нигде ------------------------------------------- */
  // Показываем это ЯВНО на странице входа: раньше здесь был молчаливый
  // редирект на /apply, и вход выглядел как «Discord не находит пользователя».
  // Контакт Discord сохраняем в cookie: если человек пойдёт подавать рапорт,
  // поля ID и аватара заполнятся сами.
  const response = redirectTo(
    req,
    `/login?error=${encodeURIComponent("discord_not_linked")}`
  );
  response.cookies.set({
    name: MEMBER_OAUTH_PENDING_COOKIE,
    value: packDiscordProfile(profile),
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: isSecureRequest(req),
    maxAge: PENDING_TTL_SECONDS,
  });
  response.cookies.delete(MEMBER_OAUTH_STATE_COOKIE);
  return response;
}