"use client";

/**
 * Вкладка «Контент и роли»: то, что бот пишет, и то, как он называет роли.
 *
 * Три вещи, у которых общая природа — «справочные данные бота»:
 *   * тексты пингов (по строке на вариант, выбирается случайный);
 *   * гифки (прямые ссылки, по строке на вариант);
 *   * карта должностей «должность = ID роли» для сверки ролей.
 *
 * Раньше тексты и гифки лежали отдельной карточкой, а карта должностей — внутри
 * блока Discord с каналами и лимитами. Здесь они рядом: правят их обычно за один
 * заход — «перепишу тексты и заодно проверю должности».
 */
import { FileText, SlidersHorizontal } from "lucide-react";
import { Section } from "@/components/ui";
import { Field, FieldGrid } from "@/components/settings/fields";
import type { SetSetting, SettingsState } from "@/components/settings/tabs";

export type ContentTabProps = {
  settings: SettingsState;
  set: SetSetting;
};

export default function ContentTab({ settings, set }: ContentTabProps) {
  return (
    <>
      <Section
        title="Тексты и гифки для операций"
        eyebrow="ротация контента"
        action={<FileText size={15} style={{ color: "var(--dim)" }} />}
      >
        <div className="grid gap-5 px-5 py-5 lg:grid-cols-2">
          <Field label="Тексты пинга — по одному на строку" hint="На каждый пинг выбирается случайная строка.">
            <textarea
              className="textarea"
              style={{ minHeight: 180 }}
              value={settings.op_texts}
              onChange={(e) => set("op_texts", e.target.value)}
            />
          </Field>
          <Field
            label="Гифки — прямые ссылки, по одной на строку"
            hint={
              <>
                Нужны прямые ссылки на .gif: с Giphy откройте гифку → «Copy Link» → вариант вида{" "}
                <span className="kbd">media.giphy.com/media/…/giphy.gif</span>. Если ссылка битая —
                сообщение уйдёт просто без картинки.
              </>
            }
          >
            <textarea
              className="textarea"
              style={{ minHeight: 180 }}
              value={settings.op_gifs}
              onChange={(e) => set("op_gifs", e.target.value)}
            />
          </Field>
        </div>
      </Section>

      <Section
        title="Карта должностей"
        eyebrow="сверка ролей · должность = роль"
        action={<SlidersHorizontal size={15} style={{ color: "var(--dim)" }} />}
      >
        <div className="flex flex-col gap-4 px-5 py-5">
          <FieldGrid>
            <Field
              label="Соответствие «должность = ID роли»"
              hint={
                <>
                  По строке на пару, роль указывается ID (имя роли командир может изменить). Если
                  должность в карточке бойца снята или заменена — прежняя роль снимается.
                </>
              }
            >
              <textarea
                className="textarea"
                style={{ minHeight: 90 }}
                placeholder={"Механик-водитель = 1090320507288699020\nНаводчик = 1090320811572875314"}
                value={settings.post_role_map}
                onChange={(e) => set("post_role_map", e.target.value)}
              />
            </Field>
            <Field
              label="Срок хранения журнала, дней"
              hint="Автоочистка в планировщике: удаляются незначительные записи старше срока. Вход в панель и правки состава сохраняются всегда."
            >
              <input
                className="input input-mono"
                inputMode="numeric"
                placeholder="30"
                value={settings.logs_retention_days}
                onChange={(e) => set("logs_retention_days", e.target.value.replace(/[^\d]/g, ""))}
              />
            </Field>
          </FieldGrid>
        </div>
      </Section>
    </>
  );
}