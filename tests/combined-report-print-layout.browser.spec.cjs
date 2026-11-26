const fs = require("node:fs");
const { test, expect } = require("@playwright/test");

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

function buildReportHtml() {
  const source = fs.readFileSync("index.html", "utf8");
  const helperStart = source.indexOf("  function shortStudentName");
  const helperEnd = source.indexOf("  function render(prefix,rows)", helperStart);
  const printStart = source.indexOf("  function printHtml(data){", helperEnd);
  const printEnd = source.indexOf("  async function print(prefix)", printStart);
  if ([helperStart, helperEnd, printStart, printEnd].some(position => position < 0)) {
    throw new Error("Unable to locate the combined report rendering functions in index.html");
  }
  const helpers = source.slice(helperStart, helperEnd);
  const printFunction = source.slice(printStart, printEnd);
  const renderPrint = new Function(
    "statusOrder", "statusName", "behaviorKeys", "SA_BEHAVIOR_TYPES",
    "statusColors", "statusTextColors", "behaviorColors", "behaviorTextColors",
    "esc", "SCHOOL_NAME", "formatClassName", "sortClassesList", "data",
    helpers + printFunction + "return printHtml(data);"
  );

  const rows = [];
  for (const className of ["9/1", "9/3"]) {
    for (let index = 1; index <= 28; index += 1) {
      const extraNote = "متابعة تفصيلية للحالة".repeat(18);
      const note = `ملاحظة مطولة للطالب ${index} في الصف ${className} تتضمن الإجراء والمتابعة ${extraNote} — دون حذف أي معلومة.`;
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
  const data = {
    rows,
    mode: "range",
    from: "2026-11-01",
    to: "2026-11-26",
    behaviors: behaviorKeys,
    cumulative: false
  };
  const html = renderPrint(
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
  return html.replace(/<script>window\.addEventListener\("load",[\s\S]*?<\/script>/, "");
}

test("Chromium prints the 9/1 and 9/3 stress reports without horizontal cell overflow", async ({ page }) => {
  fs.mkdirSync("test-results", { recursive: true });
  await page.setViewportSize({ width: 1123, height: 794 });
  await page.setContent(buildReportHtml(), { waitUntil: "load" });
  await page.emulateMedia({ media: "print" });

  const metrics = await page.evaluate(() => {
    const tables = [...document.querySelectorAll(".matrix-table")];
    const tableMetrics = tables.map(table => {
      const tableRect = table.getBoundingClientRect();
      const cells = [...table.querySelectorAll("th, td, .matrix-cell, .matrix-notes-cell, .matrix-note-line")];
      const overflow = cells.map(cell => ({
        name: cell.className?.baseVal || cell.className || cell.tagName,
        client: cell.clientWidth,
        scroll: cell.scrollWidth,
        delta: cell.scrollWidth - cell.clientWidth
      }));
      const columnWidths = [...table.querySelectorAll("colgroup col")].map(col => parseFloat(col.style.width));
      const dateSamples = [...table.querySelectorAll(".matrix-date-value")].slice(0, 3).map(node => ({
        value: node.textContent,
        direction: getComputedStyle(node).direction,
        unicodeBidi: getComputedStyle(node).unicodeBidi
      }));
      return {
        left: tableRect.left,
        right: tableRect.right,
        width: tableRect.width,
        rows: table.querySelectorAll("tbody tr").length,
        columns: columnWidths.length,
        widthTotal: columnWidths.reduce((sum, value) => sum + value, 0),
        maxCellOverflow: Math.max(0, ...overflow.map(cell => cell.delta)),
        overflowSamples: overflow.filter(cell => cell.delta > 2).slice(0, 5),
        dateSamples,
        finalColumn: table.querySelector("colgroup col:last-child")?.className
      };
    });
    return {
      viewportWidth: document.documentElement.clientWidth,
      tableMetrics,
      rows: document.querySelectorAll(".matrix-student-row").length,
      notes: [...document.querySelectorAll(".matrix-notes-cell")].map(node => node.textContent).join(" ")
    };
  });

  expect(metrics.tableMetrics).toHaveLength(2);
  expect(metrics.rows).toBe(56);
  for (const table of metrics.tableMetrics) {
    expect(table.columns).toBe(14);
    expect(table.widthTotal).toBeCloseTo(100, 2);
    expect(table.finalColumn).toBe("matrix-col-notes");
    expect(table.left).toBeGreaterThanOrEqual(-1);
    expect(table.right).toBeLessThanOrEqual(metrics.viewportWidth + 1);
    expect(table.maxCellOverflow, JSON.stringify(table.overflowSamples)).toBeLessThanOrEqual(2);
    expect(table.dateSamples[0]).toMatchObject({ value: "26/11", direction: "ltr" });
  }
  expect(metrics.notes).toContain("متابعة تفصيلية للحالة");

  const pdf = await page.pdf({
    format: "A4",
    landscape: true,
    printBackground: true,
    preferCSSPageSize: true
  });
  const pdfText = pdf.toString("latin1");
  const pageCount = (pdfText.match(/\/Type\s*\/Page\b/g) || []).length;
  expect(pdf.subarray(0, 4).toString("ascii")).toBe("%PDF");
  expect(pageCount).toBeGreaterThan(0);
  expect(pageCount).toBeLessThanOrEqual(8);

  fs.writeFileSync("test-results/combined-report-layout-stress.pdf", pdf);
  await page.screenshot({
    path: "test-results/combined-report-layout-stress.png",
    fullPage: true
  });
});
