/**
 * Санитация тела сообщения Discord.
 *
 * Причина: рапорты №19–21 падали с 400 Invalid Form Body. Discord отвергает
 * форму, если в `embed.fields` попадает пустая строка (подразделение не
 * назначено, комментарий пуст), а также если у кнопки нет `type: 2` или стиль
 * задан строкой. Проверяются именно боевые функции из src/lib/discord.ts:
 * копия правил в тесте ничего бы не гарантировала.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BUTTON_STYLE,
  sanitizeComponents,
  sanitizeEmbed,
  type DiscordActionRow,
} from "@/lib/discord.ts";

describe("Санитация Embed перед отправкой в Discord", () => {
  test("пустые значения полей заменяются прочерком, а не уходят как есть", () => {
    const embed = sanitizeEmbed({
      fields: [
        { name: "Подразделение", value: "", inline: true },
        { name: "Звание", value: "—", inline: true },
      ],
    });

    assert.equal(embed.fields?.[0]?.value, "—");
    assert.equal(embed.fields?.[1]?.value, "—");
  });

  test("поля без имени выбрасываются: Discord требует непустой name", () => {
    const embed = sanitizeEmbed({
      fields: [
        { name: "", value: "текст" },
        { name: "   ", value: "текст" },
        { name: "Суть рапорта", value: "Отпуск" },
      ],
    });

    assert.equal(embed.fields?.length, 1);
    assert.equal(embed.fields?.[0]?.name, "Суть рапорта");
  });

  test("пустые заголовок и описание не передаются вовсе", () => {
    const embed = sanitizeEmbed({ title: "", description: "   ", color: 0xffb020 });

    assert.equal("title" in embed, false);
    assert.equal("description" in embed, false);
    assert.equal(embed.color, 0xffb020);
  });

  test("пустой массив полей не попадает в форму", () => {
    const embed = sanitizeEmbed({ title: "Рапорт", fields: [] });
    assert.equal("fields" in embed, false);
  });

  test("длинное значение обрезается до лимита Discord (1024)", () => {
    const embed = sanitizeEmbed({ fields: [{ name: "Суть", value: "я".repeat(2000) }] });
    assert.equal(embed.fields?.[0]?.value.length, 1024);
  });
});

describe("Санитация компонентов (кнопок) Discord", () => {
  test("каждая кнопка получает type: 2 и числовой style внутри ActionRow", () => {
    const rows = sanitizeComponents([
      {
        type: 1,
        components: [
          { custom_id: "report_approve_1", label: "Одобрить", style: BUTTON_STYLE.SUCCESS },
          { custom_id: "report_reject_1", label: "Отклонить", style: BUTTON_STYLE.DANGER },
        ],
      },
    ]);

    assert.equal(rows?.[0]?.type, 1);
    assert.equal(rows?.[0]?.components[0]?.type, 2);
    assert.equal(rows?.[0]?.components[0]?.style, 3);
    assert.equal(rows?.[0]?.components[1]?.style, 4);
  });

  test("нечисловой стиль не попадает в запрос: подставляется Secondary", () => {
    const rows = sanitizeComponents([
      {
        type: 1,
        components: [
          {
            custom_id: "report_approve_1",
            label: "Одобрить",
            // Имитация строкового стиля из старого кода
            style: "SUCCESS" as unknown as 3,
          },
        ],
      },
    ]);

    assert.equal(rows?.[0]?.components[0]?.style, BUTTON_STYLE.SECONDARY);
  });

  test("кнопка без custom_id выбрасывается, пустые ряды не отправляются", () => {
    assert.equal(
      sanitizeComponents([{ type: 1, components: [{ custom_id: "", label: "x", style: 3 }] }]),
      undefined
    );
    assert.equal(sanitizeComponents([]), undefined);
    assert.equal(sanitizeComponents(undefined), undefined);
  });

  test("пустой label заменяется текстом, а не остаётся строкой нулевой длины", () => {
    const rows: DiscordActionRow[] | undefined = sanitizeComponents([
      { type: 1, components: [{ custom_id: "report_approve_1", label: "", style: 3 }] },
    ]);

    assert.equal(rows?.[0]?.components[0]?.label, "Действие");
  });
});
