import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users, logs } from "@/db/schema";
import bcrypt from "bcryptjs";
import { requireRole } from "@/lib/api-auth";
import { checkPasswordPolicy } from "@/lib/password-policy";

export async function POST(req: NextRequest) {
  // Создание аккаунтов — только администратор
  const auth = await requireRole(req, ["admin"]);
  if (!auth.ok) return auth.response;

  try {
    const { username, password, role } = await req.json();
    if (!username || !password) return NextResponse.json({ error: "Укажите логин и пароль" }, { status: 400 });

    // Политика паролей проверяется на сервере (в форме — только подсказка)
    const policy = checkPasswordPolicy(password);
    if (!policy.ok) return NextResponse.json({ error: policy.error }, { status: 400 });

    const login = String(username).trim();
    if (!/^[\w.\-]{3,32}$/.test(login)) {
      return NextResponse.json(
        { error: "Логин: 3–32 символа, буквы/цифры/точка/дефис/подчёркивание" },
        { status: 400 }
      );
    }

    // Роль ограничиваем известными значениями: иначе можно создать
    // аккаунт с произвольной ролью, которая не обрабатывается панелью.
    const safeRole = role === "admin" ? "admin" : "officer";

    const passwordHash = await bcrypt.hash(password, 10);

    await db.insert(users).values({
      username: login,
      passwordHash,
      role: safeRole,
    });

    let authorFormatted = "Администратор";
    if (auth.user.username) authorFormatted = `Администратор ${auth.user.username}`;
    await db.insert(logs).values({
      category: "edit",
      author: authorFormatted,
      action: `создал аккаунт ${login}`,
      details: { "Логин": login, "Роль": safeRole },
      kind: "system",
      title: "Создание аккаунта",
      detail: `Создан аккаунт ${login}`,
      ok: true,
    });

    return NextResponse.json({ ok: true, message: `Аккаунт '${login}' успешно создан.` });
  } catch (err) {
    return NextResponse.json({ error: "Ошибка сервера (возможно логин уже занят)" }, { status: 500 });
  }
}
