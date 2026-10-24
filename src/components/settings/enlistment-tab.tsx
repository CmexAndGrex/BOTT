"use client";

/**
 * Вкладка «Зачисление и роли»: что бот делает при приёме новобранца.
 *
 * Сюда собраны две группы настроек, которые раньше приходилось искать по
 * разным разделам и угадывать по названиям полей:
 *   1. роли Discord, которые выдаются одобренному кандидату (корпус,
 *      подразделение, начальное звание);
 *   2. названия листов ШДС, в которые записывается боец.
 *
 * Почему отдельная вкладка, а не поля внутри «Интеграций»: эти значения
 * меняются вместе с приказом о зачислении (новая рота, переименованный лист),
 * а не при настройке подключений, и администратор ищет их именно как «что
 * происходит при приёме».
 *
 * Раскладка ШДС (колонки, блоки, границы оценок) от имени листа не зависит —
 * настроить можно только имя. Это написано в подсказке, иначе легко решить,
 * что переименование листа «переставит» столбцы.
 */
import { UserPlus } from "lucide-react";
import { RANK_CATALOG } from "@/lib/rank-catalog";
import { RANK_ROLE_IDS } from "@/lib/roles";
import { Section } from "@/components/ui";
import { Field, FieldGrid } from "@/components/settings/fields";
import type { SetSetting, SettingsState } from "@/components/settings/tabs";

export type EnlistmentTabProps = {
  settings: SettingsState;
  set: SetSetting;
};

/** Подсказка «где взять ID роли»: повторялась под каждым полем роли */
const ROLE_ID_HINT =
  "Настройки сервера → Роли → ПКМ по роли → «Копировать ID роли» (нужен режим разработчика).";

export default function EnlistmentTab({ settings, set }: EnlistmentTabProps) {
  /** Только цифры: ID роли иначе не примет ни один вызов Discord API */
  const digits = (key: string) => (v: string) => set(key, v.replace(/[^\d]/g, ""));

  const filled = [
    settings.role_corps_id,
    settings.role_tank_id,
    settings.role_art_id,
    ...RANK_CATALOG.map((rank) => settings[`rank_role_${rank}`] || RANK_ROLE_IDS[rank] || ""),
  ].filter((v) => (v || "").trim()).length;

  return (
    <>
      <Section
        title="Роли Discord при вступлении"
        eyebrow="корпус · подразделение · звание"
        action={
          <span className="chip">
            <UserPlus size={12} />
            задано ролей: {filled} / {3 + RANK_CATALOG.length}
          </span>
        }
      >
        <div className="flex flex-col gap-4 px-5 py-5">
          <p className="text-[11.5px] leading-relaxed" style={{ color: "var(--dim)" }}>
            Эти роли бот выдаёт автоматически в момент одобрения заявки. Пустое поле — роль
            ищется на сервере по имени, поэтому зачисление работает и без настроек; задайте ID,
            если на сервере несколько ролей с похожими именами.
          </p>

          <FieldGrid>
            <Field label="ID роли «Артиллерийско-Танковый Корпус»" hint={ROLE_ID_HINT}>
              <input
                className="input input-mono"
                placeholder="пусто — ищется по имени"
                value={settings.role_corps_id}
                onChange={(e) => digits("role_corps_id")(e.target.value)}
              />
            </Field>
            <div className="md:col-span-2">
              <div className="label mb-2">Роли званий Discord (Звание = ID роли)</div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {RANK_CATALOG.map((rank) => {
                  const key = `rank_role_${rank}`;
                  return <Field key={rank} label={rank} hint={ROLE_ID_HINT}>
                    <input className="input input-mono" placeholder={RANK_ROLE_IDS[rank] || "пусто — поиск по названию"} value={settings[key] || ""} onChange={(e) => digits(key)(e.target.value)} />
                  </Field>;
                })}
              </div>
            </div>
            <Field
              label="ID роли «Танковая рота»"
              hint="Выдаётся кандидатам, выбравшим Танковую роту в форме. Здесь же используется автоопределением подразделения."
            >
              <input
                className="input input-mono"
                placeholder="пусто — ищется по имени «Танковая рота»"
                value={settings.role_tank_id}
                onChange={(e) => digits("role_tank_id")(e.target.value)}
              />
            </Field>
            <Field
              label="ID роли «Артиллерийский дивизион»"
              hint="Выдаётся кандидатам, выбравшим Артиллерийский дивизион. Та же логика, что у роли роты."
            >
              <input
                className="input input-mono"
                placeholder="пусто — ищется по имени «Артиллерийский дивизион»"
                value={settings.role_art_id}
                onChange={(e) => digits("role_art_id")(e.target.value)}
              />
            </Field>
          </FieldGrid>

          <div
            className="flex items-start gap-2.5 text-[12px] leading-relaxed"
            style={{ color: "var(--muted)" }}
          >
            <UserPlus size={14} className="mt-0.5 flex-none" style={{ color: "var(--red)" }} />
            <span>
              При одобрении боец получает все три роли: корпус, подразделение и звание. Если
              Discord откажет (роль выше роли бота, нет прав), решение штаба всё равно остаётся
              в силе — повторите выдачу в канале запросов ролей.
            </span>
          </div>
        </div>
      </Section>

      <Section title="Синхронизация с ШДС" eyebrow="листы Google Таблицы">
        <div className="flex flex-col gap-4 px-5 py-5">
          <p className="text-[11.5px] leading-relaxed" style={{ color: "var(--dim)" }}>
            Названия листов, в которые записывается зачисленный боец. Пустое поле — лист
            называется так же, как подразделение. Переименование листа не меняет раскладку
            столбцов: колонки, блоки должностей и границы оценок зафиксированы в коде.
          </p>

          <FieldGrid>
            <Field
              label="Лист Танковой роты"
              hint="По умолчанию «Танковая рота». Имя должно точно совпадать с названием листа в таблице."
            >
              <input
                className="input"
                placeholder="Танковая рота"
                value={settings.shds_sheet_tank}
                onChange={(e) => set("shds_sheet_tank", e.target.value)}
              />
            </Field>
            <Field
              label="Лист Артиллерийского дивизиона"
              hint="По умолчанию «Артиллерийский дивизион». Служебные листы («Запас») настраиваются отдельно."
            >
              <input
                className="input"
                placeholder="Артиллерийский дивизион"
                value={settings.shds_sheet_art}
                onChange={(e) => set("shds_sheet_art", e.target.value)}
              />
            </Field>
          </FieldGrid>
        </div>
      </Section>
    </>
  );
}
