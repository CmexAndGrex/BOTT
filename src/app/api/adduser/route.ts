import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq, count } from "drizzle-orm";
import { hash } from "bcryptjs";
import { jwtVerify } from "jose";

const SECRET = new TextEncoder().encode(process.env.POSTGRES_PASSWORD || "super-secret");

export async function GET(req: NextRequest) {
  const login = req.nextUrl.searchParams.get("login");
  const pass = req.nextUrl.searchParams.get("pass");
  const role = req.nextUrl.searchParams.get("role") || "officer";

  if (!login || !pass) {
    return NextResponse.json({ error: "Укажите ?login=ИМЯ&pass=ПАРОЛЬ" }, { status: 400 });
  }

  try {
    // Проверяем, есть ли вообще пользователи в базе
    const [{ value: totalUsers }] = await db.select({ value: count() }).from(users);

    // Если пользователи уже есть, требуем права админа через куку
    if (totalUsers > 0) {
      const token = req.cookies.get('auth_token')?.value;
      if (!token) return NextResponse.json({ error: "Нет доступа. Сначала войдите как администратор." }, { status: 401 });
      
      const verified = await jwtVerify(token, SECRET);
      if ((verified.payload as any).role !== 'admin') {
        return NextResponse.json({ error: "Только администраторы могут создавать аккаунты" }, { status: 403 });
      }
    }

    // Проверяем, существует ли уже такой юзер
    const existing = await db.select().from(users).where(eq(users.username, login));
    const passwordHash = await hash(pass, 10);

    if (existing.length > 0) {
      // Обновляем пароль и роль, если пользователь уже есть
      await db.update(users).set({ passwordHash, role }).where(eq(users.username, login));
      return NextResponse.json({ ok: true, message: `Пароль и роль для '${login}' успешно обновлены!` });
    }

    // Создаем нового
    await db.insert(users).values({ username: login, passwordHash, role });
    return NextResponse.json({ ok: true, message: `Успех! Аккаунт '${login}' с ролью '${role}' создан.` });

  } catch (e) {
    return NextResponse.json({ error: "Ошибка сервера при создании пользователя" }, { status: 500 });
  }
}