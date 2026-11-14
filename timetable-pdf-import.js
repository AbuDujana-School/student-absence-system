/* PDF.js adapter: reads text and vector grid paths before the pure parser runs. */
(function () {
  const PDFJS_VERSION="4.10.38";
  let pdfjsPromise;
  async function loadPdfJs(){
    if(!pdfjsPromise)pdfjsPromise=import("https://cdn.jsdelivr.net/npm/pdfjs-dist@"+PDFJS_VERSION+"/build/pdf.min.mjs")
      .then(pdfjs=>{pdfjs.GlobalWorkerOptions.workerSrc="https://cdn.jsdelivr.net/npm/pdfjs-dist@"+PDFJS_VERSION+"/build/pdf.worker.min.mjs";return pdfjs;});
    return pdfjsPromise;
  }
  function normalizeDigits(value){return String(value||"").replace(/[٠-٩۰-۹]/g,digit=>String("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹".indexOf(digit)%10));}
  function normalizeArabic(value){return normalizeDigits(String(value||"").normalize("NFKC")).replace(/[\u064b-\u065f\u0670\u0640]/g,"").replace(/[أإآٱ]/g,"ا").replace(/[\u200e\u200f\u202a-\u202e]/g,"").replace(/\s+/g," ").trim();}
  function isArabicTeacherName(item){const x=Number(item.transform?.[4]),value=normalizeArabic(item.str);return Number.isFinite(x)&&x>=0&&x<58&&/[\u0600-\u06ff]/.test(value)&&value.length>=3;}
  function getItemSnapshot(item){return {str:String(item.str||""),transform:Array.isArray(item.transform)?item.transform.map(Number):[],width:Number(item.width)||0,height:Number(item.height)||0};}
  async function parseFile(file,onProgress){
    if(!(file instanceof File)||file.size<=0)throw new Error("ملف PDF فارغ أو غير صالح.");
    if(file.size>20*1024*1024)throw new Error("حجم ملف PDF يتجاوز 20 ميجابايت.");
    if(!/\.pdf$/i.test(file.name)&&file.type!=="application/pdf")throw new Error("اختر ملفاً بصيغة PDF فقط.");
    const buffer=await file.arrayBuffer(),header=new TextDecoder("latin1").decode(new Uint8Array(buffer.slice(0,5)));
    if(header!=="%PDF-")throw new Error("محتوى الملف لا يطابق صيغة PDF.");
    const pdfjs=await loadPdfJs(),parser=await import("./timetable_pdf_import.js");
    const loadingTask=pdfjs.getDocument({data:new Uint8Array(buffer),useSystemFonts:true,isEvalSupported:false});
    const document=await loadingTask.promise;
    try{
      if(!document.numPages||document.numPages>150)throw new Error("يجب أن يحتوي الملف على 1 إلى 150 صفحة.");
      const pages=[];
      for(let pageNumber=1;pageNumber<=document.numPages;pageNumber++){
        const page=await document.getPage(pageNumber),viewport=page.getViewport({scale:1,rotation:0});
        const [textContent,operatorList]=await Promise.all([
          page.getTextContent({includeMarkedContent:false,disableNormalization:true}),
          page.getOperatorList(),
        ]);
        const items=(textContent.items||[]).filter(item=>typeof item.str==="string"&&item.str.trim()&&Array.isArray(item.transform)).map(getItemSnapshot);
        const horizontalLines=parser.extractHorizontalLinesFromOperatorList(operatorList,pdfjs.OPS);
        const verticalLines=parser.extractVerticalLinesFromOperatorList(operatorList,pdfjs.OPS);
        const teacherItems=items.filter(isArabicTeacherName);
        const hasTimeRows=items.filter(item=>/\d{1,2}:\d{2}/.test(normalizeDigits(item.str))).length>=7;
        if(pageNumber>1&&(!teacherItems.length||!hasTimeRows||items.length<12))throw new Error("تعذر التحقق من محتوى الصفحة "+pageNumber+". قد تكون ممسوحة ضوئياً أو غير مطابقة لتخطيط الجدول؛ لم يتم تجاوزها.");
        pages.push({pageNumber,width:viewport.width,height:viewport.height,items,horizontalLines,verticalLines});
        if(typeof onProgress==="function")onProgress({page:pageNumber,total:document.numPages,percent:Math.round(pageNumber/document.numPages*100),message:"قراءة صفحة "+pageNumber+" من "+document.numPages});
        page.cleanup();
      }
      const parsed=parser.parseTimetablePdfPages(pages);
      if(parsed.diagnostics.blockingErrors.length)throw new Error(parsed.diagnostics.blockingErrors.slice(0,5).join("\n"));
      return parsed;
    }finally{await document.destroy();}
  }
  window.TimetablePdfImporter=Object.freeze({parseFile});
})();
