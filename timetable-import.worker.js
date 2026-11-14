/* Isolated workbook parsing worker. XLSX parsing never runs on the UI thread. */
importScripts("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js");
self.onmessage = function(event) {
  const buffer = event.data && event.data.buffer;
  const fileName = String(event.data && event.data.fileName || "workbook.xlsx");
  try {
    if (!(buffer instanceof ArrayBuffer)) throw new Error("تعذر قراءة ملف Excel.");
    self.postMessage({type:"progress",percent:3,stage:"قراءة الملف"});
    const workbook = XLSX.read(buffer,{type:"array",cellDates:true,cellFormula:false,cellHTML:false});
    const names = workbook.SheetNames || [];
    if (!names.length) throw new Error("لا يحتوي الملف على أوراق عمل.");
    const sheets = {};
    const ranges = names.map(name => {
      const ref = workbook.Sheets[name] && workbook.Sheets[name]["!ref"];
      if (!ref) return 0;
      const range = XLSX.utils.decode_range(ref);
      return Math.max(0,range.e.r-range.s.r+1);
    });
    const totalRows = Math.max(1,ranges.reduce((sum,n)=>sum+n,0));
    let completedRows = 0;
    for (let sheetIndex=0;sheetIndex<names.length;sheetIndex++) {
      const sheetName=names[sheetIndex];
      const worksheet=workbook.Sheets[sheetName];
      if(!worksheet)continue;
      const rawRows=XLSX.utils.sheet_to_json(worksheet,{header:1,raw:true,defval:null,blankrows:false});
      const compactRows=[];
      for(let rowIndex=0;rowIndex<rawRows.length;rowIndex++){
        const row=rawRows[rowIndex];
        let last=row.length-1;
        while(last>=0&&(row[last]===null||row[last]===undefined||String(row[last]).trim()===""))last--;
        if(last>=0)compactRows.push(row.slice(0,last+1).map(value=>value instanceof Date?value.toISOString():value));
        completedRows++;
        if(rowIndex%100===0){
          const percent=Math.min(94,Math.round(8+(completedRows/totalRows)*84));
          self.postMessage({type:"progress",percent,stage:"تحليل ورقة "+(sheetIndex+1)+" من "+names.length+" — "+sheetName});
        }
      }
      if(compactRows.length)sheets[sheetName]=compactRows;
    }
    const rowCount=Object.keys(sheets).reduce((sum,name)=>sum+sheets[name].length,0);
    if(!rowCount)throw new Error("لم يتم العثور على بيانات داخل أوراق العمل.");
    self.postMessage({type:"progress",percent:100,stage:"اكتمل تحليل الملف"});
    self.postMessage({type:"complete",fileName,sheets,rowCount});
  } catch(error) {
    self.postMessage({type:"error",message:error&&error.message?error.message:"تعذر تحليل ملف Excel داخل العامل الخلفي."});
  }
};
