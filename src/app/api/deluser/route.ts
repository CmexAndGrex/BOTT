import { NextRequest, NextResponse as Res } from "next/server";
import { db } from "@/db";
import { users, logs } from "@/db/schema";
import { eq } from "drizzle-orm";
import { jwtVerify } from "jose";
import { getJwtSecret } from "@/lib/auth";

const SECRET = getJwtSecret();

export async function DELETE(req: NextRequest) {
  const token = req.cookies.get('auth_token')?.value;
  const login = req.nextUrl.searchParams.get("login");

  if (!token) return Res.json({ error: "Нет доступа" }, { status: 401 });
  if (!login) return Res.json({ error: "Укажите логин: ?login=ИМЯ" }, { status: 400 });

  try {
    const { payload } = await jwtVerify(token, SECRET);
    if ((payload as any).role !== 'admin') return Res.json({ error: "Только для админов" }, { status: 403 });

    await db.delete(users).where(eq(users.username, login));

    let authorFormatted = "Администратор";
    try {
      const verified = await jwtVerify(token, SECRET);
      const payload = verified.payload as any;
      if (payload.username) {
        const [dbUser] = await db.select().from(users).where(eq(users.username, payload.username));
        authorFormatted = `${dbUser?.role === "admin" ? "Администратор" : "Командир"} ${payload.username}`;
      }
    } catch {}
    await db.insert(logs).values({
      category: "edit",
      author: authorFormatted,
      action: `удалил аккаунт ${login}`,
      details: { "Логин": login },
      kind: "system",
      title: "Удаление аккаунта",
      detail: `Аккаунт ${login} удалён`,
      ok: true,
    });

    return Res.json({ ok: true, message: `Аккаунт '${login}' навсегда удален.` });
  } catch {
    return Res.json({ error: "Ошибка сервера или неверный токен" }, { status: 500 });
  }
}
