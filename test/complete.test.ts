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

    const mathEnrollment = alice.enrollments.push({ courseId: math.id, grade: 'In Progress' });
    alice.enrollments.push({ courseId: history.id, grade: 'In Progress' });
    console.log(`[Push] Enrolled "${alice.name}" in two courses.`);

    console.log(`\n[Reactively Editing] Updating the grade for the math course...`);
    mathEnrollment.grade = 'A';
    console.log(` -> New grade set directly on the enrollment object: "${mathEnrollment.grade}"`);

    expect(updatedEnrollmentFromSub).not.toBeNull();
    expect(updatedEnrollmentFromSub.grade).toBe('A');

    // 5. Query Through the Junction Table (Student -> Courses) - LAZY LOADING
    console.log(`\n[Query - Lazy Loading] What courses is "${alice.name}" taking?`);
    const aliceEnrollments = alice.enrollments.find({ $limit: 2, $offset: 0, $sortBy: 'grade:desc' });
    const aliceCourses = aliceEnrollments.map(e => e.course());
    const courseTitles = aliceCourses.map(c => c.title).sort();
    console.log(` -> Courses (lazy): [${courseTitles.join(', ')}]`);
    expect(courseTitles).toEqual(['Calculus I', 'World History']);

    // NEW: Query with $include - EAGER LOADING
    console.log(`\n[Query - Eager Loading] What courses is "${alice.name}" taking with $include?`);
    const aliceEnrollmentsWithInclude = alice.enrollments.find({ 
      $limit: 2, 
      $offset: 0, 
      $sortBy: 'grade:desc', 
      $include: 'course' 
    });
    const aliceCoursesEager = aliceEnrollmentsWithInclude.map(e => e.course());
    const courseTitlesEager = aliceCoursesEager.map(c => c.title).sort();
    console.log(` -> Courses (eager): [${courseTitlesEager.join(', ')}]`);
    expect(courseTitlesEager).toEqual(['Calculus I', 'World History']);

    // 6. Query Through the Junction Table (Course -> Students)
    const bob = db.students.insert({ name: 'Bob' });
    bob.enrollments.push({ courseId: math.id, grade: 'A' });
    console.log(`\n[Query] Who is taking "${math.title}"?`);
    const mathStudents = math.enrollments.find({ grade: 'A' }).map(e => e.student());
    const studentNames = mathStudents.map(s => s.name).sort();
    console.log(` -> Students: [${studentNames.join(', ')}]`);
    expect(studentNames).toEqual(['Alice', 'Bob']);

    console.log('\n✅ All core library features demonstrated successfully!');
  });

  it('should demonstrate fixed upsert functionality', () => {
    const db = new SatiDB(':memory:', {
      students: StudentSchema,
      courses: CourseSchema,
      enrollments: EnrollmentSchema,
    });

    // Create test data
    const alice = db.students.insert({ name: 'Alice' });
    const spanish = db.courses.insert({ title: 'Spanish I' });
    
    console.log('\n[Upsert Test] Testing upsert functionality...');
    
    // Test upsert - insert new (this was previously failing)
    const upsertedNew = alice.enrollments.upsert({ courseId: spanish.id }, { grade: 'B' });
    console.log("upsertedNew", upsertedNew);
    console.log("upsertedNew.courseId", upsertedNew.courseId);
    console.log("spanish.id", spanish.id);
    
    // This should now pass - courseId should be properly set
    expect(upsertedNew.courseId).toBe(spanish.id);
    expect(upsertedNew.studentId).toBe(alice.id);
    expect(upsertedNew.grade).toBe('B');
    
    // Test upsert - update existing
    const upsertedUpdate = alice.enrollments.upsert({ courseId: spanish.id }, { grade: 'A+' });
    expect(upsertedUpdate.id).toBe(upsertedNew.id); // Should be the same entity
    expect(upsertedUpdate.grade).toBe('A+'); // Should be updated
    expect(upsertedUpdate.courseId).toBe(spanish.id); // Should still have courseId
    
    console.log('✅ Upsert functionality working correctly!');
  });

  it('should demonstrate $include with multiple relationships', () => {
    const db = new SatiDB(':memory:', {
      students: StudentSchema,
      courses: CourseSchema,
      enrollments: EnrollmentSchema,
    });

    // Create test data
    const alice = db.students.insert({ name: 'Alice' });
    const bob = db.students.insert({ name: 'Bob' });
    const math = db.courses.insert({ title: 'Mathematics' });
    const science = db.courses.insert({ title: 'Science' });
    
    // Create enrollments
    const enrollment1 = db.enrollments.insert({ studentId: alice.id, courseId: math.id, grade: 'A' });
    const enrollment2 = db.enrollments.insert({ studentId: bob.id, courseId: math.id, grade: 'B' });
    const enrollment3 = db.enrollments.insert({ studentId: alice.id, courseId: science.id, grade: 'A+' });
    
    console.log('\n[Include Test] Testing $include with belongs-to relationships...');
    
    // Test $include with single relationship
    const enrollmentsWithCourse = db.enrollments.find({ $include: 'course' });
    console.log(`Found ${enrollmentsWithCourse.length} enrollments with courses included`);
    
    // Each enrollment should have the course data immediately available
    for (const enrollment of enrollmentsWithCourse) {
      const course = enrollment.course();
      expect(course).not.toBeNull();
      expect(course.title).toBeDefined();
      console.log(`Enrollment grade ${enrollment.grade} for course ${course.title}`);
    }
    
    // Test $include with multiple relationships
    const enrollmentsWithBoth = db.enrollments.find({ $include: ['course', 'student'] });
    console.log(`Found ${enrollmentsWithBoth.length} enrollments with both student and course included`);
    
    for (const enrollment of enrollmentsWithBoth) {
      const course = enrollment.course();
      const student = enrollment.student();
      expect(course).not.toBeNull();
      expect(student).not.toBeNull();
      console.log(`${student.name} has grade ${enrollment.grade} in ${course.title}`);
    }
    
    console.log('✅ $include functionality working correctly!');
  });
});