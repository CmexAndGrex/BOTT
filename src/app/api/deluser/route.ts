import { NextRequest, NextResponse as Res } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { jwtVerify } from "jose";

const SECRET = new TextEncoder().encode(process.env.POSTGRES_PASSWORD || "super-secret");

export async function GET(req: NextRequest) {
  const token = req.cookies.get('auth_token')?.value;
  const login = req.nextUrl.searchParams.get("login");

  if (!token) return Res.json({ error: "Нет доступа" }, { status: 401 });
  if (!login) return Res.json({ error: "Укажите логин: ?login=ИМЯ" }, { status: 400 });

  try {
    const { payload } = await jwtVerify(token, SECRET);
    if (payload.role !== 'admin') return Res.json({ error: "Только для админов" }, { status: 403 });

    await db.delete(users).where(eq(users.username, login));
    return Res.json({ ok: true, message: `Аккаунт '${login}' навсегда удален.` });
  } catch {
    return Res.json({ error: "Ошибка сервера или неверный токен" }, { status: 500 });
  }
}