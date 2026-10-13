"use client";

/**
 * Вкладка «Планировщик»: задачи, которые бот запускает сам.
 *
 * Нумерация сохранена как в ТЗ — администратор ищет «задачу №4» и должен
 * находить её под тем же номером, что в документации:
 *   №1 — пинги на операцию,
 *   №2 — проверка онлайна (должники),
 *   №3 — снимок статистики для графика,
 *   №4 — контроль вышедших из состава,
 *   №5 — контроль снятия ролей у исключённых.
 *
 * Каждая задача — отдельная карточка с переключателем в шапке: включение и
 * выключение видно сразу, без прокрутки к полю внутри блока. Поля внутри — в
 * сетке, а не столбиком: у задач по два-три коротких числовых параметра.
 */
import { AlarmClockCheck, Bot, CalendarClock, Cookie, ShieldCheck } from "lucide-react";
import { Section } from "@/components/ui";
import { Field, FieldGrid } from "@/components/settings/fields";
import type { SetSetting, SettingsState } from "@/components/settings/tabs";

export type SchedulerTabProps = {
  settings: SettingsState;
  set: SetSetting;
  /** Дни недели из настройки weekly_days */
  days: number[];
  toggleDay: (n: number) => void;
};

const DAY_OPTIONS = [
  { n: 1, label: "Пн" },
  { n: 2, label: "Вт" },
  { n: 3, label: "Ср" },
  { n: 4, label: "Чт" },
  { n: 5, label: "Пт" },
  { n: 6, label: "Сб" },
  { n: 0, label: "Вс" },
];

const TIMEZONES = [
  "Europe/Moscow",
  "Europe/Kyiv",
  "Europe/Minsk",
  "Europe/Kaliningrad",
  "Asia/Yekaterinburg",
  "Asia/Novosibirsk",
  "Asia/Vladivostok",
  "UTC",
];

/** Переключатель в шапке карточки задачи: «вкл» + сам тумблер */
function HeaderToggle({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="label">вкл</span>
      <button type="button" className="switch" data-on={on} aria-pressed={on} onClick={() => onChange(!on)} />
    </div>
  );
}

