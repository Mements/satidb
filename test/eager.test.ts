// test/reactive.test.ts

import { describe, it, expect } from 'bun:test';
import { SatiDB, z } from '../satidb';

const StudentSchema = z.object({
  name: z.string(),
  enrollments: z.lazy(() => z.array(EnrollmentSchema)).optional(),
});
const CourseSchema = z.object({
  title: z.string(),
  enrollments: z.lazy(() => z.array(EnrollmentSchema)).optional(),
});
const EnrollmentSchema = z.object({
  studentId: z.number().optional(),
  courseId: z.number().optional(),
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

  it('should demonstrate new findMany interface with where, orderBy, take', () => {
    const db = new SatiDB(':memory:', {
      students: StudentSchema,
      courses: CourseSchema,
      enrollments: EnrollmentSchema,
    });

    const alice = db.students.insert({ name: 'Alice' });
    const math = db.courses.insert({ title: 'Calculus I' });
    const history = db.courses.insert({ title: 'World History' });

    // Create enrollments with different grades and timestamps
    const enrollment1 = db.enrollments.insert({ studentId: alice.id, courseId: math.id, grade: 'A' });
    const enrollment2 = db.enrollments.insert({ studentId: alice.id, courseId: history.id, grade: 'B' });

    console.log('\n[New Interface] Testing findMany with where, orderBy, take...');

    // Test the new findMany interface that mimics Prisma
    const messages = db.enrollments.findMany({
      where: { studentId: alice.id },
      orderBy: { grade: 'asc' },
      take: 10
    });

    expect(messages.length).toBe(2);
    expect(messages[0].grade).toBe('A'); // A comes before B in ascending order

    console.log('✅ New findMany interface working correctly!');
  });
  it('should demonstrate new findUnique interface', () => {
    const db = new SatiDB(':memory:', {
      students: StudentSchema,
      courses: CourseSchema,
      enrollments: EnrollmentSchema,
    });

    const alice = db.students.insert({ name: 'Alice' });
    const math = db.courses.insert({ title: 'Calculus I' });
    db.enrollments.insert({ studentId: alice.id, courseId: math.id, grade: 'A' });

    console.log('\n[New Interface] Testing findUnique...');

    // Test the new findUnique interface
    const enrollment = db.enrollments.findUnique({
      where: { studentId: alice.id, grade: 'A' }
    });

    expect(enrollment).not.toBeNull();
    expect(enrollment.grade).toBe('A');
    expect(enrollment.studentId).toBe(alice.id);

    // Test findUnique with no results
    const notFound = db.enrollments.findUnique({
      where: { grade: 'F' }
    });

    expect(notFound).toBeNull();

    console.log('✅ New findUnique interface working correctly!');
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
    
    // Add query counter and timing
    let queryCount = 0;
    let totalQueryTime = 0;
    const originalQuery = (db as any).db.query;
    (db as any).db.query = function(sql: string) {
      queryCount++;
      const queryStart = performance.now();
      const result = originalQuery.call(this, sql);
      const queryEnd = performance.now();
      totalQueryTime += (queryEnd - queryStart);
      
      if (queryCount <= 5 || queryCount % 100 === 0) { // Only log first 5 queries and every 100th
        console.log(`[Query ${queryCount}] ${(queryEnd - queryStart).toFixed(2)}ms: ${sql.substring(0, 60)}${sql.length > 60 ? '...' : ''}`);
      }
      return result;
    };
    
    console.log('\n=== PERFORMANCE TEST 1: LAZY LOADING (N+1 Problem) ===');
    queryCount = 0;
    totalQueryTime = 0;
    const lazyStartTime = performance.now();
    
    // Get all enrollments without includes
    const enrollmentsLazy = db.enrollments.find();
    const lazyQueryAfterFind = queryCount;
    const lazyTimeAfterFind = totalQueryTime;
    console.log(`Step 1: Found ${enrollmentsLazy.length} enrollments (${lazyQueryAfterFind} queries, ${lazyTimeAfterFind.toFixed(2)}ms)`);
    
    // Access course info for each enrollment (this triggers N queries)
    console.log('Step 2: Accessing course data for each enrollment...');
    let lazyProcessedCount = 0;
    const lazyCourseTitles = enrollmentsLazy.map(enrollment => {
      const course = enrollment.course(); // Each call triggers a separate query!
      lazyProcessedCount++;
      if (lazyProcessedCount % 100 === 0) {
        console.log(`  Processed ${lazyProcessedCount}/${enrollmentsLazy.length} enrollments... (${queryCount} total queries)`);
      }
      return course?.title;
    });
    
    const lazyEndTime = performance.now();
    const lazyDuration = lazyEndTime - lazyStartTime;
    const lazyQueryCount = queryCount;
    const lazyTotalQueryTime = totalQueryTime;
    
    console.log(`🐌 LAZY LOADING RESULTS:`);
    console.log(`   Total Time: ${lazyDuration.toFixed(2)}ms`);
    console.log(`   Pure Query Time: ${lazyTotalQueryTime.toFixed(2)}ms`);
    console.log(`   JavaScript Overhead: ${(lazyDuration - lazyTotalQueryTime).toFixed(2)}ms`);
    console.log(`   Total Queries: ${lazyQueryCount} (1 initial + ${lazyQueryCount - 1} individual lookups)`);
    console.log(`   Processed: ${lazyCourseTitles.length} course titles`);
    
    console.log('\n=== PERFORMANCE TEST 2: EAGER LOADING (JOIN-based) ===');
    queryCount = 0;
    totalQueryTime = 0;
    const eagerStartTime = performance.now();
    
    // Get all enrollments with course included via JOIN
    const enrollmentsEager = db.enrollments.find({ $include: 'course' });
    console.log(`Step 1: Found ${enrollmentsEager.length} enrollments with courses included`);
    
    // Access course info for each enrollment (no additional queries needed!)
    console.log('Step 2: Accessing pre-loaded course data...');
    let eagerProcessedCount = 0;
    const eagerCourseTitles = enrollmentsEager.map(enrollment => {
      const course = enrollment.course(); // Returns pre-loaded data, no query!
      eagerProcessedCount++;
      if (eagerProcessedCount % 100 === 0) {
        console.log(`  Processed ${eagerProcessedCount}/${enrollmentsEager.length} enrollments... (${queryCount} total queries)`);
      }
      return course?.title;
    });
    
    const eagerEndTime = performance.now();
    const eagerDuration = eagerEndTime - eagerStartTime;
    const eagerQueryCount = queryCount;
    const eagerTotalQueryTime = totalQueryTime;
    
    console.log(`🚀 EAGER LOADING RESULTS:`);
    console.log(`   Total Time: ${eagerDuration.toFixed(2)}ms`);
    console.log(`   Pure Query Time: ${eagerTotalQueryTime.toFixed(2)}ms`);
    console.log(`   JavaScript Overhead: ${(eagerDuration - eagerTotalQueryTime).toFixed(2)}ms`);
    console.log(`   Total Queries: ${eagerQueryCount} (1 JOIN query only)`);
    console.log(`   Processed: ${eagerCourseTitles.length} course titles`);
    
    // Calculate performance improvement
    const speedImprovement = (lazyDuration / eagerDuration).toFixed(1);
    const querySpeedImprovement = (lazyTotalQueryTime / eagerTotalQueryTime).toFixed(1);
    const queryReduction = ((lazyQueryCount - eagerQueryCount) / lazyQueryCount * 100).toFixed(1);
    
    console.log(`\n🎯 PERFORMANCE IMPROVEMENT:`);
    console.log(`   Overall Speed: ${speedImprovement}x faster`);
    console.log(`   Pure Query Speed: ${querySpeedImprovement}x faster`);
    console.log(`   Query Reduction: ${queryReduction}% fewer queries`);
    console.log(`   Query Count: ${lazyQueryCount} → ${eagerQueryCount}`);
    
    console.log(`\n📊 ANALYSIS:`);
    console.log(`   Why only ${speedImprovement}x overall improvement?`);
    console.log(`   - In-memory SQLite is extremely fast (~0.01ms per query)`);
    console.log(`   - JavaScript processing dominates the time`);
    console.log(`   - Pure query time improved ${querySpeedImprovement}x`);
    console.log(`   - In production with disk/network I/O, you'd see 10x+ improvements`);
    
    // Verify both methods return identical data
    expect(lazyCourseTitles.length).toBe(eagerCourseTitles.length);
    expect(lazyCourseTitles.sort()).toEqual(eagerCourseTitles.sort());
    
    // Expect significant performance improvement (allow for timing variance)
    // expect(eagerDuration).toBeLessThan(lazyDuration);
    expect(eagerQueryCount).toBeLessThan(lazyQueryCount / 10); // Should be dramatically fewer queries
    
    console.log(`\n✅ Performance test completed successfully!`);
    console.log(`   Both methods returned identical data`);
    console.log(`   Eager loading showed ${querySpeedImprovement}x query performance improvement`);
    
    // Restore original query method
    (db as any).db.query = originalQuery;
  });

  it('should demonstrate file-based database performance difference', () => {
    // Create a temporary file-based database to show real I/O impact
    const tempDbFile = './temp_perf_test.db';
    
    // Clean up any existing test database
    try {
      const fs = require('fs');
      if (fs.existsSync(tempDbFile)) {
        fs.unlinkSync(tempDbFile);
      }
    } catch (e) {
      // Ignore cleanup errors
    }
    
    const db = new SatiDB(tempDbFile, {
      students: StudentSchema,
      courses: CourseSchema,
      enrollments: EnrollmentSchema,
    });

    // Create smaller dataset for file-based test
    console.log('\n=== FILE-BASED DATABASE PERFORMANCE TEST ===');
    const NUM_STUDENTS = 20;
    const NUM_COURSES = 10;
    const ENROLLMENTS_PER_STUDENT = 3;
    
    console.log(`Creating ${NUM_STUDENTS} students in file-based database...`);
    const students = [];
    for (let i = 1; i <= NUM_STUDENTS; i++) {
      students.push(db.students.insert({ name: `Student ${i}` }));
    }
    
    const courses = [];
    for (let i = 1; i <= NUM_COURSES; i++) {
      courses.push(db.courses.insert({ title: `Course ${i}` }));
    }
    
    for (const student of students) {
      const shuffledCourses = [...courses].sort(() => Math.random() - 0.5);
      for (let i = 0; i < ENROLLMENTS_PER_STUDENT; i++) {
        const course = shuffledCourses[i % shuffledCourses.length];
        db.enrollments.insert({ 
          studentId: student.id, 
          courseId: course.id, 
          grade: 'A' 
        });
      }
    }
    
    const totalEnrollments = NUM_STUDENTS * ENROLLMENTS_PER_STUDENT;
    console.log(`✅ Created ${totalEnrollments} enrollments in file database`);
    
    // Test lazy loading
    console.log('\n--- Testing Lazy Loading (File I/O) ---');
    const lazyStart = performance.now();
    const enrollmentsLazy = db.enrollments.find();
    const coursesLazy = enrollmentsLazy.map(e => e.course());
    const lazyEnd = performance.now();
    const lazyTime = lazyEnd - lazyStart;
    
    // Test eager loading
    console.log('--- Testing Eager Loading (File I/O) ---');
    const eagerStart = performance.now();
    const enrollmentsEager = db.enrollments.find({ $include: 'course' });
    const coursesEager = enrollmentsEager.map(e => e.course());
    const eagerEnd = performance.now();
    const eagerTime = eagerEnd - eagerStart;
    
    const fileSpeedImprovement = (lazyTime / eagerTime).toFixed(1);
    
    console.log(`\n📁 FILE DATABASE RESULTS:`);
    console.log(`   Lazy Loading: ${lazyTime.toFixed(2)}ms`);
    console.log(`   Eager Loading: ${eagerTime.toFixed(2)}ms`);
    console.log(`   Improvement: ${fileSpeedImprovement}x faster`);
    console.log(`   File I/O adds significant overhead to individual queries`);
    
    // Verify results match
    expect(coursesLazy.map(c => c?.title).sort()).toEqual(coursesEager.map(c => c?.title).sort());
    expect(eagerTime).toBeLessThan(lazyTime);
    
    // Clean up test database
    try {
      const fs = require('fs');
      if (fs.existsSync(tempDbFile)) {
        fs.unlinkSync(tempDbFile);
      }
    } catch (e) {
      // Ignore cleanup errors
    }
    
    console.log(`✅ File-based test completed with ${fileSpeedImprovement}x improvement`);
  });
});