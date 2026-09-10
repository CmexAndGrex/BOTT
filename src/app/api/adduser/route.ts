import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users, logs } from "@/db/schema";
import bcrypt from "bcryptjs";
import { jwtVerify } from "jose";
import { eq } from "drizzle-orm";
import { getJwtSecret } from "@/lib/auth";

const SECRET = getJwtSecret();

export async function POST(req: NextRequest) {
  const token = req.cookies.get('auth_token')?.value;
  if (!token) return NextResponse.json({ error: "Нет доступа: авторизуйтесь" }, { status: 401 });

  try {
    const { payload } = await jwtVerify(token, SECRET);
    if ((payload as any).role !== 'admin') {
      return NextResponse.json({ error: "Только для админов" }, { status: 403 });
    }
  } catch (err) {
    return NextResponse.json({ error: "Сессия устарела или недействительна" }, { status: 403 });
  }

  try {
    const { username, password, role } = await req.json();
    if (!username || !password) return NextResponse.json({ error: "Укажите логин и пароль" }, { status: 400 });

    const passwordHash = await bcrypt.hash(password, 10);
    
    await db.insert(users).values({ 
      username, 
      passwordHash, 
      role: role || 'officer' 
    });

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
      action: `создал аккаунт ${username}`,
      details: { "Логин": username, "Роль": role || "officer" },
      kind: "system",
      title: "Создание аккаунта",
      detail: `Создан аккаунт ${username}`,
      ok: true,
    });

    return NextResponse.json({ ok: true, message: `Аккаунт '${username}' успешно создан.` });
  } catch (err) {
    return NextResponse.json({ error: "Ошибка сервера (возможно логин уже занят)" }, { status: 500 });
  }
}
