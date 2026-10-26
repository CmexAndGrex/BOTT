import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users, logs, members } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { normalizePersonName } from "@/lib/recruits";
import {
  issuePanelToken,
  logPanelLogin,
  setPanelCookie,
} from "@/lib/api-auth";
import { attachCabinetSession } from "@/lib/member-auth";

type RateRecord = { attempts: number; lockUntil: number; at: number };
const rateLimitMap = new Map<string, RateRecord>();
const MAX_ATTEMPTS = 5; 
const MAX_REMEMBERED_IPS = 5000;
const RATE_RECORD_TTL_MS = 24 * 60 * 60 * 1000;
const LOCK_TIME_MS = 15 * 60 * 1000; 

/* Срок жизни сессии и правило флага Secure живут в src/lib/api-auth.ts
   (PANEL_SESSION_TTL_SECONDS, isSecureRequest): сессию панели выпускает ещё и
   вход через Discord, и копия этих правил в двух местах разошлась бы */ 

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

    /**
     * Поиск учётной записи по трём ключам: username, ФИО и Discord ID.
     *
     * Требование: в поле логина пользователь может ввести свой английский
     * username, русское ФИО («Иванов И.А.») или discord_id. ФИО сравнивается
     * по нормализованному ключу (normalizePersonName): «Иванов И.А.» и
     * «Иванов И. А.» — один человек. Неоднозначность (двое с одинаковым ФИО)
     * трактуется как «не найдено»: показать чужой кабинет хуже, чем попросить
     * уточнить логин.
     */
    const login = String(username).trim();
    const [user] = await db.select().from(users).where(eq(users.username, login));

    /**
     * ФИО и Discord ID: поиск по табелю, когда username не совпал.
     *
     * Порядок: сначала точное совпадение username (уникальный индекс), затем
     * discord_id (тоже уникален), затем ФИО по нормализованному ключу —
     * по нему может найтись несколько карточек, и тогда вход отклоняется
     * (неоднозначность), а не выбирается первая попавшаяся.
     */
    let found = user ?? null;
    if (!found) {
      const discordKey = login.replace(/\D/g, "");
      if (/^\d{5,25}$/.test(discordKey)) {
        const [byDiscord] = await db
          .select()
          .from(users)
          .where(eq(users.discordId, discordKey));
        found = byDiscord ?? null;
      }
    }
    if (!found) {
      const nameKey = normalizePersonName(login);
      if (nameKey) {
        const roster = await db
          .select({ id: members.id, name: members.name, memberId: users.memberId })
          .from(members)
          .leftJoin(users, eq(users.memberId, members.id));
        const matched = roster.filter(
          (row) => row.name && normalizePersonName(row.name) === nameKey && row.memberId
        );
        if (matched.length === 1) {
          const [byName] = await db
            .select()
            .from(users)
            .where(eq(users.id, matched[0].memberId!));
          found = byName ?? null;
        }
      }
    }

    const account = found;
    const accountValid = account ? await bcrypt.compare(password, account.passwordHash) : false;

    if (!account || !accountValid) {
      const attempts = (record?.attempts || 0) + 1;
      const lockUntil = attempts >= MAX_ATTEMPTS ? now + LOCK_TIME_MS : 0;
      rateLimitMap.set(ip, { attempts, lockUntil, at: now });

      // Фиксируем неудачную попытку в журнале — это сигнал для разбора
      // инцидентов (раньше логировались только успешные входы).
      try {
        await db.insert(logs).values({
          category: "auth",
          author: typeof username === "string" ? username.slice(0, 100) : "—",
          action: "неудачная попытка входа",
          details: {
            IP: ip,
            Попытка: `${attempts}/${MAX_ATTEMPTS}`,
            Блокировка: lockUntil ? "выдана на 15 мин" : "нет",
          },
          kind: "auth",
          title: "Отказ в доступе",
          detail: `Неудачная попытка входа: ${attempts} из ${MAX_ATTEMPTS}`,
          ok: false,
          error: "Неверный логин или пароль",
        });
      } catch {
        // Журнал не должен мешать ответу клиенту
      }

      return NextResponse.json({ error: "Неверный логин или пароль" }, { status: 401 });
    }

    rateLimitMap.delete(ip);

    /**
     * Автосвязка аккаунта с карточкой бойца по Discord ID.
     *
     * Зачем: users.member_id заполняется вручную в «Доступах» или при входе
     * через Discord, но аккаунт, у которого записан только discord_id (его
     * внёс администратор), оставался без связки — и после входа по паролю
     * /profile показывал заглушку «войдите в личный кабинет». Связка ищется
     * по подтверждённому Discord ID (совпасть случайно он не может) и
     * пишется один раз: повторный вход находит её по member_id.
     *
     * Сбой записи не отменяет вход: сессия уже выдана, а связка —
     * производное улучшение.
     */
    let memberId = account.memberId ?? null;
    if (!memberId && account.discordId) {
      try {
        const [linked] = await db
          .select({ id: members.id })
          .from(members)
          .where(
            sql`regexp_replace(coalesce(${members.discordId}, ''), '[^0-9]', '', 'g') = ${account.discordId}`
          )
          .orderBy(members.id)
          .limit(1);
        if (linked) {
          await db
            .update(users)
            .set({ memberId: linked.id })
            .where(eq(users.id, account.id));
          memberId = linked.id;
        }
      } catch (e) {
        console.error("[auth] Не удалось связать аккаунт с бойцом по Discord ID:", e);
      }
    }

    const token = await issuePanelToken({
      id: account.id,
      username: account.username,
      role: account.role,
      tokenVersion: account.tokenVersion,
      memberId,
    });

    await logPanelLogin(account.username, "вход в панель по паролю", { ip });

    const response = NextResponse.json({ ok: true, role: account.role });
    setPanelCookie(response, token, req);

    // Стандартный вход в систему и личный кабинет открывает сразу: аккаунт
    // панели связан с бойцом (users.member_id или Discord ID/позывной).
    // Без этого командир после входа видел на /profile заглушку «войдите в
    // личный кабинет», а клик «Войти» возвращал его на /login — цикл из отчёта.
    const member = await attachCabinetSession(response, req, {
      username: account.username,
      memberId,
      discordId: account.discordId,
    });
    if (member) {
      await logPanelLogin(account.username, "кабинет открыт по сессии панели", {
        "Позывной": member.callsign,
        "IP": ip,
      });
    }

    return response;
  } catch (e) {
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
