/**
 * Отвязка Discord от аккаунта бойца.
 *
 * Нужна для случая «привязал не тот аккаунт». Чтобы не запереть бойца без
 * способа входа, отвязка разрешена только когда у него есть пароль: иначе он
 * потерял бы доступ к кабинету полностью. После отвязки версия токена растёт —
 * сессии, выданные через Discord, отзываются.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { logs, members } from "@/db/schema";
import { requireMember } from "@/lib/member-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(req: NextRequest) {
  const auth = await requireMember(req);
  if (!auth.ok) return auth.response;

  try {
    const [member] = await db.select().from(members).where(eq(members.id, auth.member.id));
    if (!member) return NextResponse.json({ ok: false, error: "Боец не найден" }, { status: 404 });

    if (!member.discordId) {
      return NextResponse.json({ ok: false, error: "Discord и так не привязан" }, { status: 400 });
    }
    if (!member.passwordHash) {
      return NextResponse.json(
        {
          ok: false,
          error: "Сначала задайте пароль — иначе потеряете доступ к личному кабинету",
        },
        { status: 409 }
      );
    }

    await db
      .update(members)
      .set({
        discordId: null,
        memberTokenVersion: sql`${members.memberTokenVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(members.id, member.id));

    await db.insert(logs).values({
      category: "auth",
      author: member.callsign || `#${member.id}`,
      action: "отвязал Discord от аккаунта",
      details: { "Боец": member.callsign || "", "Discord ID": member.discordId },
      kind: "auth",
      title: "Отвязка Discord",
      detail: `${member.callsign} отвязал Discord`,
      ok: true,
    });

    return NextResponse.json({ ok: true, message: "Discord отвязан" });
  } catch (e) {
    console.error("[profile] Не удалось отвязать Discord:", e);
    return NextResponse.json({ ok: false, error: "Ошибка сервера" }, { status: 500 });
  }
}