import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { jwtVerify } from "jose";

const SECRET = new TextEncoder().encode(process.env.JWT_SECRET || "temp-secret-key");

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = req.cookies.get("auth_token")?.value;
  if (!token) return NextResponse.json({ error: "Нет доступа" }, { status: 401 });

  try {
    const { payload } = await jwtVerify(token, SECRET);
    if ((payload as any).role !== "admin") {
      return NextResponse.json({ error: "Только для админов" }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "Сессия устарела" }, { status: 403 });
  }

  try {
    // Получаем список, строго ИСКЛЮЧАЯ пароли
    const allUsers = await db.select({ 
      id: users.id, 
      username: users.username, 
      role: users.role 
    }).from(users);
    
    return NextResponse.json({ users: allUsers });
  } catch {
    return NextResponse.json({ error: "Ошибка БД" }, { status: 500 });
  }
}