export default function SchedulerTab({ settings, set, days, toggleDay }: SchedulerTabProps) {
  /** Только цифры: ID и числовые лимиты иначе ломают парсинг на стороне бота */
  const digits = (key: string) => (v: string) => set(key, v.replace(/[^\d]/g, ""));

  return (
    <>
      {/* Задача №1 — пинги на операцию */}
      <Section
        title="Пинги на операцию"
        eyebrow="задача №1"
        action={
          <HeaderToggle
            on={settings.op_enabled === "true"}
            onChange={(v) => set("op_enabled", v ? "true" : "false")}
          />
        }
      >
        <div className="flex flex-col gap-4 px-5 py-5">
          <FieldGrid>
            <Field
              label="Время пингов (через запятую, ЧЧ:ММ)"
              hint="Ежедневно. Бот отправит случайный текст + гифку и поставит реакции ✅ ❌ ⏰ ❓."
            >
              <input
                className="input input-mono"
                placeholder="14:45, 19:45"
                value={settings.op_times}
                onChange={(e) => set("op_times", e.target.value)}
              />
            </Field>
          </FieldGrid>
          <div className="flex items-center gap-2 text-[12px]" style={{ color: "var(--muted)" }}>
            <AlarmClockCheck size={14} style={{ color: "var(--red)" }} />
            Реакции: ✅ буду · ❌ не буду · ⏰ опоздаю · ❓ под вопросом — добавляются автоматически.
          </div>
        </div>
      </Section>

      {/* Задача №2 — проверка онлайна (единая точка для времени, нормы и пояса) */}
      <Section
        title="Проверка онлайна"
        eyebrow="задача №2 · должники"
        action={
          <HeaderToggle
            on={settings.weekly_enabled === "true"}
            onChange={(v) => set("weekly_enabled", v ? "true" : "false")}
          />
        }
      >
        <div className="flex flex-col gap-4 px-5 py-5">
          <div>
            <div className="label mb-1.5">Дни проверки</div>
            <div className="flex flex-wrap gap-1.5">
              {DAY_OPTIONS.map((d) => (
                <button
                  key={d.n}
                  className="day-pill"
                  data-on={days.includes(d.n)}
                  onClick={() => toggleDay(d.n)}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>
          <FieldGrid columns={3}>
            <Field label="Время">
              <input
                className="input input-mono"
                placeholder="12:00"
                value={settings.weekly_time}
                onChange={(e) => set("weekly_time", e.target.value)}
              />
            </Field>
            <Field label="Норма в часах">
              <input
                className="input input-mono"
                type="number"
                min={1}
                value={settings.norm_hours}
                onChange={(e) => set("norm_hours", e.target.value)}
              />
            </Field>
            <Field label="Часовой пояс" hint="Общий для всех задач расписания.">
              <select
                className="select"
                value={settings.timezone}
                onChange={(e) => set("timezone", e.target.value)}
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </Field>
          </FieldGrid>
          <div className="flex items-center gap-2 text-[12px]" style={{ color: "var(--muted)" }}>
            <CalendarClock size={14} style={{ color: "var(--amber)" }} />
            Пингуются должники (&lt; нормы) без отпуска, у которых привязан Discord ID.
          </div>
        </div>
      </Section>

      {/* Задача №3 — снимок статистики */}
      <Section
        title="Снимок статистики"
        eyebrow="задача №3 · график"
        action={
          <HeaderToggle
            on={settings.snapshot_enabled === "true"}
            onChange={(v) => set("snapshot_enabled", v ? "true" : "false")}
          />
        }
      >
        <div className="flex flex-col gap-4 px-5 py-5">
          <FieldGrid>
            <Field
              label="Время снимка"
              hint="Ежедневно. Сохраняет точку онлайн-статистики для графика на главной странице; запись об этом появляется в журнале."
            >
              <input
                className="input input-mono"
                placeholder="21:00"
                value={settings.snapshot_time}
                onChange={(e) => set("snapshot_time", e.target.value)}
              />
            </Field>
          </FieldGrid>
          <div className="flex items-center gap-2 text-[12px]" style={{ color: "var(--muted)" }}>
            <CalendarClock size={14} style={{ color: "var(--green)" }} />
            Часовой пояс берётся из задачи №2 (по умолчанию Europe/Moscow).
          </div>
        </div>
      </Section>

      {/* Задача №4 — контроль вышедших из состава */}
      <Section
        title="Контроль вышедших из состава"
        eyebrow="задача №4 · пинг при выходе"
        action={
          <HeaderToggle
            on={settings.left_members_check === "true"}
            onChange={(v) => set("left_members_check", v ? "true" : "false")}
          />
        }
      >
        <div className="flex flex-col gap-4 px-5 py-5">
          <FieldGrid>
            <Field
              label="ID канала проверок"
              hint="Если пусто — используется основной канал для пингов из вкладки «Интеграции»."
            >
              <input
                className="input input-mono w-full"
                placeholder="например 1185432109876543210"
                value={settings.left_check_channel_id}
                onChange={(e) => digits("left_check_channel_id")(e.target.value)}
              />
            </Field>
            <Field
              label="ID роли «Командирский состав»"
              hint="Эта роль пингуется, если у вышедшего бойца сутки не сняты роли клана."
            >
              <input
                className="input input-mono w-full"
                placeholder="например 1392552505162072264"
                value={settings.command_role_id}
                onChange={(e) => digits("command_role_id")(e.target.value)}
              />
            </Field>
          </FieldGrid>
          <div className="flex items-start gap-2.5 text-[12px] leading-relaxed" style={{ color: "var(--muted)" }}>
            <ShieldCheck size={14} className="mt-0.5 flex-none" style={{ color: "var(--amber)" }} />
            <span>
              Боец пропал из состава rs-red.com и с него не сняли роли клана в течение суток — бот
              отправит однократный пинг командирскому составу. При возвращении бойца в состав флаг
              сбрасывается, и проверка сработает снова при следующем выходе.
            </span>
          </div>
        </div>
      </Section>

      {/* Задача №5 — контроль снятия ролей у исключённых */}
      <Section
        title="Контроль ролей исключённых"
        eyebrow="задача №5 · исключённые бойцы"
        action={
          <HeaderToggle
            on={settings.roles_monitor_enabled === "true"}
            onChange={(v) => set("roles_monitor_enabled", v ? "true" : "false")}
          />
        }
      >
        <div className="flex flex-col gap-4 px-5 py-5">
          <FieldGrid>
            <Field
              label="ID канала уведомлений"
              hint="Если пусто — канал проверок вышедших (задача №4), затем основной канал пингов."
            >
              <input
                className="input input-mono w-full"
                placeholder="например 1185432109876543210"
                value={settings.roles_monitor_channel_id}
                onChange={(e) => digits("roles_monitor_channel_id")(e.target.value)}
              />
            </Field>
            <Field label="Срок ожидания, часов" hint="По умолчанию 24 часа. Допустимо от 1 до 720.">
              <input
                className="input input-mono w-full"
                placeholder="24"
                value={settings.roles_monitor_delay_hours}
                onChange={(e) => digits("roles_monitor_delay_hours")(e.target.value)}
              />
            </Field>
          </FieldGrid>
          <div className="flex items-start gap-2.5 text-[12px] leading-relaxed" style={{ color: "var(--muted)" }}>
            <ShieldCheck size={14} className="mt-0.5 flex-none" style={{ color: "var(--amber)" }} />
            <span>
              Боец исключён в панели (уволен, переведён в запас, отклонена заявка), но роль
              подразделения на сервере осталась — бот напомнит командирскому составу снять роли.
              Уведомление приходит однократно на бойца: если роли уже сняты или человек вышел с
              сервера, напоминания не будет. Отсчёт идёт от момента исключения.
            </span>
          </div>
        </div>
      </Section>

      {/* Что происходит само: сводка по фоновым механизмам */}
      <Section title="Автоматика" eyebrow="что происходит само">
        <div className="grid gap-3 px-5 py-5 sm:grid-cols-3">
          {[
            {
              icon: Bot,
              title: "Каждую минуту",
              text: "Планировщик проверяет расписание и запускает задачи точно в слот",
            },
            {
              icon: Cookie,
              title: "Каждые 30 минут",
              text: "Состав подразделения обновляется с rs-red.com в фоне",
            },
            {
              icon: ShieldCheck,
              title: "Защита от дублей",
              text: "Каждый слот фиксируется в базе — повторных пингов не будет",
            },
          ].map((f) => (
            <div
              key={f.title}
              className="flex gap-3 rounded-2xl border p-4"
              style={{ borderColor: "var(--stroke-soft)", background: "rgba(255,255,255,.02)" }}
            >
              <f.icon size={17} className="mt-0.5 flex-none" style={{ color: "var(--red)" }} />
              <div>
                <div className="text-[13px] font-bold">{f.title}</div>
                <div className="mt-1 text-[11.5px] leading-relaxed" style={{ color: "var(--dim)" }}>
                  {f.text}
                </div>
              </div>
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}