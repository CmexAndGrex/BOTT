/**
 * Резервный вход бойца: позывной / ФИО + пароль.
 *
 * Отличие от /api/auth (вход администратора в панель): проверяется таблица
 * бойцов, сессия кладётся в отдельную cookie (member_token) и доступен вход
 * только бойцам, чей рапорт одобрен. Неудачные попытки фиксируются в общем
 * журнале, чтобы разбирать инциденты, а не только видеть успешные входы.
 *
 * Логином служит не только позывной: бойцы помнят себя по ФИО из табеля
 * («Вамилов И.В.»), а у части состава, заведённой синхронизацией rs-red.com,
 * позывного нет вовсе. Поэтому ищем по позывному, затем по ФИО — оба сравнения
 * идут по нормализованному ключу (регистр, «ё», неразрывные пробелы и точки в
 * инициалах не важны).
 */
import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { logs, members } from "@/db/schema";
import { issueMemberSession, requestIp, setMemberCookie } from "@/lib/member-auth";
import {
  DISMISSED_NOTICE,
  LoginThrottle,
  normalizeCallsign,
  normalizeMemberStatus,
  normalizePersonName,
  PENDING_NOTICE,
  hasProfileAccess,
  type MemberStatus,
} from "@/lib/recruits";
import { registerThrottle } from "@/lib/throttle-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Лимит попыток входа. Ключ — IP + позывной: перебор по одному аккаунту не
 * блокирует остальных бойцов с того же адреса (в панели обратная ситуация —
 * там лимит по IP, поэтому здесь он уточнён).
 */
const throttle = registerThrottle(new LoginThrottle());

/** Сообщение для бойца, у которого ещё нет пароля (вход только по Discord) */
export const NO_PASSWORD_NOTICE =
  "Пароль ещё не установлен. Войдите через Discord или задайте пароль через штаб";

/**
 * Боец по логину, введённому в форме.
 *
 * Логин не обязан быть позывным: боец может ввести ФИО из табеля («Вамилов
 * И.В.» или «Вамилов И. В.»). Сравнение идёт в два прохода — точное по
 * позывному (регистр не важен, как в остальных местах проекта) и по ключу
 * normalizePersonName для ФИО. Неоднозначность (двое с одинаковым ФИО) — это
 * «не найдено»: показать чужой кабинет хуже, чем попросить уточнить логин.
 */
async function findMemberByLogin(login: string) {
  const byCallsign = await db
    .select()
    .from(members)
    .where(eq(members.callsign, login))
    .limit(1);
  if (byCallsign[0]) return byCallsign[0];

  const key = normalizePersonName(login);
  if (!key) return undefined;

  const roster = await db
    .select({
      id: members.id,
      callsign: members.callsign,
      name: members.name,
      handle: members.handle,
    })
    .from(members);

  const matches = roster.filter((row) => {
    const values = [row.callsign, row.name, row.handle]
      .filter((value): value is string => typeof value === "string" && value.trim() !== "")
      .map((value) => normalizePersonName(value));
    return values.includes(key);
  });

  if (matches.length !== 1) return undefined;

  const [row] = await db.select().from(members).where(eq(members.id, matches[0].id)).limit(1);
  return row;
}

export async function POST(req: NextRequest) {
  const ip = requestIp(req);

  let body: { callsign?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Некорректный JSON" }, { status: 400 });
  }

  const callsign = normalizeCallsign(body.callsign);
  const password = typeof body.password === "string" ? body.password : "";

  if (!callsign || !password) {
    return NextResponse.json(
      { ok: false, error: "Укажите позывной (или ФИО) и пароль" },
      { status: 400 }
    );
  }

  const throttleKey = `${ip}:${callsign.toLowerCase()}`;
  const state = throttle.check(throttleKey);
  if (state.locked) {
    return NextResponse.json(
      { ok: false, error: `Слишком много попыток. Повторите через ${state.retryAfterMinutes} мин.` },
      { status: 429 }
    );
  }

  try {
    const member = await findMemberByLogin(callsign);

    /**
     * Боец найден, но пароля у него нет: это не «неверный пароль», а другое
     * состояние — человек заведён синхронизацией или Discord-входом, и пароль
     * ему ещё никто не выдавал. Раньше форма показывала «Неверный позывной или
     * пароль», и боец шёл сбрасывать несуществующий пароль.
     */
    if (member && !member.passwordHash) {
      return NextResponse.json(
        { ok: false, error: NO_PASSWORD_NOTICE, code: "no_password", status: member.status },
        { status: 403 }
      );
    }

    // Пароль сверяем и для несуществующего бойца (сравнение с заведомо ложным
    // хешем): иначе по скорости ответа можно определить, какие позывные есть.
    const passwordHash =
      member?.passwordHash || "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv";
    const valid = await bcrypt.compare(password, passwordHash);

    if (!member || !member.passwordHash || !valid) {
      // Счётчик неудач растёт только когда аккаунт существует: иначе вход
      // администратора панели через ту же форму (он попадает сюда первым)
      // «съедал» бы лимит IP и записи журнала по несуществующим позывным.
      const failure = member ? throttle.registerFailure(throttleKey) : { locked: false, retryAfterMinutes: 0 };
      if (member) {
        try {
          await db.insert(logs).values({
            category: "auth",
            author: callsign.slice(0, 100),
            action: "неудачный вход бойца (позывной)",
            details: {
              IP: ip,
              "Блокировка": failure.locked ? `выдана на ${failure.retryAfterMinutes} мин` : "нет",
            },
            kind: "auth",
            title: "Отказ в доступе",
            detail: `Неудачный вход по позывному/ФИО: ${callsign}`,
            ok: false,
            error: "Неверный позывной или пароль",
          });
        } catch {
          // Журнал не должен мешать ответу клиенту
        }
      }
      return NextResponse.json({ ok: false, error: "Неверный позывной или пароль" }, { status: 401 });
    }

    /**
     * Рапорт на рассмотрении / отклонён — вход не выдаём. Статус читается
     * через normalizeMemberStatus: «В строю», in_service и service — это одно и
     * то же состояние, и действующий боец не должен видеть экран ожидания.
     */
    const status: MemberStatus = normalizeMemberStatus(member.status);
    if (!hasProfileAccess(member.status)) {
      return NextResponse.json(
        {
          ok: false,
          error: status === "dismissed" ? DISMISSED_NOTICE : PENDING_NOTICE,
          status,
        },
        { status: 403 }
      );
    }

    throttle.reset(throttleKey);
    const session = await issueMemberSession(
      {
        id: member.id,
        callsign: member.callsign || "",
        role: member.role,
        memberTokenVersion: member.memberTokenVersion,
      },
      "password",
      { ip }
    );

    const response = NextResponse.json({
      ok: true,
      callsign: member.callsign,
      status,
      hasDiscord: !!member.discordId && member.discordId !== "manual",
    });
    return setMemberCookie(response, session, req);
  } catch (e) {
    console.error("[member-login] Ошибка входа:", e);
    return NextResponse.json({ ok: false, error: "Ошибка сервера" }, { status: 500 });
  }
}