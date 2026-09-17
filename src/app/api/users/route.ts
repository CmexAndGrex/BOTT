import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireRole } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // Список аккаунтов — только администратор
  const auth = await requireRole(req, ["admin"]);
  if (!auth.ok) return auth.response;

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
