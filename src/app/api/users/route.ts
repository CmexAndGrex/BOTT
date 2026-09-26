/**
 * Учётные записи панели: список, привязка Discord и роли штаба.
 *
 * Доступ строго для администратора (requireRole). Отдаются только логин, роль
 * и привязанный Discord ID: ни хеша пароля, ни token_version наружу не уходит.
 *
 * Зачем привязка по Discord: администратор или командир, чей Discord внесён в
 * учётную запись, входит кнопкой «Войти через Discord» и сразу получает панель
 * (см. /api/auth/discord/callback) — локальный логин и пароль остаются
 * резервным способом на случай недоступности Discord.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { logs, members, users } from "@/db/schema";
import { requireRole } from "@/lib/api-auth";
import { normalizeDiscordSnowflake, roleAfterLink } from "@/lib/validation";
import { ROLE_LABELS } from "@/lib/recruits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // Список аккаунтов и связка с составом — только администратор
  const auth = await requireRole(req, ["admin"]);
  if (!auth.ok) return auth.response;

  try {
    // Получаем список, строго ИСКЛЮЧАЯ пароли
    const accounts = await db
      .select({
        id: users.id,
        username: users.username,
        role: users.role,
        discordId: users.discordId,
      })
      .from(users)
      .orderBy(users.id);

    /**
     * Бойцы состава с привязанным Discord — кандидаты на связку с аккаунтом.
     * Только те, у кого Discord уже есть: без него вход через Discord
     * невозможен, и предлагать такого бойца в списке связки было бы обманом.
     */
    const roster = await db
      .select({
        id: members.id,
        callsign: members.callsign,
        name: members.name,
        discordId: members.discordId,
        role: members.role,
        status: members.status,
      })
      .from(members)
      .where(isNotNull(members.discordId))
      .orderBy(members.name);

    const byDiscordId = new Map(roster.map((row) => [row.discordId, row]));

    return NextResponse.json({
      users: accounts.map((account) => ({
        ...account,
        // Боец, которому принадлежит этот Discord ID (если есть в составе)
        linkedMember: account.discordId ? byDiscordId.get(account.discordId) ?? null : null,
      })),
      members: roster.map((row) => ({ ...row, roleLabel: ROLE_LABELS[row.role] })),
    });
  } catch {
    return NextResponse.json({ error: "Ошибка БД" }, { status: 500 });
  }
}

type UpdateBody = {
  username?: unknown;
  discordId?: unknown;
  role?: unknown;
  linkMemberId?: unknown;
};

