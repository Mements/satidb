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

  it('should demonstrate dramatic performance difference with thousands of entries', () => {
    const db = new SatiDB(':memory:', {
      students: StudentSchema,
      courses: CourseSchema,
      enrollments: EnrollmentSchema,
    });

    // Create a large dataset
    console.log('\n=== CREATING LARGE DATASET ===');
    const NUM_STUDENTS = 100;
    const NUM_COURSES = 50;
    const ENROLLMENTS_PER_STUDENT = 5;
    
    console.log(`Creating ${NUM_STUDENTS} students...`);
    const students = [];
    for (let i = 1; i <= NUM_STUDENTS; i++) {
      students.push(db.students.insert({ name: `Student ${i}` }));
    }
    
    console.log(`Creating ${NUM_COURSES} courses...`);
    const courses = [];
    for (let i = 1; i <= NUM_COURSES; i++) {
      courses.push(db.courses.insert({ title: `Course ${i}` }));
    }
    
    console.log(`Creating enrollments (${ENROLLMENTS_PER_STUDENT} per student)...`);
    const enrollments = [];
    for (const student of students) {
      // Randomly enroll each student in ENROLLMENTS_PER_STUDENT courses
      const shuffledCourses = [...courses].sort(() => Math.random() - 0.5);
      for (let i = 0; i < ENROLLMENTS_PER_STUDENT; i++) {
        const course = shuffledCourses[i % shuffledCourses.length];
        const grades = ['A', 'A-', 'B+', 'B', 'B-', 'C+', 'C'];
        const grade = grades[Math.floor(Math.random() * grades.length)];
        enrollments.push(db.enrollments.insert({ 
          studentId: student.id, 
          courseId: course.id, 
          grade 
        }));
      }
    }
    
    const totalEnrollments = NUM_STUDENTS * ENROLLMENTS_PER_STUDENT;
    console.log(`✅ Created ${totalEnrollments} total enrollments`);
    
    // Add a simple query counter by wrapping the database query method
    let queryCount = 0;
    const originalQuery = (db as any).db.query;
    (db as any).db.query = function(sql: string) {
      queryCount++;
      if (queryCount <= 10 || queryCount % 50 === 0) { // Only log first 10 queries and every 50th
        console.log(`[Query ${queryCount}] ${sql.substring(0, 80)}${sql.length > 80 ? '...' : ''}`);
      }
      return originalQuery.call(this, sql);
    };
    
    console.log('\n=== PERFORMANCE TEST 1: LAZY LOADING (N+1 Problem) ===');
    queryCount = 0;
    const lazyStartTime = performance.now();
    
    // Get all enrollments without includes
    const enrollmentsLazy = db.enrollments.find();
    console.log(`Step 1: Found ${enrollmentsLazy.length} enrollments`);
    
    // Access course info for each enrollment (this triggers N queries)
    let lazyProcessedCount = 0;
    const lazyCourseTitles = enrollmentsLazy.map(enrollment => {
      const course = enrollment.course(); // Each call triggers a separate query!
      lazyProcessedCount++;
      if (lazyProcessedCount % 100 === 0) {
        console.log(`  Processed ${lazyProcessedCount}/${enrollmentsLazy.length} enrollments...`);
      }
      return course?.title;
    });
    
    const lazyEndTime = performance.now();
    const lazyDuration = lazyEndTime - lazyStartTime;
    const lazyQueryCount = queryCount;
    
    console.log(`🐌 LAZY LOADING RESULTS:`);
    console.log(`   Time: ${lazyDuration.toFixed(2)}ms`);
    console.log(`   Queries: ${lazyQueryCount} (1 initial + ${lazyQueryCount - 1} individual lookups)`);
    console.log(`   Processed: ${lazyCourseTitles.length} course titles`);
    
    console.log('\n=== PERFORMANCE TEST 2: EAGER LOADING (JOIN-based) ===');
    queryCount = 0;
    const eagerStartTime = performance.now();
    
    // Get all enrollments with course included via JOIN
    const enrollmentsEager = db.enrollments.find({ $include: 'course' });
    console.log(`Step 1: Found ${enrollmentsEager.length} enrollments with courses included`);
    
    // Access course info for each enrollment (no additional queries needed!)
    let eagerProcessedCount = 0;
    const eagerCourseTitles = enrollmentsEager.map(enrollment => {
      const course = enrollment.course(); // Returns pre-loaded data, no query!
      eagerProcessedCount++;
      if (eagerProcessedCount % 100 === 0) {
        console.log(`  Processed ${eagerProcessedCount}/${enrollmentsEager.length} enrollments...`);
      }
      return course?.title;
    });
    
    const eagerEndTime = performance.now();
    const eagerDuration = eagerEndTime - eagerStartTime;
    const eagerQueryCount = queryCount;
    
    console.log(`🚀 EAGER LOADING RESULTS:`);
    console.log(`   Time: ${eagerDuration.toFixed(2)}ms`);
    console.log(`   Queries: ${eagerQueryCount} (1 JOIN query only)`);
    console.log(`   Processed: ${eagerCourseTitles.length} course titles`);
    
    // Calculate performance improvement
    const speedImprovement = (lazyDuration / eagerDuration).toFixed(1);
    const queryReduction = ((lazyQueryCount - eagerQueryCount) / lazyQueryCount * 100).toFixed(1);
    
    console.log(`\n🎯 PERFORMANCE IMPROVEMENT:`);
    console.log(`   Speed: ${speedImprovement}x faster`);
    console.log(`   Query Reduction: ${queryReduction}% fewer queries`);
    console.log(`   Query Count: ${lazyQueryCount} → ${eagerQueryCount}`);
    
    // Verify both methods return identical data
    expect(lazyCourseTitles.length).toBe(eagerCourseTitles.length);
    expect(lazyCourseTitles.sort()).toEqual(eagerCourseTitles.sort());
    
    // Expect significant performance improvement
    expect(eagerDuration).toBeLessThan(lazyDuration);
    expect(eagerQueryCount).toBeLessThan(lazyQueryCount / 10); // Should be dramatically fewer queries
    
    console.log(`\n✅ Performance test completed successfully!`);
    console.log(`   Both methods returned identical data`);
    console.log(`   Eager loading showed significant performance improvement`);
    
    // Restore original query method
    (db as any).db.query = originalQuery;
  });
});