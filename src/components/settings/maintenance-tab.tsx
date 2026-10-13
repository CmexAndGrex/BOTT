"use client";

/**
 * Вкладка «Обслуживание»: ручные действия и то, что им предшествует.
 *
 * Здесь две части, и порядок между ними не случаен:
 *   1. настройки фоновой сверки ролей (включена ли, режим проверки, интервал);
 *   2. панель обслуживания — кнопки «проверить/применить сейчас», синхронизация
 *      Google Таблицы, создание резервной копии и список доступных дампов.
 *
 * Сначала параметры, потом кнопки: администратор, который пришёл сюда впервые,
 * должен увидеть, что сверка по умолчанию выключена и что есть безопасный режим
 * проверки, до того как нажмёт «Применить сейчас».
 *
 * Настройки сохраняются кнопкой «Сохранить всё» страницы-контейнера, а кнопки
 * внутри панели обслуживания срабатывают сразу — как и раньше, это разные
 * действия, и смешивать их в одной кнопке нельзя.
 */
import { ShieldCheck } from "lucide-react";
import { Section } from "@/components/ui";
import { Field, FieldGrid, ToggleRow } from "@/components/settings/fields";
import MaintenancePanel from "@/components/maintenance-panel";
import type { SetSetting, SettingsState } from "@/components/settings/tabs";

export type MaintenanceTabProps = {
  settings: SettingsState;
  set: SetSetting;
};

export default function MaintenanceTab({ settings, set }: MaintenanceTabProps) {
  return (
    <>
      <Section
        title="Сверка ролей Discord"
        eyebrow="фоновая задача · роли бойцов"
        action={
          <span className="chip">
            <span
              className={`dot ${settings.role_sync_enabled === "true" ? "" : "dot-dim"}`}
              style={settings.role_sync_enabled === "true" ? { background: "var(--green)" } : undefined}
            />
            сверка: {settings.role_sync_enabled === "true" ? "вкл" : "выкл"}
          </span>
        }
      >
        <div className="flex flex-col gap-4 px-5 py-5">
          <p className="text-[11.5px] leading-relaxed" style={{ color: "var(--dim)" }}>
            Бот сверяет звания, подразделения, отпуск и должности бойцов с ролями на сервере и
            приводит их в соответствие. Кастомные роли («Игроман», «Модератор») не трогаются, роли
            ботов — тоже. По умолчанию сверка выключена: сначала посмотрите отчёт в режиме проверки,
            чтобы увидеть, что именно будет изменено.
          </p>
          <FieldGrid>
            {/* Без подписи сверху: переключатели сами объясняют себя */}
            <div className="flex min-w-0 flex-col justify-center">
              <div className="flex flex-col gap-3">
                <ToggleRow
                  label="вкл"
                  title="Фоновая сверка ролей"
                  on={settings.role_sync_enabled === "true"}
                  onChange={(v) => set("role_sync_enabled", v ? "true" : "false")}
                />
                <ToggleRow
                  label="проверка"
                  title="Роли не менять"
                  on={settings.role_sync_dry_run === "true"}
                  onChange={(v) => set("role_sync_dry_run", v ? "true" : "false")}
                />
                <p className="text-[11.5px] leading-relaxed" style={{ color: "var(--dim)" }}>
                  В режиме проверки бот считает расхождения и пишет отчёт в журнал, но ничего не
                  меняет. Выключите его, когда убедитесь в правильности отчёта.
                </p>
              </div>
            </div>
            <Field
              label="Как часто сверять, минут (5–1440)"
              hint="Меньше 5 минут — слишком часто: сверка опрашивает Discord по каждому бойцу."
            >
              <input
                className="input input-mono"
                inputMode="numeric"
                value={settings.role_sync_interval_min}
                onChange={(e) => set("role_sync_interval_min", e.target.value.replace(/[^\d]/g, ""))}
              />
            </Field>
          </FieldGrid>
          <div className="flex items-start gap-2.5 text-[12px] leading-relaxed" style={{ color: "var(--muted)" }}>
            <ShieldCheck size={14} className="mt-0.5 flex-none" style={{ color: "var(--green)" }} />
            <span>
              Сверка меняет роли живых людей на сервере, поэтому запускать её лучше из панели
              обслуживания ниже: там есть «Проверить без изменений» — безопасный прогон с отчётом.
            </span>
          </div>
        </div>
      </Section>

      {/* Действия с мгновенным эффектом: синхронизация, копии, дампы, очистка */}
      <MaintenancePanel />
    </>
  );
}