export async function PATCH(req: NextRequest) {
  const auth = await requireRole(req, ["admin"]);
  if (!auth.ok) return auth.response;

  let body: UpdateBody;
  try {
    body = (await req.json()) as UpdateBody;
  } catch {
    return NextResponse.json({ error: "Некорректный JSON" }, { status: 400 });
  }

  const username = typeof body.username === "string" ? body.username.trim() : "";
  if (!username) return NextResponse.json({ error: "Укажите логин" }, { status: 400 });

  try {
    const [account] = await db
      .select({
        id: users.id,
        username: users.username,
        role: users.role,
        discordId: users.discordId,
      })
      .from(users)
      .where(eq(users.username, username));
    if (!account) return NextResponse.json({ error: "Аккаунт не найден" }, { status: 404 });

    const set: { role?: string; discordId?: string | null } = {};
    const changes: string[] = [];
    const details: Record<string, string> = { "Логин": account.username };
    let warning = "";

    // --- Роль панели: admin (полный доступ) или officer (модерация) ---
    let nextRole = account.role;
    if (body.role !== undefined) {
      if (body.role !== "admin" && body.role !== "officer") {
        return NextResponse.json(
          { error: "Роль: допустимы «admin» или «officer»" },
          { status: 400 }
        );
      }
      if (body.role !== account.role) {
        // Защита от «выстрела в ногу»: последний администратор не понижается,
        // иначе панель останется без управления аккаунтами навсегда.
        if (account.role === "admin") {
          const admins = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin"));
          if (admins.length <= 1) {
            return NextResponse.json(
              { error: "Нельзя понизить последнего администратора: сначала назначьте другого" },
              { status: 409 }
            );
          }
        }
        nextRole = body.role;
        set.role = body.role;
        changes.push(`роль на «${body.role === "admin" ? "Администратор" : "Командир"}»`);
        details["Роль"] = body.role === "admin" ? "Администратор" : "Командир";
      }
    }

    // --- Discord ID: пустое значение = отвязать (вход по паролю остаётся) ---
    let nextDiscordId = account.discordId;
    if (body.discordId !== undefined) {
      const raw = typeof body.discordId === "string" ? body.discordId.trim() : "";
      const normalized = raw ? normalizeDiscordSnowflake(raw) : null;
      if (raw && !normalized) {
        return NextResponse.json(
          { error: "Discord ID: ожидается числовой ID (только цифры)" },
          { status: 400 }
        );
      }
      if (normalized !== account.discordId) {
        if (normalized) {
          // discord_id уникален: один Discord не должен уехать двум аккаунтам
          const [taken] = await db
            .select({ username: users.username })
            .from(users)
            .where(eq(users.discordId, normalized));
          if (taken) {
            return NextResponse.json(
              { error: `Этот Discord уже привязан к аккаунту «${taken.username}»` },
              { status: 409 }
            );
          }
        }
        nextDiscordId = normalized;
        set.discordId = normalized;
        changes.push(`Discord ID на «${normalized || "не привязан"}»`);
        details["Discord ID"] = normalized || "отвязан";
      }
    }

    // --- Связка с бойцом состава: роль штаба + его Discord на аккаунт ---
    /**
     * Порядок важен: сначала собираем все проверки, и только потом пишем. Если
     * проверять по ходу записи, отказ на конфликте Discord оставил бы роль
     * бойца уже повышенной — «половина» операции без второго шага.
     */
    let linkedMember: { id: number; role: string } | null = null;
    if (body.linkMemberId !== undefined) {
      const memberId = Number(body.linkMemberId);
      if (!Number.isInteger(memberId) || memberId <= 0) {
        return NextResponse.json({ error: "Некорректный ID бойца" }, { status: 400 });
      }

      const [member] = await db.select().from(members).where(eq(members.id, memberId));
      if (!member) return NextResponse.json({ error: "Боец не найден" }, { status: 404 });

      // Уровень доступа бойца поднимается до роли аккаунта (и никогда не
      // понижается): связанный командир должен иметь доступ к модерации и в
      // кабинете, иначе связка выглядела бы фиктивной
      const memberRole = roleAfterLink(member.role, nextRole === "admin" ? "admin" : "officer");
      const memberDiscordId = normalizeDiscordSnowflake(member.discordId);

      if (memberDiscordId && memberDiscordId !== nextDiscordId) {
        // Тот же Discord не должен висеть на двух аккаунтах панели
        const [taken] = await db
          .select({ id: users.id, username: users.username })
          .from(users)
          .where(eq(users.discordId, memberDiscordId));
        if (taken && taken.id !== account.id) {
          return NextResponse.json(
            { error: `Discord бойца уже привязан к аккаунту «${taken.username}»` },
            { status: 409 }
          );
        }
      }

      // Все проверки пройдены — можно записывать
      await db
        .update(members)
        .set({ role: memberRole, updatedAt: new Date() })
        .where(eq(members.id, member.id));
      linkedMember = { id: member.id, role: memberRole };

      details["Боец"] = member.callsign || member.name;
      details["Уровень доступа бойца"] = ROLE_LABELS[memberRole];
      if (member.role !== memberRole) {
        changes.push(
          `уровень доступа бойца ${member.callsign || member.name} на «${ROLE_LABELS[memberRole]}»`
        );
      }

      if (memberDiscordId && memberDiscordId !== nextDiscordId) {
        nextDiscordId = memberDiscordId;
        set.discordId = memberDiscordId;
        changes.push(`Discord ID на «${memberDiscordId}»`);
        details["Discord ID"] = memberDiscordId;
      } else if (!memberDiscordId) {
        // Роль штаба выдана, но вход через Discord не заработает, пока у бойца
        // нет Discord: сообщаем администратору прямо, а не оставляем в догадках
        warning =
          "У бойца не указан Discord ID — вход через Discord заработает, когда он " +
          "появится в карточке бойца. Сейчас доступен вход по позывному и паролю.";
      }
    }

    if (changes.length === 0) {
      return NextResponse.json({
        ok: true,
        message: "Изменений нет",
        user: { ...account, discordId: nextDiscordId, role: nextRole },
        linkedMember,
        warning,
      });
    }

    const [updated] = await db
      .update(users)
      .set(set)
      .where(eq(users.id, account.id))
      .returning({
        id: users.id,
        username: users.username,
        role: users.role,
        discordId: users.discordId,
      });

    await db.insert(logs).values({
      category: "edit",
      author: auth.user.username ? `Администратор ${auth.user.username}` : "Администратор",
      action: `изменил ${changes.join(" и ")} у аккаунта ${account.username}`,
      details,
      kind: "system",
      title: "Правка доступа",
      detail: `Аккаунт ${account.username}: ${changes.join(", ")}`,
      ok: true,
    });

    return NextResponse.json({ ok: true, message: "Сохранено", user: updated, linkedMember, warning });
  } catch (e) {
    console.error("[users] Не удалось обновить аккаунт:", e);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
