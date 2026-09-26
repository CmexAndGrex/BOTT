/**
 * Временный пароль зачисленного бойца.
 *
 * Вынесен из reports.ts отдельным модулем: тот файл используется и в браузере
 * (формы рапортов, подменю сайдбара), а `node:crypto` в клиентскую сборку не
 * попадает — импорт randomInt сломал бы сборку страницы. Здесь же серверная
 * часть, которая вызывается только при зачислении.
 */
import { randomInt } from "node:crypto";

/**
 * Алфавит без визуально неоднозначных символов (0/O, 1/l/I): пароль диктуют
 * голосом в Discord, и «ноль или O» превращались бы в постоянные обращения
 * в штаб с просьбой продиктовать ещё раз.
 */
const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
const LOWERCASE = "abcdefghjkmnpqrstuvwxyz";
const DIGITS = "23456789";

/**
 * Длина случайной части пароля.
 *
 * Политика панели (password-policy.ts) требует минимум 10 символов — вместе с
 * префиксом «Atk-» получается ровно 10, поэтому боец может сразу войти в
 * кабинет и сменить пароль там же.
 */
export const TEMP_PASSWORD_LENGTH = 6;

/** Префикс временного пароля из ТЗ */
export const TEMP_PASSWORD_PREFIX = "Atk-";

/**
 * Временный пароль вида «Atk-4kRt9m».
 *
 * Гарантируем минимум одну строчную букву и одну цифру: без этого пароль не
 * прошёл бы checkPasswordPolicy (нужны два вида символов), и сменить его в
 * кабинете было бы нельзя — политика применилась бы и к новому паролю.
 */
export function generateTempPassword(): string {
  const chars: string[] = [
    LOWERCASE[randomInt(LOWERCASE.length)],
    DIGITS[randomInt(DIGITS.length)],
  ];
  while (chars.length < TEMP_PASSWORD_LENGTH) {
    chars.push(ALPHABET[randomInt(ALPHABET.length)]);
  }
  // Перемешивание Фишера—Йетса: иначе цифра всегда стояла бы на втором месте
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return `${TEMP_PASSWORD_PREFIX}${chars.join("")}`;
}