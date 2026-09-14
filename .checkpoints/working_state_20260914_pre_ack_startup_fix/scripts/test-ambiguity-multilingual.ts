import { detectClockTimeAmbiguity, resolveAmbiguousTimeToIso, formatTimingWithResolvedMeridiem } from '../server/utils/timeAmbiguity.js';
import { parseNumericDateWithLocale, parseReminderTriggerTime, parseTimeStringToHM } from '../server/utils/time.js';

async function runAmbiguityTests() {
  console.log("================================================================================");
  console.log("  CLASS C — UNIT / SYNTHETIC PASS: TEMPORAL AMBIGUITY & MULTILINGUAL PARSING   ");
  console.log("  Note: Tests pure algorithmic parsing across locales. Does not test live UI.  ");
  console.log("================================================================================");

  const refDate = new Date("2026-08-28T10:00:00+10:00");
  const timeZone = "Australia/Sydney";
  const offsetStr = "+10:00";

  let passed = 0;
  let failed = 0;

  function assert(name: string, condition: boolean, details: string = "") {
    if (condition) {
      console.log(`[PASS] ${name}`);
      passed++;
    } else {
      console.error(`[FAIL] ${name} - ${details}`);
      failed++;
    }
  }

  console.log("\n--- 1. BARE CLOCK TIME AMBIGUITY DETECTION (Must NOT silently guess AM/PM) ---");

  // 1.1 "tomorrow at 4"
  const tomAt4 = detectClockTimeAmbiguity("Remind me tomorrow at 4", null, refDate, timeZone, offsetStr, "en-AU");
  assert("tomorrow at 4 -> isAmbiguous", tomAt4.isAmbiguous === true && tomAt4.hour === 4 && Boolean(tomAt4.question?.includes("4 am or 4 pm")));

  // 1.2 "4 o'clock"
  const fourOclock = detectClockTimeAmbiguity("Meeting at 4 o'clock", null, refDate, timeZone, offsetStr, "en-AU");
  assert("4 o'clock -> isAmbiguous", fourOclock.isAmbiguous === true && fourOclock.hour === 4);

  // 1.3 "Monday at 7"
  const monAt7 = detectClockTimeAmbiguity("Ring Peter Monday at 7", null, refDate, timeZone, offsetStr, "en-AU");
  assert("Monday at 7 -> isAmbiguous", monAt7.isAmbiguous === true && monAt7.hour === 7);

  // 1.4 parseTimeStringToHM must reject bare hours without meridiem
  assert("parseTimeStringToHM('4') -> null (ambiguous)", parseTimeStringToHM("4") === null);
  assert("parseTimeStringToHM('7:00') -> null (ambiguous)", parseTimeStringToHM("7:00") === null);

  console.log("\n--- 2. EXPLICIT / UNAMBIGUOUS TIME EXPRESSIONS (Must resolve without clarification) ---");

  // 2.1 "4pm"
  const fourPm = detectClockTimeAmbiguity("Ring Peter at 4pm", null, refDate, timeZone, offsetStr, "en-AU");
  assert("4pm -> unambiguous (dayPart=pm)", fourPm.isAmbiguous === false && fourPm.dayPart === 'pm');

  // 2.2 "7 am"
  const sevenAm = detectClockTimeAmbiguity("Breakfast at 7 am", null, refDate, timeZone, offsetStr, "en-AU");
  assert("7 am -> unambiguous (dayPart=am)", sevenAm.isAmbiguous === false && sevenAm.dayPart === 'am');

  // 2.3 "16:00"
  const sixteen00 = detectClockTimeAmbiguity("Flight departs at 16:00", null, refDate, timeZone, offsetStr, "en-AU");
  assert("16:00 -> unambiguous 24h (dayPart=pm)", sixteen00.isAmbiguous === false && sixteen00.dayPart === 'pm');

  // 2.4 "4 in the afternoon"
  const fourAfternoon = detectClockTimeAmbiguity("Meet Alice at 4 in the afternoon", null, refDate, timeZone, offsetStr, "en-AU");
  assert("4 in the afternoon -> unambiguous (dayPart=pm)", fourAfternoon.isAmbiguous === false && fourAfternoon.dayPart === 'pm');

  // 2.5 "8 tonight"
  const eightTonight = detectClockTimeAmbiguity("Watch movie 8 tonight", null, refDate, timeZone, offsetStr, "en-AU");
  assert("8 tonight -> unambiguous (dayPart=pm)", eightTonight.isAmbiguous === false && eightTonight.dayPart === 'pm');

  console.log("\n--- 3. MULTILINGUAL DAY-PERIOD & 24-HOUR CLOCK EXPRESSIONS ---");

  // 3.1 French afternoon: "demain à 4 de l'après-midi"
  const frAfternoon = detectClockTimeAmbiguity("demain à 4 de l'après-midi", null, refDate, timeZone, offsetStr, "fr-FR");
  assert("French '4 de l'après-midi' -> unambiguous (dayPart=pm)", frAfternoon.isAmbiguous === false && frAfternoon.dayPart === 'pm');

  // 3.2 German evening: "morgen um 8 Uhr abends"
  const deEvening = detectClockTimeAmbiguity("morgen um 8 Uhr abends", null, refDate, timeZone, offsetStr, "de-DE");
  assert("German '8 Uhr abends' -> unambiguous (dayPart=pm)", deEvening.isAmbiguous === false && deEvening.dayPart === 'pm');

  // 3.3 Spanish afternoon: "mañana a las 4 de la tarde"
  const esAfternoon = detectClockTimeAmbiguity("mañana a las 4 de la tarde", null, refDate, timeZone, offsetStr, "es-ES");
  assert("Spanish '4 de la tarde' -> unambiguous (dayPart=pm)", esAfternoon.isAmbiguous === false && esAfternoon.dayPart === 'pm');

  // 3.4 Italian morning: "domani alle 7 del mattino"
  const itMorning = detectClockTimeAmbiguity("domani alle 7 del mattino", null, refDate, timeZone, offsetStr, "it-IT");
  assert("Italian '7 del mattino' -> unambiguous (dayPart=am)", itMorning.isAmbiguous === false && itMorning.dayPart === 'am');

  // 3.5 European 24-hour 'h' notation: "16h30"
  const eurH = detectClockTimeAmbiguity("Rendez-vous à 16h30", null, refDate, timeZone, offsetStr, "fr-FR");
  assert("European '16h30' -> unambiguous 24h", eurH.isAmbiguous === false && eurH.dayPart === 'pm');

  // 3.6 Chinese afternoon: "明天下午4点"
  const zhAfternoon = detectClockTimeAmbiguity("明天下午4点开会", null, refDate, timeZone, offsetStr, "zh-CN");
  assert("Chinese '下午4点' -> unambiguous (dayPart=pm)", zhAfternoon.isAmbiguous === false && zhAfternoon.dayPart === 'pm');

  // 3.7 Japanese morning: "明日午前7時に電話"
  const jaMorning = detectClockTimeAmbiguity("明日午前7時に電話", null, refDate, timeZone, offsetStr, "ja-JP");
  assert("Japanese '午前7時' -> unambiguous (dayPart=am)", jaMorning.isAmbiguous === false && jaMorning.dayPart === 'am');

  // 3.8 Multilingual localized clarification questions
  const frBare = detectClockTimeAmbiguity("demain à 4 heures", null, refDate, timeZone, offsetStr, "fr-FR");
  assert("French bare hour -> localized French question", frBare.isAmbiguous === true && Boolean(frBare.question?.includes("du matin ou")));

  const deBare = detectClockTimeAmbiguity("morgen um 4 Uhr", null, refDate, timeZone, offsetStr, "de-DE");
  assert("German bare hour -> localized German question", deBare.isAmbiguous === true && Boolean(deBare.question?.includes("morgens oder")));

  const esBare = detectClockTimeAmbiguity("mañana a las 4", null, refDate, timeZone, offsetStr, "es-ES");
  assert("Spanish bare hour -> localized Spanish question", esBare.isAmbiguous === true && Boolean(esBare.question?.includes("de la mañana o")));

  console.log("\n--- 4. LOCALE-SENSITIVE NUMERIC DATE INTERPRETATION ---");

  // 4.1 "3/9/2026" with Australian locale (en-AU, DMY) -> 3 September 2026
  const auDate = parseNumericDateWithLocale("3/9/2026", "en-AU", "AU", 2026);
  assert("3/9/2026 in en-AU -> 2026-09-03 (3 September 2026)", auDate?.isoDate === "2026-09-03" && auDate?.day === 3 && auDate?.month === 9);

  // 4.2 "3/9/2026" with US locale (en-US, MDY) -> 9 March 2026
  const usDate = parseNumericDateWithLocale("3/9/2026", "en-US", "US", 2026);
  assert("3/9/2026 in en-US -> 2026-03-09 (9 March 2026)", usDate?.isoDate === "2026-03-09" && usDate?.day === 9 && usDate?.month === 3);

  // 4.3 "25/12/2026" (value > 12 disambiguates to Day=25, Month=12 everywhere)
  const christmasDate = parseNumericDateWithLocale("25/12/2026", "en-US", "US", 2026);
  assert("25/12/2026 in en-US -> 2026-12-25 (Value > 12 correctly deduces Day=25)", christmasDate?.isoDate === "2026-12-25" && christmasDate?.day === 25 && christmasDate?.month === 12);

  // 4.4 "2026-09-03" (ISO YMD format)
  const isoFormat = parseNumericDateWithLocale("2026-09-03", "en-AU", "AU", 2026);
  assert("2026-09-03 -> 2026-09-03 (ISO format)", isoFormat?.isoDate === "2026-09-03" && isoFormat?.day === 3 && isoFormat?.month === 9);

  console.log("\n--- 5. RESOLUTION UTILITIES ---");

  // 5.1 Resolve to ISO
  const resolvedIso = resolveAmbiguousTimeToIso("2026-08-29", 4, 0, "pm", "+10:00");
  assert("resolveAmbiguousTimeToIso('2026-08-29', 4, 0, 'pm', '+10:00') -> 2026-08-29T16:00:00+10:00", resolvedIso === "2026-08-29T16:00:00+10:00");

  const resolvedIsoAm = resolveAmbiguousTimeToIso("2026-08-29", 4, 0, "am", "+10:00");
  assert("resolveAmbiguousTimeToIso('2026-08-29', 4, 0, 'am', '+10:00') -> 2026-08-29T04:00:00+10:00", resolvedIsoAm === "2026-08-29T04:00:00+10:00");

  // 5.2 Format timing string
  const formattedPm = formatTimingWithResolvedMeridiem("tomorrow at 4 o'clock", 4, 0, "pm");
  assert("formatTimingWithResolvedMeridiem('tomorrow at 4 o'clock', 4, 0, 'pm') -> 'tomorrow at 4 pm'", formattedPm.includes("4 pm"));

  console.log("\n================================================================================");
  console.log(`  CLASS C — UNIT / SYNTHETIC RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("================================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runAmbiguityTests().catch(err => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
