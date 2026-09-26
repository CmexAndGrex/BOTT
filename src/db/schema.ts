import {
  boolean,
  index,
  integer,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  varchar,
  json,
  jsonb,
} from "drizzle-orm/pg-core";
import type { MemberRole, MemberStatus } from "@/lib/recruits";
import type { ServiceReportType } from "@/lib/reports";

/**
 * Анкета рапорта на вступление (поле members.application_data).
 * Хранится как jsonb: состав полей может расширяться без миграции, а
 * модерация читает его через sanitizeApplicationData() — значения из БД
 * никогда не считаются доверенными.
 */
export type MemberApplication = {
  age?: number;
  armaExperience?: string;
  specialization?: string;
  comment?: string;
  /** Кто и когда рассмотрел рапорт (заполняется модератором) */
  reviewedBy?: string;
  reviewedAt?: string;
  /** Причина отклонения рапорта */
  decisionReason?: string;
  /** Каким способом кандидат подал рапорт */
  source?: "discord" | "password";
};

/** Ключ-значение настроек бота (редактируется из панели) */
export const settings = pgTable("bot_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull().default(""),
});

/** Состав подразделения, синхронизируется с rs-red.com */
export const members = pgTable("division_members", {
  id: serial("id").primaryKey(),
  pid: text("pid").unique(),
  handle: text("handle"),
  name: text("name").notNull(),
  rankName: text("rank_name"),
  post: text("post"),
  minutes: integer("minutes").notNull().default(0),
  hours: real("hours").notNull().default(0),
  vacation: boolean("vacation").notNull().default(false), // Статус отпуска
  vacationUntil: timestamp("vacation_until", { mode: 'date' }), // Дата выхода из отпуска
  vacationNotified: boolean("vacation_notified").notNull().default(false), // Было ли напоминание за 24ч
  leftNotified: boolean("left_notified").notNull().default(false), // Пинг Командирскому составу о выходе из подразделения уже отправлен
  discordId: text("discord_id"),
  active: boolean("active").notNull().default(true),
  warnings: integer("warnings").notNull().default(0),

  /* ------------------------------------------------------------------ */
  /* Гибридная авторизация новобранцев (Discord OAuth2 + позывной/пароль) */
  /* ------------------------------------------------------------------ */

  /**
   * Позывной — он же логин для входа по паролю.
   * Уникален, но nullable: бойцы, заведённые синхронизацией rs-red.com или
   * ботом, могут не иметь аккаунта в панели.
   */
  callsign: text("callsign").unique(),
  /** Хеш пароля (bcryptjs, 10 раундов). null — вход возможен только по Discord */
  passwordHash: text("password_hash"),
  /** Звание бойца: пишется и в ШДС, и в карточку кабинета */
  rank: text("rank").notNull().default("Курсант"),
  /** Подразделение: совпадает с именем листа Google Таблицы (см. UNITS) */
  unit: text("unit"),
  /** Статус: pending — рапорт на рассмотрении, active — в строю, dismissed — отклонён */
  status: varchar("status", { length: 20 })
    .$type<MemberStatus>()
    .notNull()
    .default("pending"),
  /** Уровень доступа в системе */
  role: varchar("role", { length: 20 })
    .$type<MemberRole>()
    .notNull()
    .default("recruit"),
  /** Аватар из Discord (или иное), показывается в кабинете и модерации */
  avatarUrl: text("avatar_url"),
  /** Анкета рапорта: возраст, опыт в Arma 3, специализация, комментарий */
  applicationData: jsonb("application_data").$type<MemberApplication>(),
  /**
   * Версия токена бойца: как и users.token_version, отзывает все ранее
   * выданные сессии одним UPDATE (смена пароля, отклонение рапорта,
   * отвязка Discord).
   */
  memberTokenVersion: integer("member_token_version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),

  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Журнал входов новобранцев (аудит гибридной авторизации).
 *
 * Пишется только при успешном входе: кто вошёл (бойца), каким способом
 * (Discord или позывной/пароль) и с какого IP. Позволяет разобрать инцидент
 * «кто зашёл под чужим позывным», не прибегая к общему журналу бота.
 */
export const memberSessions = pgTable("member_sessions", {
  /** jti токена сессии — уникальный идентификатор входа */
  id: text("id").primaryKey(),
  memberId: integer("member_id")
    .notNull()
    .references(() => members.id, { onDelete: "cascade" }),
  /** Способ входа: discord | password */
  kind: varchar("kind", { length: 20 }).notNull().default("password"),
  ip: varchar("ip", { length: 100 }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/** Снимки статистики (для графика истории) */
export const snapshots = pgTable("stat_snapshots", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  total: integer("total").notNull().default(0),
  zeroHours: integer("zero_hours").notNull().default(0),
  passed: integer("passed").notNull().default(0),
  failed: integer("failed").notNull().default(0),
  onVacation: integer("on_vacation").notNull().default(0),
  percent: real("percent").notNull().default(0),
  source: text("source").notNull().default("auto"),
});

/** ОБЪЕДИНЕННЫЙ ЖУРНАЛ */
export const logs = pgTable("bot_logs", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  kind: text("kind").notNull().default("system"),
  title: text("title").notNull().default(""),
  detail: text("detail").notNull().default(""),
  ok: boolean("ok").notNull().default(true),
  error: text("error"),
  category: varchar("category", { length: 50 }).notNull().default("system"),
  author: varchar("author", { length: 100 }),
  action: text("action").notNull().default(""),
  details: json("details"),
});

/** Защита от повторного срабатывания расписания */
export const cronRuns = pgTable("cron_runs", {
  key: text("key").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Маркеры уже обработанных заявок Discord.
 *
 * Раньше признаком «обработано» служил префикс «[» в тексте сообщения —
 * любой, кто мог редактировать сообщение (или повторно отправить реакцию),
 * влиял на идемпотентность. Теперь решение принимается по записи в БД:
 * вставка с ON CONFLICT DO NOTHING атомарно «занимает» сообщение.
 */
export const processedRequests = pgTable("processed_requests", {
  messageId: text("message_id").primaryKey(),
  /** Тип обработки: approved / denied / role-updated / error */
  kind: text("kind").notNull().default("processed"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Учетные записи пользователей для доступа к панели */
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").unique().notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("officer"),
  /**
   * Discord ID учётной записи панели.
   *
   * Связывает администратора/командира с его Discord: при входе через OAuth2
   * совпадение по этому полю сразу выдаёт административную сессию панели, без
   * локального логина и пароля. Nullable — вход по логину и паролю остаётся
   * резервным способом, а unique не даёт выдать один Discord двум аккаунтам.
   */
  discordId: varchar("discord_id", { length: 32 }).unique(),
  /**
   * Версия токена: попадает в JWT при входе и сверяется на каждом запросе.
   * Инкремент делает все ранее выданные токены недействительными — так
   * срабатывает отзыв сессии без хранения списка токенов.
   */
  tokenVersion: integer("token_version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/* ------------------------------------------------------------------ */
/* Заявки на вступление и рапорты действующего состава                 */
/* ------------------------------------------------------------------ */

/**
 * Статус рассмотрения заявки/рапорта.
 * Значения совпадают с RECRUIT_STATUS / REPORT_STATUS в src/lib/reports.ts,
 * поэтому в интерфейсе не нужны ни «магические» строки, ни any.
 */
export type ReviewStatus = "pending" | "approved" | "rejected";

/**
 * Заявка на вступление (страница /apply).
 *
 * Отдельная таблица, а не только jsonb в division_members: заявку нужно
 * показать в канале Discord с кнопками и потом обновить именно то сообщение
 * (discord_message_id). Если бы заявка жила лишь в карточке бойца, повторная
 * подача после отказа потеряла бы историю решений, а сообщение в канале —
 * связь с записью.
 */
export const recruitApplications = pgTable(
  "recruit_applications",
  {
    id: serial("id").primaryKey(),
    /** Боец, созданный из заявки (null, если запись заведена без аккаунта) */
    memberId: integer("member_id").references(() => members.id, { onDelete: "set null" }),
    callsign: text("callsign").notNull(),
    /** Логин или глобальное имя в Discord (поле формы, проверяется модератором) */
    discordTag: text("discord_tag"),
    /** Snowflake ID: заполняется из cookie Discord либо модератором */
    discordId: text("discord_id"),
    age: integer("age"),
    armaExperience: text("arma_experience"),
    about: text("about"),
    status: varchar("status", { length: 20 })
      .$type<ReviewStatus>()
      .notNull()
      .default("pending"),
    /** Сообщение с кнопками в штабном канале — его бот потом редактирует */
    discordMessageId: text("discord_message_id"),
    /**
     * Канал, в котором лежит это сообщение.
     *
     * Хранится рядом с ID сообщения, а не берётся из настроек при решении:
     * если модератор поменяет канал заявок, пока очередь не разобрана, PATCH
     * ушёл бы в другой канал и «повис» ошибкой 404 (Unknown Message).
     */
    discordChannelId: text("discord_channel_id"),
    /** Позывной офицера, принявшего решение */
    reviewedBy: text("reviewed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Очередь модерации: фильтр по статусу и сортировка «свежие сверху»
  (table) => [index("recruit_applications_status_created_idx").on(table.status, table.createdAt)]
);

/**
 * Рапорт действующего состава (меню «Подать рапорт» в кабинете).
 *
 * payload — jsonb: состав полей зависит от type и расширяется без миграции
 * (см. типы ReportPayload в src/lib/reports.ts). Значения из БД никогда не
 * считаются доверенными: интерфейс читает их через readReportPayload().
 */
export const serviceReports = pgTable(
  "service_reports",
  {
    id: serial("id").primaryKey(),
    /** Боец, подавший рапорт (callsign остаётся для истории при увольнении) */
    memberId: integer("member_id").references(() => members.id, { onDelete: "cascade" }),
    callsign: text("callsign").notNull(),
    /** Тип рапорта: exam | role | vacation | reserve | shds_entry */
    type: varchar("type", { length: 20 }).$type<ServiceReportType>().notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    status: varchar("status", { length: 20 })
      .$type<ReviewStatus>()
      .notNull()
      .default("pending"),
    /** Сообщение с кнопками в канале рапортов */
    discordMessageId: text("discord_message_id"),
    /** Канал этого сообщения: см. пояснение в recruit_applications */
    discordChannelId: text("discord_channel_id"),
    /** Комментарий модератора при решении (причина отказа и т.п.) */
    moderatorComment: text("moderator_comment"),
    reviewedBy: text("reviewed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("service_reports_status_created_idx").on(table.status, table.createdAt),
    // «Мои рапорты» в кабинете: выборка по бойцу
    index("service_reports_member_idx").on(table.memberId),
  ]
);

/** Еженедельная статистика по каждому бойцу */
export const weeklyStats = pgTable("weekly_stats", {
  id: serial("id").primaryKey(),
  memberId: integer("member_id")
    .notNull()
    .references(() => members.id, { onDelete: "cascade" }),
  hours: real("hours").notNull().default(0),
  vacation: boolean("vacation").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
