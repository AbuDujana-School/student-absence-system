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
async function parseWorkbookInWorker(buffer) {
  try {
    const MAX_FILE_BYTES = 20 * 1024 * 1024;
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) {
      throw new Error("ملف Excel فارغ أو غير صالح.");
    }
    if (buffer.byteLength > MAX_FILE_BYTES) {
      throw new Error("حجم الملف يتجاوز 20 ميجابايت. قسّم الملف ثم أعد المحاولة.");
    }
    if (typeof XLSX === "undefined") {
      importScripts("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js");
    }
    const workbook=XLSX.read(buffer,{type:"array",cellDates:true});
    const sheets={};
    const names=workbook.SheetNames||[];
    if (!names.length || names.length > 20) throw new Error("يجب أن يحتوي الملف على ورقة واحدة إلى 20 ورقة.");
    let rowCount=0, cellCount=0;
    for(let index=0;index<names.length;index++){
      const sheetName=names[index];
      if (typeof sheetName !== "string" || !sheetName.trim() || sheetName.length > 120) {
        throw new Error("اسم إحدى أوراق العمل غير صالح.");
      }
      const worksheet=workbook.Sheets[sheetName];
      const rawRows=XLSX.utils.sheet_to_json(worksheet,{header:1,raw:true,defval:null,blankrows:false});
      if (rawRows.length > 5000 || rowCount + rawRows.length > 5000) {
        throw new Error("تجاوز الملف الحد المسموح وهو 5000 صف.");
      }
      const compactRows=[];
      for(const row of rawRows){
        if (!Array.isArray(row)) throw new Error("توجد بنية صف غير صالحة في ورقة " + sheetName + ".");
        let last=row.length-1;
        while(last>=0&&(row[last]===null||row[last]===undefined||String(row[last]).trim()===""))last--;
        if(last<0) continue;
        const compact=row.slice(0,last+1).map(value=>{
          if (typeof value === "string" && value.length > 10000) {
            throw new Error("يوجد نص يتجاوز 10000 حرف في ورقة " + sheetName + ".");
          }
          if (typeof value === "number" && !Number.isFinite(value)) {
            throw new Error("توجد قيمة رقمية غير صالحة في ورقة " + sheetName + ".");
          }
          if (value !== null && value !== undefined && !["string","number","boolean"].includes(typeof value) && !(value instanceof Date)) {
            throw new Error("توجد قيمة خلية غير مدعومة في ورقة " + sheetName + ".");
          }
          return value instanceof Date ? value.toISOString() : value;
        });
        cellCount += compact.length;
        if (cellCount > 100000) throw new Error("تجاوز الملف الحد المسموح وهو 100000 خلية.");
        compactRows.push(compact);
      }
      rowCount += rawRows.length;
      if(compactRows.length) sheets[sheetName]=compactRows;
      self.postMessage({type:"progress",processed:index+1,total:names.length,percent:Math.round((index+1)/Math.max(names.length,1)*100),message:"قراءة الورقة "+(index+1)+" من "+names.length+": "+sheetName});
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    const compactRowCount=Object.values(sheets).reduce((sum,rows)=>sum+rows.length,0);
    if (!compactRowCount) throw new Error("لم يتم العثور على بيانات داخل أوراق العمل.");
    self.postMessage({type:"complete",sheets,rowCount:compactRowCount,cellCount,sheetCount:names.length});
  } catch(error) {
    self.postMessage({type:"error",message:error?.message||"تعذر قراءة ملف Excel داخل العامل."});
  }
}
const timetableTextWorkerHandler=self.onmessage;
self.onmessage=(event)=>{
  if(event.data?.type==="parseWorkbook"){void parseWorkbookInWorker(event.data.buffer);return;}
  if(typeof timetableTextWorkerHandler==="function")void timetableTextWorkerHandler(event);
};
