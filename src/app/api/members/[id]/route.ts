import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { members, logs, users } from "@/db/schema";
import { jwtVerify } from "jose";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SECRET = new TextEncoder().encode(process.env.JWT_SECRET || "temp-secret-key");

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  const token = req.cookies.get("auth_token")?.value;
  if (!token) return NextResponse.json({ ok: false, error: "Нет доступа" }, { status: 401 });

  try { await jwtVerify(token, SECRET); } 
  catch (err) { return NextResponse.json({ ok: false, error: "Сессия устарела" }, { status: 403 }); }

  const { id } = await params;
  const memberId = parseInt(id, 10);
  if (!Number.isFinite(memberId)) return NextResponse.json({ ok: false, error: "Некорректный ID" }, { status: 400 });

  let body: { vacation?: boolean; discordId?: string | null };
  try { body = await req.json(); } 
  catch { return NextResponse.json({ ok: false, error: "Некорректный JSON" }, { status: 400 }); }

  const [oldMember] = await db.select().from(members).where(eq(members.id, memberId));
  if (!oldMember) return NextResponse.json({ ok: false, error: "Боец не найден" }, { status: 404 });

  const set: Record<string, unknown> = { updatedAt: new Date() };
  const changesDescription: string[] = [];
  const detailsObj: Record<string, string> = { "Боец": oldMember.name };

  if (typeof body.vacation === "boolean" && body.vacation !== oldMember.vacation) {
    set.vacation = body.vacation;
    changesDescription.push(`статус отпуска на "${body.vacation ? "В отпуске" : "Нет"}"`);
    detailsObj["Отпуск"] = body.vacation ? "В отпуске" : "Нет";
  }

  if (body.discordId !== undefined) {
    const v = body.discordId;
    const cleanedDiscord = v === null || String(v).trim() === "" ? null : String(v).replace(/[^\d]/g, "");
    if (cleanedDiscord !== oldMember.discordId) {
      set.discordId = cleanedDiscord;
      changesDescription.push(`Discord ID на "${cleanedDiscord || "пусто"}"`);
      detailsObj["Discord ID"] = cleanedDiscord || "не указан";
    }
  }

  const rows = await db.update(members).set(set).where(eq(members.id, memberId)).returning();
  if (!rows.length) return NextResponse.json({ ok: false, error: "Боец не найден" }, { status: 404 });

  if (changesDescription.length > 0) {
    let authorFormatted = "Командир";
    try {
      const verified = await jwtVerify(token, SECRET);
      const payload = verified.payload as any;
      const username = payload.username || payload.sub || payload.name;
      if (username) {
        const [dbUser] = await db.select().from(users).where(eq(users.username, username));
        if (dbUser) authorFormatted = `${dbUser.role === "admin" ? "Администратор" : "Командир"} ${dbUser.username}`;
        else authorFormatted = `${payload.role === "admin" ? "Администратор" : "Командир"} ${username}`;
      }
    } catch { }

    await db.insert(logs).values({
      category: "edit",
      author: authorFormatted,
      action: `изменил ${changesDescription.join(" и ")} бойцу ${oldMember.name}`,
      details: detailsObj,
      kind: "system",
      title: "Редактирование бойца",
      detail: `Изменен боец ${oldMember.name}`,
      ok: true,
    });
  }

  return NextResponse.json({ ok: true, member: rows[0] });
}