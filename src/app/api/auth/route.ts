import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users, logs } from "@/db/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { SignJWT } from "jose";
import { getJwtSecret } from "@/lib/auth";

const SECRET = getJwtSecret();
type RateRecord = { attempts: number; lockUntil: number; at: number };
const rateLimitMap = new Map<string, RateRecord>();
const MAX_ATTEMPTS = 5; 
const MAX_REMEMBERED_IPS = 5000;
const RATE_RECORD_TTL_MS = 24 * 60 * 60 * 1000;
const LOCK_TIME_MS = 15 * 60 * 1000; 

export async function POST(req: NextRequest) {
  try {
    const ip =
      (req.headers.get("x-real-ip") || "").trim() ||
      (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
      "unknown_ip";
    const now = Date.now();

    // Удерживаем in-memory карту от бесконечного роста
    if (rateLimitMap.size > MAX_REMEMBERED_IPS) {
      for (const [key, rec] of rateLimitMap) {
        if (now - rec.at > RATE_RECORD_TTL_MS) rateLimitMap.delete(key);
      }
      let overflow = rateLimitMap.size - MAX_REMEMBERED_IPS;
      if (overflow > 0) {
        for (const [key, rec] of rateLimitMap) {
          if (overflow <= 0) break;
          if (rec.lockUntil <= now) {
            rateLimitMap.delete(key);
            overflow--;
          }
        }
      }
    }

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
      rateLimitMap.set(ip, { attempts, lockUntil, at: now });
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
