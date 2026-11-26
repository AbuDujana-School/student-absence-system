import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const helperStart = source.indexOf("  function shortStudentName");
const helperEnd = source.indexOf("  function render(prefix,rows)", helperStart);
const printStart = source.indexOf("  function printHtml(data){", helperEnd);
const printEnd = source.indexOf("  async function print(prefix)", printStart);

assert.ok(helperStart >= 0 && helperEnd > helperStart, "Combined report helpers must exist");
assert.ok(printStart >= 0 && printEnd > printStart, "Combined report printHtml must exist");

const helpers = source.slice(helperStart, helperEnd);
const printFunction = source.slice(printStart, printEnd);
const statusOrder = ["absent", "late", "outside", "escape"];
const behaviorKeys = ["eating", "talking", "tools", "chaos", "sleeping", "homework", "other"];
const labels = {
  absent: "غياب", late: "تأخر", outside: "خروج", escape: "تسرب",
  eating: "الأكل", talking: "الحديث", tools: "الأدوات", chaos: "الفوضى",
  sleeping: "النوم", homework: "الواجب", other: "أخرى"
};
const statusColors = { absent: "#eaf4ff", late: "#fef3c7", outside: "#ede9fe", escape: "#ffe4e6" };
const statusTextColors = { absent: "#334155", late: "#92400e", outside: "#5b21b6", escape: "#9f1239" };
const behaviorColors = {
  eating: "#fef3c7", talking: "#ffedd5", tools: "#fef9c3", chaos: "#fee2e2",
  sleeping: "#e0e7ff", homework: "#dbeafe", other: "#ffe4e6"
};
const behaviorTextColors = {
  eating: "#92400e", talking: "#9a3412", tools: "#854d0e", chaos: "#991b1b",
  sleeping: "#3730a3", homework: "#1e40af", other: "#9f1239"
};
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[character]));

const renderCombinedPrint = new Function(
  "statusOrder", "statusName", "behaviorKeys", "SA_BEHAVIOR_TYPES",
  "statusColors", "statusTextColors", "behaviorColors", "behaviorTextColors",
  "esc", "SCHOOL_NAME", "formatClassName", "sortClassesList", "data",
  helpers + printFunction + "return printHtml(data);"
);

function buildStressRows() {
  const rows = [];
  for (const className of ["9/1", "9/3"]) {
    for (let index = 1; index <= 28; index += 1) {
      const note = `ملاحظة طويلة للطالب ${index} في الصف ${className} & تتضمن تفاصيل المتابعة والتوجيه والإجراء دون حذف أي جزء من البيان.`;
      rows.push({
        className,
        student: `طالب تجريبي ${index}`,
        attendance: [
          { type: "absent", date: "2026-11-26", period: 3 },
          { type: "late", date: "25/11/2026", period: 1 },
          { type: "outside", date: "2026-11-24T00:00:00", period: 5 },
          { type: "escape", date: "2026-11-23", period: 2 }
        ],
        behaviors: behaviorKeys.map((type, periodIndex) => ({
          type,
          date: `2026-11-${String(26 - periodIndex).padStart(2, "0")}`,
          period: periodIndex + 1,
          note: type === "other" ? note : ""
        }))
      });
    }
  }
  return rows;
}

function createPrintMarkup() {
  const data = {
    rows: buildStressRows(),
    mode: "range",
    from: "2026-11-01",
    to: "2026-11-26",
    behaviors: behaviorKeys,
    cumulative: false
  };
  return renderCombinedPrint(
    statusOrder,
    key => labels[key],
    behaviorKeys,
    labels,
    statusColors,
    statusTextColors,
    behaviorColors,
    behaviorTextColors,
    escapeHtml,
    "مدرسة أبو دجانة الأنصاري",
    value => value,
    classes => classes.sort((a, b) => a.localeCompare(b, "ar")),
    data
  );
}

test("combined report print keeps day/month dates isolated in LTR order", () => {
  const markup = createPrintMarkup();
  assert.ok(markup.includes('<bdi class="matrix-date-value" dir="ltr">26/11</bdi>'));
  assert.ok(markup.includes('<bdi class="matrix-date-value" dir="ltr">25/11</bdi>'));
  assert.ok(markup.includes('<bdi class="matrix-date-value" dir="ltr">24/11</bdi>'));
  assert.ok(markup.includes('<span class="matrix-date-prefix">ت:</span>'));
  assert.ok(markup.includes('<span class="matrix-period-prefix">ح:</span>'));
});

test("all data columns, including the last other/notes column, have fixed proportional widths", () => {
  const markup = createPrintMarkup();
  const columnGroups = [...markup.matchAll(/<colgroup>([\s\S]*?)<\/colgroup>/g)];
  assert.equal(columnGroups.length, 2, "Both tested classes must produce their own table");
  for (const [, group] of columnGroups) {
    const widths = [...group.matchAll(/style="width:([\d.]+)%"/g)].map(match => Number(match[1]));
    assert.equal(widths.length, 14, "Number, student, 11 reporting categories, and notes columns must all be present");
    assert.ok(Math.abs(widths.reduce((sum, width) => sum + width, 0) - 100) < 0.001, "Column widths must exactly fill the printable table");
    assert.match(group, /<col class="matrix-col-notes" style="width:14\.8%"><\/colgroup>$/);
  }
  assert.equal((markup.match(/class="matrix-student-row"/g) || []).length, 56);
  assert.equal((markup.match(/class="matrix-notes-cell"/g) || []).length, 56);
});

test("long notes remain in the output and wrap without spilling into adjacent cells", () => {
  const markup = createPrintMarkup();
  assert.ok(markup.includes("تتضمن تفاصيل المتابعة والتوجيه والإجراء دون حذف أي جزء من البيان."));
  assert.ok(markup.includes("class=\"matrix-notes-cell\""));
  assert.ok(markup.includes("overflow-wrap:anywhere!important"));
  assert.ok(markup.includes("min-width:0!important"));
  assert.ok(markup.includes("word-break:normal!important"));
});

test("print pagination remains compact and uses the same scale for every student", () => {
  const markup = createPrintMarkup();
  assert.equal((markup.match(/class="class-sheet"/g) || []).length, 2);
  assert.doesNotMatch(markup, /<section class="class-sheet" style="zoom:/);
  assert.match(markup, /\.matrix-table tr\{break-inside:avoid!important;page-break-inside:avoid!important\}/);
  assert.match(markup, /\.matrix-table thead\{display:table-header-group!important\}/);
  assert.match(markup, /@page\{size:A4 landscape;margin:6mm 6mm 8mm\}/);
});
