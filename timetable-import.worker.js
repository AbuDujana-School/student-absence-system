/* Heavy Excel decoding runs off the UI thread. The same SheetJS version used by the app is loaded here. */
importScripts("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js");

self.onmessage = async (event) => {
  const { fileBuffer, fileName } = event.data || {};
  try {
    if (!(fileBuffer instanceof ArrayBuffer)) throw new Error("ملف Excel غير صالح.");
    self.postMessage({ type: "progress", stage: "قراءة ملف Excel", percent: 5, processed: 0, total: 1 });
    const workbook = XLSX.read(fileBuffer, { type: "array", cellDates: true });
    const sheets = {};
    const names = workbook.SheetNames || [];
    if (!names.length) throw new Error("لا يحتوي الملف على أوراق عمل.");
    let processedRows = 0;
    let totalRows = 0;
    const parsed = names.map((name) => {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], {
        header: 1, raw: true, defval: null, blankrows: false
      });
      totalRows += rows.length;
      return { name, rows };
    });
    self.postMessage({ type: "progress", stage: "تنظيم صفوف الأوراق", percent: 15, processed: 0, total: totalRows });
    for (const sheet of parsed) {
      const compactRows = [];
      for (const row of sheet.rows) {
        let last = row.length - 1;
        while (last >= 0 && (row[last] === null || row[last] === undefined || String(row[last]).trim() === "")) last--;
        if (last >= 0) {
          compactRows.push(row.slice(0, last + 1).map(value =>
            value instanceof Date ? value.toISOString() : value
          ));
        }
        processedRows++;
        if (processedRows % 250 === 0 || processedRows === totalRows) {
          self.postMessage({
            type: "progress", stage: "تنظيم صفوف الأوراق",
            percent: 15 + Math.round((processedRows / Math.max(totalRows, 1)) * 65),
            processed: processedRows, total: totalRows
          });
        }
      }
      if (compactRows.length) sheets[sheet.name] = compactRows;
    }
    const rowCount = Object.values(sheets).reduce((sum, rows) => sum + rows.length, 0);
    if (!rowCount) throw new Error("لم يتم العثور على بيانات داخل أوراق العمل.");
    self.postMessage({ type: "complete", fileName, sheets, rowCount, sheetCount: Object.keys(sheets).length });
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : "تعذر تحليل ملف Excel." });
  }
};
