/* Isolated preflight for large pasted timetable text. No credentials or user records are sent here. */
self.onmessage = async (event) => {
  const text = String(event.data?.text || "");
  const chunkSize = 400;
  const lines = text.split(/\r?\n/);
  const issues = [];
  const seen = new Set();
  const weekdays = new Set(["الأحد","الاثنين","الثلاثاء","الأربعاء","الخميس"]);
  let tabularRows = 0;
  for (let start = 0; start < lines.length; start += chunkSize) {
    const end = Math.min(lines.length, start + chunkSize);
    for (let i = start; i < end; i++) {
      const raw = lines[i];
      if (!raw.includes("\t")) continue;
      const fields = raw.split("\t").map(value => value.trim());
      if (fields.length < 6) continue;
      const day = fields[1];
      if (!weekdays.has(day)) continue;
      tabularRows++;
      const period = Number(fields[2]);
      if (!Number.isInteger(period) || period < 1 || period > 7) {
        issues.push({line:i+1,message:"رقم الحصة يجب أن يكون من 1 إلى 7"});
        continue;
      }
      if (!fields[0]) issues.push({line:i+1,message:"اسم المعلم فارغ"});
      const key = fields.map(value => value.normalize("NFKC").replace(/\s+/g," ").trim()).join("|");
      if (seen.has(key)) issues.push({line:i+1,message:"تكرار الصف نفسه"});
      seen.add(key);
    }
    self.postMessage({type:"progress",processed:end,total:lines.length,percent:Math.round(end/Math.max(lines.length,1)*100)});
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  self.postMessage({type:"complete",lineCount:lines.length,tabularRows,issues:issues.slice(0,100),issueCount:issues.length});
};