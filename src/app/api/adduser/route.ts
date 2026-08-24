import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { jwtVerify } from "jose";
import bcrypt from "bcryptjs";

const SECRET = new TextEncoder().encode(process.env.POSTGRES_PASSWORD || "super-secret");

export async function GET(req: NextRequest) {
  const token = req.cookies.get('auth_token')?.value;
  if (!token) {
    return NextResponse.json({ error: "Нет доступа" }, { status: 401 });
  }

  try {
    const verified = await jwtVerify(token, SECRET);
    if ((verified.payload as any).role !== 'admin') {
      return NextResponse.json({ error: "Только для админов" }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "Ошибка токена" }, { status: 401 });
  }

  const username = req.nextUrl.searchParams.get("login");
  const password = req.nextUrl.searchParams.get("pass");

  if (!username || !password) {
    return NextResponse.json({ error: "Укажите логин и пароль, например: ?login=officer1&pass=123" }, { status: 400 });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    await db.insert(users).values({ username, passwordHash: hash, role: "officer" });
    return NextResponse.json({ ok: true, message: `Успех! Аккаунт '${username}' для офицера создан.` });
  } catch (e) {
    return NextResponse.json({ error: "Такой логин уже занят или произошла ошибка БД!" }, { status: 400 });
  }
}