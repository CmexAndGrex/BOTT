/**
 * Смена пароля и обновление своих данных бойцом (личный кабинет).
 *
 * Смена пароля требует текущий пароль: иначе утёкшая cookie позволяла бы
 * перехватить аккаунт. После смены увеличивается memberTokenVersion — все
 * ранее выданные сессии (в том числе на других устройствах) отзываются, а
 * текущий браузер получает новую cookie, чтобы бойца не выбросило из системы.
 */
import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { logs, members } from "@/db/schema";
import { checkPasswordPolicy } from "@/lib/password-policy";
import { issueMemberSession, requestIp, requireActiveMember, setMemberCookie } from "@/lib/member-auth";
import { validateApplication } from "@/lib/recruits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  currentPassword?: unknown;
  newPassword?: unknown;
  age?: unknown;
  armaExperience?: unknown;
  specialization?: unknown;
  comment?: unknown;
};

/** PATCH — смена пароля */
export async function PATCH(req: NextRequest) {
  const auth = await requireActiveMember(req);
  if (!auth.ok) return auth.response;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "Некорректный JSON" }, { status: 400 });
  }

  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  if (!currentPassword) {
    return NextResponse.json({ ok: false, error: "Укажите текущий пароль" }, { status: 400 });
  }

  const policy = checkPasswordPolicy(body.newPassword);
  if (!policy.ok) return NextResponse.json({ ok: false, error: policy.error }, { status: 400 });

  try {
    const [member] = await db.select().from(members).where(eq(members.id, auth.member.id));
    if (!member) return NextResponse.json({ ok: false, error: "Боец не найден" }, { status: 404 });

    // Если пароля не было (вход только по Discord), текущий не требуется:
    // владение аккаунтом уже подтверждено действующей сессией
    if (member.passwordHash) {
      const valid = await bcrypt.compare(currentPassword, member.passwordHash);
      if (!valid) {
        return NextResponse.json({ ok: false, error: "Текущий пароль указан неверно" }, { status: 403 });
      }
    }
    if (member.passwordHash && currentPassword === body.newPassword) {
      return NextResponse.json({ ok: false, error: "Новый пароль совпадает с текущим" }, { status: 400 });
    }

    const passwordHash = await bcrypt.hash(String(body.newPassword), 10);
    const [updated] = await db
      .update(members)
      .set({
        passwordHash,
        memberTokenVersion: sql`${members.memberTokenVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(members.id, member.id))
      .returning({
        id: members.id,
        callsign: members.callsign,
        role: members.role,
        memberTokenVersion: members.memberTokenVersion,
      });

    if (!updated) return NextResponse.json({ ok: false, error: "Боец не найден" }, { status: 404 });

    await db.insert(logs).values({
      category: "auth",
      author: updated.callsign || `#${updated.id}`,
      action: "сменил пароль в личном кабинете",
      details: { "Боец": updated.callsign || "", "IP": requestIp(req) },
      kind: "auth",
      title: "Смена пароля",
      detail: "Пароль изменён, остальные сессии отозваны",
      ok: true,
    });

    // Перевыпускаем cookie текущему браузеру: старая версия токена уже невалидна
    const session = await issueMemberSession(
      {
        id: updated.id,
        callsign: updated.callsign || "",
        role: updated.role,
        memberTokenVersion: updated.memberTokenVersion,
      },
      "password",
      { ip: requestIp(req) }
    );
    const response = NextResponse.json({ ok: true, message: "Пароль изменён" });
    return setMemberCookie(response, session, req);
  } catch (e) {
    console.error("[profile] Не удалось сменить пароль:", e);
    return NextResponse.json({ ok: false, error: "Ошибка сервера" }, { status: 500 });
  }
}

/** PUT — уточнение своей анкеты (возраст, опыт, специализация, комментарий) */
export async function PUT(req: NextRequest) {
  const auth = await requireActiveMember(req);
  if (!auth.ok) return auth.response;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "Некорректный JSON" }, { status: 400 });
  }

  const application = validateApplication({
    age: body.age,
    armaExperience: body.armaExperience,
    specialization: body.specialization,
    comment: body.comment,
  });
  if (!application.ok) {
    return NextResponse.json({ ok: false, error: application.error }, { status: 400 });
  }

  try {
    const [updated] = await db
      .update(members)
      .set({ applicationData: application.data, updatedAt: new Date() })
      .where(eq(members.id, auth.member.id))
      .returning({ callsign: members.callsign });

    if (!updated) return NextResponse.json({ ok: false, error: "Боец не найден" }, { status: 404 });

    await db.insert(logs).values({
      category: "edit",
      author: updated.callsign || `#${auth.member.id}`,
      action: "уточнил данные анкеты",
      details: {
        "Специализация": application.data.specialization,
        "Возраст": String(application.data.age),
      },
      kind: "system",
      title: "Анкета обновлена",
      detail: `${updated.callsign} обновил данные анкеты`,
      ok: true,
    });

    return NextResponse.json({ ok: true, application: application.data });
  } catch (e) {
    console.error("[profile] Не удалось обновить анкету:", e);
    return NextResponse.json({ ok: false, error: "Ошибка сервера" }, { status: 500 });
  }
}