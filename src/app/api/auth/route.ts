import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users, logs } from "@/db/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { SignJWT } from "jose";

const SECRET = new TextEncoder().encode(process.env.JWT_SECRET || "temp-secret-key");
const rateLimitMap = new Map<string, { attempts: number; lockUntil: number }>();
const MAX_ATTEMPTS = 5; 
const LOCK_TIME_MS = 15 * 60 * 1000; 

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(',')[0].trim() || "unknown_ip";
    const now = Date.now();
    const record = rateLimitMap.get(ip);

    if (record && record.lockUntil > now) {
      const remainingMinutes = Math.ceil((record.lockUntil - now) / 60000);
      return NextResponse.json({ error: `Блокировка на ${remainingMinutes} мин.` }, { status: 429 });
    }

    const body = await req.json();
    const { username, password } = body;

    if (!username || !password) return NextResponse.json({ error: "Укажите логин и пароль" }, { status: 400 });

    const [user] = await db.select().from(users).where(eq(users.username, username));
    const isValid = user ? await bcrypt.compare(password, user.passwordHash) : false;

    if (!user || !isValid) {
      const attempts = (record?.attempts || 0) + 1;
      const lockUntil = attempts >= MAX_ATTEMPTS ? now + LOCK_TIME_MS : 0;
      rateLimitMap.set(ip, { attempts, lockUntil });
      return NextResponse.json({ error: "Неверный логин или пароль" }, { status: 401 });
    }

    rateLimitMap.delete(ip);

    const token = await new SignJWT({ userId: user.id, username: user.username, role: user.role })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("7d")
      .sign(SECRET);

    await db.insert(logs).values({
      category: "login", author: user.username, action: "вход в панель", details: { ip },
      kind: "auth", title: "Авторизация", detail: `Успешный вход: ${user.username}`, ok: true,
    });

    const response = NextResponse.json({ ok: true, role: user.role });
    
    response.cookies.set({
      name: "auth_token",
      value: token,
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      // Принудительно отключаем флаг secure, если вы сидите через localhost
      secure: process.env.NODE_ENV === "production" && !req.url.includes("localhost"), 
      maxAge: 60 * 60 * 24 * 7, 
    });

    return response;
  } catch (e) {
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}