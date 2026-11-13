/**
 * Excel timetable workbook parser.
 *
 * Converts SheetJS sheet_to_json({ header: 1, defval: null }) rows into a
 * lossless import preview. It intentionally does NOT invent weekday/period
 * placements from weekly lesson counts or teacher availability notes.
 */

export type CellValue = string | number | boolean | Date | null | undefined;
export type WorkbookRows = Record<string, CellValue[][]>;

export interface SystemTeacher {
  id?: string;
  name: string;
  departmentId?: string;
  departmentName?: string;
}

export interface ImportedTeacher {
  sourceName: string;
  normalizedName: string;
  matchedTeacherId: string | null;
  matchedTeacherName: string | null;
  matchedDepartmentId?: string | null;
  matchedDepartmentName?: string | null;
  matchStatus: "matched" | "unmatched" | "ambiguous";
  aliases: string[];
  records: ImportedLessonRecord[];
}

export interface ImportedLessonRecord {
  id: string;
  sourceSheet: string;
  sourceRow: number;
  teacherSourceName: string;
  teacherMatchStatus: ImportedTeacher["matchStatus"];
  className: string;
  groupName: string;
  subject: string;
  duration: string;
  periodsPerWeek: number | null;
  availableRooms: string;
  cycle: string;
  sharedTeachers: string;
  rooms: string;
  raw: Record<string, CellValue>;
  weekday: string | null;
  period: number | null;
}

export interface ImportedReferenceRow {
  sourceSheet: string;
  sourceRow: number;
  values: Record<string, CellValue>;
}

export interface WorkbookImportResult {
  schemaVersion: 1;
  sourceSheets: string[];
  teachers: ImportedTeacher[];
  unmatchedTeacherNames: string[];
  ambiguousTeacherNames: string[];
  unassignedRecords: ImportedLessonRecord[];
  referenceData: Record<string, ImportedReferenceRow[]>;
  placements: ImportedLessonRecord[];
  hasWeeklyPlacements: boolean;
  warnings: string[];
  totals: {
    importedTeacherRows: number;
    importedLessonRecords: number;
    referenceRows: number;
    placementRows: number;
  };
}

const SHEET_ALIASES = {
  lessons: ["الحصص", "الحصة", "الدروس"],
  classes: ["الفصول", "الشعب", "الصفوف"],
  rooms: ["الغرف الدراسية", "الغرف", "القاعات"],
  subjects: ["المواد", "المادة"],
  teachers: ["المعلمون", "المعلمين", "المعلم"],
  classContracts: ["العقود الفصول", "عقود الفصول", "عقود الشعب"],
  contracts: ["العقد", "العقود"],
} as const;

function clean(value: CellValue): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\u00a0/g, " ").replace(/[\u200e\u200f\u202a-\u202e]/g, "").trim();
}

