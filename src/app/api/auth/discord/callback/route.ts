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
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { members } from "@/db/schema";
import {
  findPanelUserByDiscordId,
  isSecureRequest,
  issuePanelToken,
  logPanelLogin,
  setPanelCookie,
  type PanelAccount,
} from "@/lib/api-auth";
import { isPanelStaffRole, browserOrigin, normalizeDiscordSnowflake } from "@/lib/validation";
import { hasProfileAccess, type MemberRole } from "@/lib/recruits";
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
 * shortcut: сравнение по regexp_replace не использует индекс discord_id;
 * при росте состава перейти на нормализованную колонку или выражение-индекс.
 */
async function findMemberByDiscordId(discordId: string) {
  const [row] = await db
    .select()
    .from(members)
    .where(
      sql`regexp_replace(coalesce(${members.discordId}, ''), '[^0-9]', '', 'g') = ${discordId}`
    )
    .orderBy(members.id)
    .limit(1);
  return row;
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

/**
 * Вход по Discord: сначала учётная запись панели, затем боец.
 *
 * Если боец найден и рапорт одобрен — выдаём сессию. Если нет — сохраняем
 * контакт Discord и отправляем подавать рапорт: поле Discord ID в форме
 * заполнится само, а модератор увидит, кто именно подал рапорт.
 */
async function handleLogin(req: NextRequest, profile: DiscordProfile): Promise<NextResponse> {
  // Администратор или командир панели: Discord уже привязан к учётной записи —
  // выдаём сессию панели без локального логина и пароля.
  const panel = await issuePanelSessionForDiscord(profile);
  const member = await findMemberByDiscordId(profile.id);

  if (panel) {
    // Панч прямо в панель: там модерация, /users и быстрые действия.
    const response = redirectTo(req, "/");
    response.cookies.delete(MEMBER_OAUTH_STATE_COOKIE);
    setPanelCookie(response, panel.token, req);

    // Боец в строю — дополнительно открываем кабинет: переключаться между
    // панелью и кабинетом не нужно, обе сессии живут одновременно.
    if (member && hasProfileAccess(member.status)) {
      const memberSession = await issueMemberSession(
        {
          id: member.id,
          callsign: member.callsign || "",
          role: memberSessionRole(member),
          memberTokenVersion: member.memberTokenVersion,
        },
        "discord",
        { ip: requestIp(req) }
      );
      setMemberCookie(response, memberSession, req);
    }
    return response;
  }

  if (member) {
    // Рапорт на рассмотрении или отклонён — вход закрыт, но объясняем причину
    if (!hasProfileAccess(member.status)) {
      const code = member.status === "pending" ? "pending" : "dismissed";
      return redirectTo(req, `/login?error=${encodeURIComponent(code)}`);
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
    const isStaffSession = sessionRole === "admin" || sessionRole === "officer";
    const response = redirectTo(req, isStaffSession ? "/" : "/profile");
    response.cookies.delete(MEMBER_OAUTH_STATE_COOKIE);
    return setMemberCookie(response, session, req);
  }

  // Ни аккаунта панели, ни бойца с таким Discord: показываем это ЯВНО на
  // странице входа. Раньше здесь был молчаливый редирект на /apply, и вход
  // выглядел как «Discord не находит пользователя»: человек не понимал, что
  // его Discord не привязан к бойцу в ШДС, и что делать дальше.
  //
  // Контакт Discord всё равно сохраняем в cookie: если человек пойдёт подавать
  // рапорт, поля ID и аватара заполнятся сами — то есть прежняя возможность
  // подать заявку сохраняется, но теперь о причине сообщено.
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