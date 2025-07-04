// test/reactive.test.ts

import { describe, it, expect } from 'bun:test';
import { SatiDB, z } from '../satidb';

// Forward-declare schemas to handle circular dependencies in lazy loading
let StudentSchema: z.ZodObject<any>;
let CourseSchema: z.ZodObject<any>;
let EnrollmentSchema: z.ZodObject<any>;

// Define schemas with explicit relationships using z.lazy
StudentSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  enrollments: z.lazy(() => z.array(EnrollmentSchema)).optional(),
});

CourseSchema = z.object({
  id: z.string().optional(),
  title: z.string(),
  enrollments: z.lazy(() => z.array(EnrollmentSchema)).optional(),
});

EnrollmentSchema = z.object({
  id: z.string().optional(),
  grade: z.string().optional(),
  student: z.lazy(() => StudentSchema).optional(),
  course: z.lazy(() => CourseSchema).optional(),
});


describe('SatiDB - Unified Core Showcase', () => {
  it('should demonstrate all core features including upsert and eager loading', () => {
    const db = new SatiDB(':memory:', {
      students: StudentSchema,
      courses: CourseSchema,
      enrollments: EnrollmentSchema,
    }) as any; // Use `as any` for simpler property access in the test

    let updatedEnrollmentFromSub: any = null;
    db.enrollments.subscribe('update', (updatedData: any) => {
      console.log(`[Subscription] Enrollment updated. New grade: ${updatedData.grade}`);
      updatedEnrollmentFromSub = updatedData;
    });

    const alice = db.students.insert({ name: 'Alice' });
    const math = db.courses.insert({ title: 'Calculus I' });
    const history = db.courses.insert({ title: 'World History' });
    console.log(`[Insert] Created student "${alice.name}" and two courses.`);

    // Use the relationship manager to insert enrollments
    const mathEnrollment = alice.enrollments.insert({ courseId: math.id, grade: 'In Progress' });
    alice.enrollments.insert({ courseId: history.id, grade: 'In Progress' });
    console.log(`[Insert] Enrolled "${alice.name}" in two courses via relationship manager.`);

    console.log(`\n[Reactively Editing] Updating the grade for the math course...`);
    mathEnrollment.grade = 'A'; // This triggers the proxy's 'set' handler
    console.log(` -> New grade set directly on the enrollment object: "${mathEnrollment.grade}"`);

    // Check if the subscription was triggered by the reactive update
    expect(updatedEnrollmentFromSub).not.toBeNull();
    expect(updatedEnrollmentFromSub.id).toBe(mathEnrollment.id);
    expect(updatedEnrollmentFromSub.grade).toBe('A');

    // Test upsert - update existing enrollment
    const updatedMathEnrollment = alice.enrollments.upsert({ courseId: math.id }, { grade: 'A+' });
    expect(updatedMathEnrollment.grade).toBe('A+');
    expect(updatedMathEnrollment.id).toBe(mathEnrollment.id);

    // Test upsert - insert new enrollment (this was the failing part)
    const spanish = db.courses.insert({ title: 'Spanish I' });
    const upsertedNew = alice.enrollments.upsert({ courseId: spanish.id }, { grade: 'B' });
    console.log(`[Upsert] New enrollment for Spanish. Grade: ${upsertedNew.grade}, Course ID: ${upsertedNew.courseId}`);
    expect(upsertedNew.courseId).toBe(spanish.id);
    expect(upsertedNew.grade).toBe('B');

    // Query with LAZY loading (the original way)
    console.log(`\n[Query - Lazy] What courses is "${alice.name}" taking?`);
    const aliceEnrollmentsLazy = alice.enrollments.find({ $sortBy: 'grade:desc' });
    const aliceCoursesLazy = aliceEnrollmentsLazy.map((e: any) => e.course()); // This makes N+1 queries
    const courseTitlesLazy = aliceCoursesLazy.map((c: any) => c.title).sort();
    console.log(` -> Courses: [${courseTitlesLazy.join(', ')}]`);
    expect(courseTitlesLazy).toEqual(['Calculus I', 'Spanish I', 'World History']);

    // Query with EAGER loading (the new $include way)
    console.log(`\n[Query - Eager] What courses is "${alice.name}" taking with $include?`);
    const aliceEnrollmentsEager = alice.enrollments.find({ $sortBy: 'grade:desc', $include: ['course', 'student'] });
    const courseTitlesEager = aliceEnrollmentsEager.map((e: any) => e.course.title).sort(); // No function call, access property directly
    console.log(` -> Courses: [${courseTitlesEager.join(', ')}]`);
    console.log(` -> Student on first enrollment: ${aliceEnrollmentsEager[0].student.name}`);
    expect(courseTitlesEager).toEqual(['Calculus I', 'Spanish I', 'World History']);
    expect(aliceEnrollmentsEager[0].course.title).toBeDefined();
    expect(aliceEnrollmentsEager[0].student.name).toBe('Alice');
    
    // Check that the included property is an object, not a function
    expect(typeof aliceEnrollmentsEager[0].course).toBe('object');
    // And trying to call it as a function should fail
    expect(typeof aliceEnrollmentsEager[0].course).not.toBe('function');


    // Query through the junction table (Course -> Students)
    const bob = db.students.insert({ name: 'Bob' });
    bob.enrollments.insert({ courseId: math.id, grade: 'A' });
    console.log(`\n[Query] Who is taking "${math.title}"?`);
    // Alice's grade for math is now 'A+', so only Bob should appear in a search for 'A'
    const mathStudents = math.enrollments.find({ grade: 'A' }).map((e: any) => e.student());
    const studentNames = mathStudents.map((s: any) => s.name).sort();
    console.log(` -> Students: [${studentNames.join(', ')}]`);
    expect(studentNames).toEqual(['Bob']);

    console.log('\n✅ All core library features demonstrated successfully!');
  });
});