export function normalizeArabicName(value: CellValue): string {
  return clean(value)
    .normalize("NFKC")
    .replace(/[\u064b-\u065f\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[ـ.,،؛:()\[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("ar");
}

function normalizeHeader(value: CellValue): string {
  return normalizeArabicName(value).replace(/\s+/g, "");
}

function firstValue(row: Record<string, CellValue>, candidates: string[]): string {
  const wanted = new Set(candidates.map(normalizeHeader));
  for (const [key, value] of Object.entries(row)) {
    if (wanted.has(normalizeHeader(key))) {
      const text = clean(value);
      if (text) return text;
    }
  }
  return "";
}

function findHeaderRow(rows: CellValue[][]): number {
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const values = rows[i] || [];
    const filled = values.filter((v) => clean(v)).length;
    if (filled >= 2) return i;
  }
  return -1;
}

function rowsToObjects(rows: CellValue[][]): Array<{ rowNumber: number; values: Record<string, CellValue> }> {
  const headerIndex = findHeaderRow(rows);
  if (headerIndex < 0) return [];
  const headers = (rows[headerIndex] || []).map((v, i) => clean(v) || `عمود ${i + 1}`);
  const output: Array<{ rowNumber: number; values: Record<string, CellValue> }> = [];
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const cells = rows[i] || [];
    if (!cells.some((v) => clean(v))) continue;
    const values: Record<string, CellValue> = {};
    headers.forEach((header, index) => {
      if (header) values[header] = cells[index] ?? null;
    });
    output.push({ rowNumber: i + 1, values });
  }
  return output;
}

function findSheet(sheets: WorkbookRows, aliases: readonly string[]): string | null {
  const wanted = new Set(aliases.map(normalizeArabicName));
  return Object.keys(sheets).find((name) => wanted.has(normalizeArabicName(name))) || null;
}

function valueByHeader(row: Record<string, CellValue>, candidates: string[]): CellValue {
  const wanted = new Set(candidates.map(normalizeHeader));
  for (const [key, value] of Object.entries(row)) {
    if (wanted.has(normalizeHeader(key))) return value;
  }
  return null;
}

function parseCount(value: CellValue): number | null {
  const text = clean(value).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(",", ".");
  if (!text) return null;
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function buildTeacherDirectory(
  rows: Array<{ rowNumber: number; values: Record<string, CellValue> }>,
  systemTeachers: SystemTeacher[],
): { teachers: ImportedTeacher[]; aliasMap: Map<string, Set<string>> } {
  const byId = new Map(systemTeachers.map((t) => [String(t.id ?? t.name), t]));
  const aliasMap = new Map<string, Set<string>>();
  const imported = new Map<string, ImportedTeacher>();

  for (const item of rows) {
    const name = firstValue(item.values, ["الاسم", "الإسم", "اسم"]);
    if (!name) continue;
    const shortName = firstValue(item.values, ["الاختصار", "الإختصار", "الاسم المختصر"]);
    const key = normalizeArabicName(name);
    if (!key) continue;
    const aliases = [name, shortName].filter(Boolean);
    const current = imported.get(key) || {
      sourceName: name,
      normalizedName: key,
      matchedTeacherId: null,
      matchedTeacherName: null,
      matchStatus: "unmatched" as const,
      aliases: [],
      records: [],
    };
    current.aliases = Array.from(new Set([...current.aliases, ...aliases]));
    imported.set(key, current);
  }

  for (const teacher of imported.values()) {
    const fullNameKey = normalizeArabicName(teacher.sourceName);
    const fullNameMatches = systemTeachers.filter((systemTeacher) =>
      normalizeArabicName(systemTeacher.name) === fullNameKey
    );
    const matches = new Map<string, SystemTeacher>();
    // An exact full-name match takes precedence over a short alias that may
    // coincidentally equal another teacher's full name.
    const candidates = fullNameMatches.length
      ? fullNameMatches
      : systemTeachers.filter((systemTeacher) =>
        teacher.aliases.slice(1).some((alias) =>
          normalizeArabicName(systemTeacher.name) === normalizeArabicName(alias)
        )
      );
    for (const candidate of candidates) {
      matches.set(String(candidate.id ?? candidate.name), candidate);
    }
    if (matches.size === 1) {
      const match = Array.from(matches.values())[0];
      teacher.matchedTeacherId = String(match.id ?? match.name);
      teacher.matchedTeacherName = match.name;
      teacher.matchedDepartmentId = match.departmentId || match.departmentName || null;
      teacher.matchedDepartmentName = match.departmentName || match.departmentId || null;
      teacher.matchStatus = "matched";
    } else if (matches.size > 1) {
      teacher.matchStatus = "ambiguous";
    }
    for (const alias of teacher.aliases) {
      const key = normalizeArabicName(alias);
      if (!aliasMap.has(key)) aliasMap.set(key, new Set());
      aliasMap.get(key)!.add(teacher.normalizedName);
    }
  }
  return { teachers: Array.from(imported.values()), aliasMap };
}

function identifyTeacher(
  sourceName: string,
  directory: ImportedTeacher[],
): ImportedTeacher | null {
  const key = normalizeArabicName(sourceName);
  if (!key) return null;
  const matches = directory.filter((teacher) =>
    teacher.aliases.some((alias) => normalizeArabicName(alias) === key)
  );
  return matches.length === 1 ? matches[0] : null;
}

function parseLessonRows(
  sheetName: string,
  rows: CellValue[][],
  directory: ImportedTeacher[],
): { records: ImportedLessonRecord[]; unassigned: ImportedLessonRecord[]; placements: ImportedLessonRecord[] } {
  const objects = rowsToObjects(rows);
  const records: ImportedLessonRecord[] = [];
  const unassigned: ImportedLessonRecord[] = [];
  const placements: ImportedLessonRecord[] = [];
  let inheritedTeacher = "";
  let inheritedClass = "";

  for (const item of objects) {
    const values = item.values;
    const teacherCell = firstValue(values, ["المعلم", "المعلمون", "اسم المعلم"]);
    const classCell = firstValue(values, ["الشعب", "الشعبة", "الفصل", "الصف"]);
    const subject = firstValue(values, ["المادة", "اسم المادة"]);
    const group = firstValue(values, ["المجموعة", "التقسيم"]);
    const isTeacherHeader = !!teacherCell && !classCell && !subject;
    const isClassHeader = !!classCell && !teacherCell && !subject;

    if (isTeacherHeader) {
      inheritedTeacher = teacherCell;
      continue;
    }
    if (isClassHeader) {
      inheritedClass = classCell;
      continue;
    }

    const teacherName = teacherCell || inheritedTeacher;
    const className = classCell || inheritedClass;
    if (!teacherName && !className && !subject) continue;

    const day = firstValue(values, ["اليوم", "يوم", "اليوم الدراسي"]);
    const periodText = firstValue(values, ["الحصة", "رقم الحصة", "الفترة", "رقم الفترة"]);
    const period = parseCount(periodText);
    const match = identifyTeacher(teacherName, directory);
    const record: ImportedLessonRecord = {
      id: `${normalizeArabicName(sheetName)}:${item.rowNumber}`,
      sourceSheet: sheetName,
      sourceRow: item.rowNumber,
      teacherSourceName: teacherName,
      teacherMatchStatus: match?.matchStatus || (teacherName ? "unmatched" : "unmatched"),
      className,
      groupName: group,
      subject,
      duration: firstValue(values, ["المدة", "مدة الحصة"]),
      periodsPerWeek: parseCount(valueByHeader(values, ["الحصص/الأسبوع", "الحصص الاسبوعية", "عدد الحصص"])),
      availableRooms: firstValue(values, ["الغرف الدراسية المتاحة", "الغرف المتاحة"]),
      cycle: firstValue(values, ["الدورة", "دورة"]),
      sharedTeachers: firstValue(values, ["معلم مشارك في المادة", "المعلم المشارك", "معلم مشارك"]),
      rooms: firstValue(values, ["الغرف الدراسية", "الغرفة"]),
      raw: { ...values },
      weekday: day || null,
      period: day && period !== null ? period : null,
    };
    records.push(record);
    if (match) match.records.push(record);
    else unassigned.push(record);
    if (record.weekday && record.period !== null) placements.push(record);
  }
  return { records, unassigned, placements };
}

export function parseTimetableWorkbook(
  sheets: WorkbookRows,
  systemTeachers: SystemTeacher[] = [],
): WorkbookImportResult {
  const warnings: string[] = [];
  const sourceSheets = Object.keys(sheets);
  const teacherSheet = findSheet(sheets, SHEET_ALIASES.teachers);
  const teacherRows = teacherSheet ? rowsToObjects(sheets[teacherSheet]) : [];
  const { teachers } = buildTeacherDirectory(teacherRows, systemTeachers);

  if (!teacherSheet) warnings.push("لم يتم العثور على ورقة المعلمين؛ ستحتاج مطابقة الأسماء يدوياً.");
  if (!findSheet(sheets, SHEET_ALIASES.lessons)) warnings.push("لم يتم العثور على ورقة الحصص.");

  const referenceData: Record<string, ImportedReferenceRow[]> = {};
  if (teacherSheet) {
    // Preserve all teacher-level constraints (MWD, EXH, DAYS, <a,b>, availability notes, etc.)
    // verbatim so later scheduling rules can be defined without losing source data.
    referenceData[teacherSheet] = teacherRows.map((row) => ({
      sourceSheet: teacherSheet,
      sourceRow: row.rowNumber,
      values: row.values,
    }));
  }
  for (const [key, aliases] of Object.entries(SHEET_ALIASES)) {
    const sheetName = findSheet(sheets, aliases);
    if (!sheetName || key === "teachers" || key === "lessons" || key === "contracts" || key === "classContracts") continue;
    referenceData[sheetName] = rowsToObjects(sheets[sheetName]).map((row) => ({
      sourceSheet: sheetName,
      sourceRow: row.rowNumber,
      values: row.values,
    }));
  }

  const allRecords: ImportedLessonRecord[] = [];
  const unassignedRecords: ImportedLessonRecord[] = [];
  const placements: ImportedLessonRecord[] = [];
  for (const key of ["lessons", "contracts", "classContracts"] as const) {
    const sheetName = findSheet(sheets, SHEET_ALIASES[key]);
    if (!sheetName) continue;
    const parsed = parseLessonRows(sheetName, sheets[sheetName], teachers);
    allRecords.push(...parsed.records);
    unassignedRecords.push(...parsed.unassigned);
    placements.push(...parsed.placements);
  }

  // Keep every teacher name found in lesson/contract rows visible, even when
  // the workbook's teacher directory omitted it or the system has no match.
  const unresolvedRecords: ImportedLessonRecord[] = [];
  for (const record of unassignedRecords) {
    const key = normalizeArabicName(record.teacherSourceName);
    if (!key) {
      unresolvedRecords.push(record);
      continue;
    }
    const importedMatches = teachers.filter((item) => item.aliases.some((alias) => normalizeArabicName(alias) === key));
    if (importedMatches.length > 1) {
      const ambiguousTeacher: ImportedTeacher = {
        sourceName: record.teacherSourceName,
        normalizedName: key,
        matchedTeacherId: null,
        matchedTeacherName: null,
        matchStatus: "ambiguous",
        aliases: [record.teacherSourceName],
        records: [record],
      };
      teachers.push(ambiguousTeacher);
      record.teacherMatchStatus = "ambiguous";
      unresolvedRecords.push(record);
      continue;
    }
    let teacher = importedMatches[0] || null;
    if (!teacher) {
      const systemMatches = systemTeachers.filter((item) => normalizeArabicName(item.name) === key);
      const uniqueMatch = systemMatches.length === 1 ? systemMatches[0] : null;
      teacher = {
        sourceName: record.teacherSourceName,
        normalizedName: key,
        matchedTeacherId: uniqueMatch ? String(uniqueMatch.id ?? uniqueMatch.name) : null,
        matchedTeacherName: uniqueMatch?.name ?? null,
        matchStatus: uniqueMatch ? "matched" : systemMatches.length > 1 ? "ambiguous" : "unmatched",
        aliases: [record.teacherSourceName],
        records: [],
      };
      teachers.push(teacher);
    }
    teacher.records.push(record);
    record.teacherMatchStatus = teacher.matchStatus;
    if (teacher.matchStatus !== "matched") unresolvedRecords.push(record);
  }
  unassignedRecords.splice(0, unassignedRecords.length, ...unresolvedRecords);
  const unmatchedTeacherNames = teachers.filter((t) => t.matchStatus === "unmatched").map((t) => t.sourceName);
  const ambiguousTeacherNames = teachers.filter((t) => t.matchStatus === "ambiguous").map((t) => t.sourceName);
  if (!placements.length) {
    warnings.push("لم تُعثر على أعمدة واضحة لليوم ورقم الحصة؛ عُرضت بيانات العقود والحصص دون إنشاء جدول أسبوعي افتراضي.");
  }
  if (unmatchedTeacherNames.length) warnings.push(`يوجد ${unmatchedTeacherNames.length} اسم معلم يحتاج إلى مطابقة مع سجل النظام.`);
  if (ambiguousTeacherNames.length) warnings.push(`يوجد ${ambiguousTeacherNames.length} اسم معلم ملتبس يحتاج إلى مراجعة.`);

  return {
    schemaVersion: 1,
    sourceSheets,
    teachers,
    unmatchedTeacherNames,
    ambiguousTeacherNames,
    unassignedRecords,
    referenceData,
    placements,
    hasWeeklyPlacements: placements.length > 0,
    warnings,
    totals: {
      importedTeacherRows: teachers.length,
      importedLessonRecords: allRecords.length,
      referenceRows: Object.values(referenceData).reduce((sum, rows) => sum + rows.length, 0),
      placementRows: placements.length,
    },
  };
}
