import { NextRequest, NextResponse as Res } from "next/server";
import { db } from "@/db";
import { users, logs } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requireRole } from "@/lib/api-auth";

export async function DELETE(req: NextRequest) {
  const auth = await requireRole(req, ["admin"]);
  if (!auth.ok) return auth.response;

  const login = req.nextUrl.searchParams.get("login");
  if (!login) return Res.json({ error: "Укажите логин: ?login=ИМЯ" }, { status: 400 });

  try {
    // Защита от «выстрела в ногу»: последний администратор не удаляется,
    // иначе панель остаётся без управления аккаунтами навсегда.
    const admins = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.role, "admin"));

    const target = admins.find((a) => a.username === login);
    if (target && admins.length <= 1) {
      return Res.json(
        { error: "Нельзя удалить последнего администратора: сначала создайте другого" },
        { status: 409 }
      );
    }

    await db.delete(users).where(eq(users.username, login));

    let authorFormatted = "Администратор";
    if (auth.user.username) {
      authorFormatted = `Администратор ${auth.user.username}`;
    }
    await db.insert(logs).values({
      category: "edit",
      author: authorFormatted,
      action: `удалил аккаунт ${login}`,
      details: { "Логин": login },
      kind: "system",
      title: "Удаление аккаунта",
      detail: `Аккаунт ${login} удалён`,
      ok: true,
    });

    return Res.json({ ok: true, message: `Аккаунт '${login}' навсегда удален.` });
  } catch {
    return Res.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
