import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import bcrypt from "bcryptjs";
import { jwtVerify } from "jose";

const SECRET = new TextEncoder().encode(process.env.JWT_SECRET || "temp-secret-key");

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
    
    return NextResponse.json({ ok: true, message: `Аккаунт '${username}' успешно создан.` });
  } catch (err) {
    return NextResponse.json({ error: "Ошибка сервера (возможно логин уже занят)" }, { status: 500 });
  }
}