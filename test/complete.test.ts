// test/reactive.test.ts

import { describe, it, expect } from 'bun:test';
import { SatiDB, z } from '../satidb';

const StudentSchema = z.object({
  name: z.string(),
});
const CourseSchema = z.object({
  title: z.string(),
});
const EnrollmentSchema = z.object({
  student: z.lazy(() => StudentSchema).optional(),
  course: z.lazy(() => CourseSchema).optional(),
  grade: z.string().optional(),
});

describe('SatiDB - Unified Core Showcase', () => {
  it('should demonstrate all core features in a single M-M scenario', () => {
    const db = new SatiDB(':memory:', {
      students: StudentSchema,
      courses: CourseSchema,
      enrollments: EnrollmentSchema,
    });

    let updatedEnrollmentFromSub: any = null;

    db.enrollments.subscribe('update', (updatedData) => {
      console.log(`[Subscription] Enrollment updated. New grade: ${updatedData.grade}`);
      updatedEnrollmentFromSub = updatedData;
    });

    const alice = db.students.insert({ name: 'Alice' });
    const math = db.courses.insert({ title: 'Calculus I' });
    const history = db.courses.insert({ title: 'World History' });
    console.log(`[Insert] Created student "${alice.name}" and two courses.`);

    // Use insert instead of push for the relationship manager
    const mathEnrollment = alice.enrollments.insert({ courseId: math.id, grade: 'In Progress' });
    alice.enrollments.insert({ courseId: history.id, grade: 'In Progress' });
    console.log(`[Insert] Enrolled "${alice.name}" in two courses.`);

    console.log(`\n[Reactively Editing] Updating the grade for the math course...`);
    mathEnrollment.grade = 'A';
    console.log(` -> New grade set directly on the enrollment object: "${mathEnrollment.grade}"`);

    expect(updatedEnrollmentFromSub).not.toBeNull();
    expect(updatedEnrollmentFromSub.grade).toBe('A');

    // Query Through the Junction Table (Student -> Courses)
    console.log(`\n[Query] What courses is "${alice.name}" taking?`);
    const aliceEnrollments = alice.enrollments.find({ $limit: 2, $offset: 0, $sortBy: 'grade:desc' });
    const aliceCourses = aliceEnrollments.map(e => e.course());
    const courseTitles = aliceCourses.map(c => c.title).sort();
    console.log(` -> Courses: [${courseTitles.join(', ')}]`);
    expect(courseTitles).toEqual(['Calculus I', 'World History']);

    // Query Through the Junction Table (Course -> Students)
    const bob = db.students.insert({ name: 'Bob' });
    bob.enrollments.insert({ courseId: math.id, grade: 'A' });
    console.log(`\n[Query] Who is taking "${math.title}"?`);
    const mathStudents = math.enrollments.find({ grade: 'A' }).map(e => e.student());
    const studentNames = mathStudents.map(s => s.name).sort();
    console.log(` -> Students: [${studentNames.join(', ')}]`);
    expect(studentNames).toEqual(['Alice', 'Bob']);

    console.log('\n✅ All core library features demonstrated successfully!');
  });

  it('should support full CRUD operations on relationship managers', () => {
    const db = new SatiDB(':memory:', {
      students: StudentSchema,
      courses: CourseSchema,
      enrollments: EnrollmentSchema,
    });

    const alice = db.students.insert({ name: 'Alice' });
    const math = db.courses.insert({ title: 'Calculus I' });
    const history = db.courses.insert({ title: 'World History' });
    const physics = db.courses.insert({ title: 'Physics I' });

    // Test insert
    const mathEnrollment = alice.enrollments.insert({ courseId: math.id, grade: 'In Progress' });
    const historyEnrollment = alice.enrollments.insert({ courseId: history.id, grade: 'B+' });
    const physicsEnrollment = alice.enrollments.insert({ courseId: physics.id, grade: 'A-' });

    // Test find
    const aliceEnrollments = alice.enrollments.find();
    expect(aliceEnrollments.length).toBe(3);

    // Test get with string id
    const foundMathEnrollment = alice.enrollments.get(mathEnrollment.id);
    expect(foundMathEnrollment?.grade).toBe('In Progress');

    // Test get with conditions
    const foundHistoryEnrollment = alice.enrollments.get({ grade: 'B+' });
    expect(foundHistoryEnrollment?.courseId).toBe(history.id);

    // Test update via relationship manager
    const updatedEnrollment = alice.enrollments.update(mathEnrollment.id, { grade: 'A+' });
    expect(updatedEnrollment?.grade).toBe('A+');

    // Test upsert - update existing
    const upsertedExisting = alice.enrollments.upsert({ courseId: history.id }, { grade: 'A' });
    expect(upsertedExisting.grade).toBe('A');

    // Test upsert - insert new
    const spanish = db.courses.insert({ title: 'Spanish I' });
    const upsertedNew = alice.enrollments.upsert({ courseId: spanish.id }, { grade: 'B' });
    console.log("upsertedNew", upsertedNew)
    expect(upsertedNew.courseId).toBe(spanish.id);
    expect(upsertedNew.grade).toBe('B');

    // Test delete with id
    alice.enrollments.delete(physicsEnrollment.id);
    const remainingEnrollments = alice.enrollments.find();
    expect(remainingEnrollments.length).toBe(3); // math, history, spanish

    // Test delete all related entities (without id)
    alice.enrollments.delete();
    const finalEnrollments = alice.enrollments.find();
    expect(finalEnrollments.length).toBe(0);

    console.log('\n✅ Full CRUD operations on relationship managers working correctly!');
  });

  it('should support subscription on relationship managers', () => {
    const db = new SatiDB(':memory:', {
      students: StudentSchema,
      courses: CourseSchema,
      enrollments: EnrollmentSchema,
    });

    const alice = db.students.insert({ name: 'Alice' });
    const math = db.courses.insert({ title: 'Calculus I' });

    let insertedEnrollment: any = null;
    let updatedEnrollment: any = null;
    let deletedEnrollment: any = null;

    // Test subscription on relationship manager
    alice.enrollments.subscribe('insert', (data) => {
      insertedEnrollment = data;
    });

    alice.enrollments.subscribe('update', (data) => {
      updatedEnrollment = data;
    });

    alice.enrollments.subscribe('delete', (data) => {
      deletedEnrollment = data;
    });

    // Test insert subscription
    const mathEnrollment = alice.enrollments.insert({ courseId: math.id, grade: 'In Progress' });
    expect(insertedEnrollment).not.toBeNull();
    expect(insertedEnrollment.grade).toBe('In Progress');

    // Test update subscription
    alice.enrollments.update(mathEnrollment.id, { grade: 'A+' });
    expect(updatedEnrollment).not.toBeNull();
    expect(updatedEnrollment.grade).toBe('A+');

    // Test delete subscription
    alice.enrollments.delete(mathEnrollment.id);
    expect(deletedEnrollment).not.toBeNull();
    expect(deletedEnrollment.id).toBe(mathEnrollment.id);

    console.log('\n✅ Subscription on relationship managers working correctly!');
  });
});