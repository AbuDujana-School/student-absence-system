import { assertEquals } from "jsr:@std/assert";
import { projectAssignedClassScope } from "./app_data_gateway_scope.ts";

Deno.test("scope includes only exact teacher matched teaching classes", () => {
  assertEquals(projectAssignedClassScope([
    { matched_teacher_name: "Teacher A", match_status: "matched", cell_status: "teaching", class_sections: ["5/1", "5/2"] },
    { matched_teacher_name: "Teacher B", match_status: "matched", cell_status: "teaching", class_sections: ["6/1"] },
    { matched_teacher_name: "Teacher A", match_status: "unmatched", cell_status: "teaching", class_sections: ["7/1"] },
    { matched_teacher_name: "Teacher A", match_status: "matched", cell_status: "free", class_sections: ["8/1"] },
  ], "Teacher A"), ["5/1", "5/2"]);
});

Deno.test("scope deduplicates, trims, and rejects malformed class sections", () => {
  assertEquals(projectAssignedClassScope([
    { matched_teacher_name: "Teacher A", match_status: "matched", cell_status: "teaching", class_sections: [" 5/1 ", "5/1", "", 42, "x".repeat(121)] },
    { matched_teacher_name: "Teacher A", match_status: "matched", cell_status: "teaching", class_sections: ["4/2"] },
  ], "Teacher A"), ["4/2", "5/1"]);
});

Deno.test("scope fails closed for blank or non-matching principal", () => {
  const rows = [{ matched_teacher_name: "Teacher A", match_status: "matched", cell_status: "teaching", class_sections: ["5/1"] }];
  assertEquals(projectAssignedClassScope(rows, ""), []);
  assertEquals(projectAssignedClassScope(rows, "teacher a"), []);
  assertEquals(projectAssignedClassScope(rows, "Teacher B"), []);
});

Deno.test("scope ignores invalid rows and non-array class sections", () => {
  assertEquals(projectAssignedClassScope([
    null as never,
    { matched_teacher_name: "Teacher A", match_status: "matched", cell_status: "teaching", class_sections: "5/1" },
    { matched_teacher_name: "Teacher A", match_status: "matched", cell_status: "teaching", class_sections: [null, {}, "6/1"] },
  ], "Teacher A"), ["6/1"]);
});


Deno.test("explicit school-affairs scopes remain separate from general student roster scope", () => {
  assertEquals(mergeAppDataClassScopes(["5/1"], {
    allowed_classes: ["6/1"],
    allowed_attendance_classes: ["7/1"],
    allowed_behavior_classes: ["8/1"],
  }), {
    allowedClasses: ["5/1", "6/1"],
    allowedAttendanceClasses: ["5/1", "7/1"],
    allowedBehaviorClasses: ["5/1", "8/1"],
  });
});

Deno.test("explicit grants remain usable when no active timetable assignment exists", () => {
  assertEquals(mergeAppDataClassScopes([], {
    allowed_classes: ["6/1"],
    allowed_attendance_classes: ["7/1"],
    allowed_behavior_classes: ["8/1"],
  }), {
    allowedClasses: ["6/1"],
    allowedAttendanceClasses: ["7/1"],
    allowedBehaviorClasses: ["8/1"],
  });
});

Deno.test("legacy general class grants are fallback only when specialized arrays are absent", () => {
  assertEquals(mergeAppDataClassScopes([], {
    allowed_classes: ["6/1", "6/1"],
    allowed_attendance_classes: null,
    allowed_behavior_classes: [],
  }), {
    allowedClasses: ["6/1"],
    allowedAttendanceClasses: ["6/1"],
    allowedBehaviorClasses: [],
  });
});
