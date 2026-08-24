import {
  boolean,
  integer,
  pgTable,
  real,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

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
  vacation: boolean("vacation").notNull().default(false),
  discordId: text("discord_id"),
  active: boolean("active").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
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

/** Журнал отправок и операций */
export const logs = pgTable("bot_logs", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  detail: text("detail").notNull().default(""),
  ok: boolean("ok").notNull().default(true),
  error: text("error"),
});

/** Защита от повторного срабатывания расписания */
export const cronRuns = pgTable("cron_runs", {
  key: text("key").primaryKey(),
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
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
