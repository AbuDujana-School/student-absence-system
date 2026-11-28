export const SCHOOL_DAYS = ["الأحد","الاثنين","الثلاثاء","الأربعاء","الخميس"] as const;
export function academicYearKey(isoDate:string):string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) throw new Error("Invalid Oman-local date");
  const year=Number(isoDate.slice(0,4)), month=Number(isoDate.slice(5,7));
  return month>=9 ? year+"/"+(year+1) : (year-1)+"/"+year;
}
export function isWithinTeacherRegistrationWindow(minutes:number):boolean {
  return Number.isFinite(minutes) && minutes>=420 && minutes<=510;
}
export function isTeacherEligibleForMorningLateness(input:{
  dutyToday:boolean; weekday:string; assignedDutyDay:string; minutes:number;
}):boolean {
  return input.dutyToday!==false
    && SCHOOL_DAYS.includes(input.weekday as typeof SCHOOL_DAYS[number])
    && input.assignedDutyDay===input.weekday
    && isWithinTeacherRegistrationWindow(input.minutes);
}
export function isNonDutyTeacherEligibleForMorningLateness(input:{
  permission:boolean; weekday:string; minutes:number;
}):boolean {
  return input.permission===true
    && SCHOOL_DAYS.includes(input.weekday as typeof SCHOOL_DAYS[number])
    && isWithinTeacherRegistrationWindow(input.minutes);
}
export function latenessAbsenceDays(count:number):number {
  return Math.floor(Math.max(0,Math.trunc(Number(count)||0))/4);
}

export function canUseMorningLateness(input: {
  principalType: "admin" | "teacher" | "custom";
  permission: boolean;
  nonDutyPermission?: boolean;
  dutyToday: boolean;
  weekday: string;
  assignedDutyDay: string;
  minutes: number;
}): boolean {
  if (input.principalType === "admin") return true;
  if (input.principalType === "custom") return input.permission === true;
  if (input.principalType !== "teacher") return false;
  if (isTeacherEligibleForMorningLateness({
    dutyToday: input.dutyToday,
    weekday: input.weekday,
    assignedDutyDay: input.assignedDutyDay,
    minutes: input.minutes,
  })) return true;
  return isNonDutyTeacherEligibleForMorningLateness({
    permission: input.nonDutyPermission === true,
    weekday: input.weekday,
    minutes: input.minutes,
  });
}

export function canViewMorningLatenessReport(input:{principalType:"admin"|"teacher"|"custom"; nonDutyPermission?:boolean; customPermission?:boolean; adminRecordsCenterAccess?:boolean}):boolean {
  if (input.principalType === "admin" || input.adminRecordsCenterAccess === true) return true;
  if (input.principalType === "custom") return input.customPermission === true;
  if (input.principalType === "teacher") return input.nonDutyPermission === true;
  return false;
}
