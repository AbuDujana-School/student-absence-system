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
  permission:boolean; dutyToday:boolean; weekday:string; assignedDutyDay:string; minutes:number;
}):boolean {
  return input.permission===true
    && input.dutyToday!==false
    && SCHOOL_DAYS.includes(input.weekday as typeof SCHOOL_DAYS[number])
    && input.assignedDutyDay===input.weekday
    && isWithinTeacherRegistrationWindow(input.minutes);
}
export function latenessAbsenceDays(count:number):number {
  return Math.floor(Math.max(0,Math.trunc(Number(count)||0))/4);
}
