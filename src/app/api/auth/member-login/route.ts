/**
 * Резервный вход бойца: позывной (логин) + пароль.
 *
 * Отличие от /api/auth (вход администратора в панель): проверяется таблица
 * бойцов, сессия кладётся в отдельную cookie (member_token) и доступен вход
 * только бойцам, чей рапорт одобрен. Неудачные попытки фиксируются в общем
 * журнале, чтобы разбирать инциденты, а не только видеть успешные входы.
 */
import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { logs, members } from "@/db/schema";
import { issueMemberSession, requestIp, setMemberCookie } from "@/lib/member-auth";
import {
  LoginThrottle,
  normalizeCallsign,
  PENDING_NOTICE,
  DISMISSED_NOTICE,
  hasProfileAccess,
} from "@/lib/recruits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Лимит попыток входа. Ключ — IP + позывной: перебор по одному аккаунту не
 * блокирует остальных бойцов с того же адреса (в панели обратная ситуация —
 * там лимит по IP, поэтому здесь он уточнён).
 */
const throttle = new LoginThrottle();

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
      { ok: false, error: "Укажите позывной и пароль" },
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
    const [member] = await db.select().from(members).where(eq(members.callsign, callsign));

    // Пароль сверяем и для несуществующего бойца (сравнение с заведомо ложным
    // хешем): иначе по скорости ответа можно определить, какие позывные есть.
    const passwordHash = member?.passwordHash || "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv";
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
            detail: `Неудачный вход по позывному: ${callsign}`,
            ok: false,
            error: "Неверный позывной или пароль",
          });
        } catch {
          // Журнал не должен мешать ответу клиенту
        }
      }
      return NextResponse.json({ ok: false, error: "Неверный позывной или пароль" }, { status: 401 });
    }

    // Рапорт на рассмотрении / отклонён — вход не выдаём
    if (!hasProfileAccess(member.status)) {
      return NextResponse.json(
        {
          ok: false,
          error: member.status === "pending" ? PENDING_NOTICE : DISMISSED_NOTICE,
          status: member.status,
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
      status: member.status,
      hasDiscord: !!member.discordId && member.discordId !== "manual",
    });
    return setMemberCookie(response, session, req);
  } catch (e) {
    console.error("[member-login] Ошибка входа:", e);
    return NextResponse.json({ ok: false, error: "Ошибка сервера" }, { status: 500 });
  }
}