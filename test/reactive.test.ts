import { describe, it, expect } from 'bun:test';
import { MyDatabase, z } from '../satidb';

// --- Schemas ---
// Best Practice: For many-to-many relationships, create an explicit entity
// for the relationship itself (the "junction table"). This is powerful because
// you can store additional properties about the relationship (e.g., a grade, a timestamp).

const StudentSchema = z.object({
  name: z.string(),
  // The inverse relationship `student.enrollments()` will be automatically created.
});

const CourseSchema = z.object({
  title: z.string(),
  // The inverse relationship `course.enrollments()` will be automatically created.
});

// The "Enrollment" entity connects one Student with one Course.
const EnrollmentSchema = z.object({
  student: z.lazy(() => StudentSchema).optional(),
  course: z.lazy(() => CourseSchema).optional(),
  grade: z.string().optional(), // The junction can have its own data.
});

describe('MyDatabase - Unified Core Showcase', () => {
  it('should demonstrate all core features in a single M-M scenario', () => {
    const db = new MyDatabase(':memory:', {
      students: StudentSchema,
      courses: CourseSchema,
      enrollments: EnrollmentSchema, // The junction table is a first-class entity.
    });

    let updatedEnrollmentFromSub: any = null;

    // 1. Subscribe: Listen for changes on the relationship entity.
    db.enrollments.subscribe('update', (updatedData) => {
      console.log(`[Subscription] Enrollment updated. New grade: ${updatedData.grade}`);
      updatedEnrollmentFromSub = updatedData;
    });

    // 2. Insert: Create the primary entities.
    const alice = db.students.insert({ name: 'Alice' });
    const math = db.courses.insert({ title: 'Calculus I' });
    const history = db.courses.insert({ title: 'World History' });
    console.log(`[Insert] Created student "${alice.name}" and two courses.`);

    // 3. Relational Push: Create the links by inserting into the junction table.
    // The fluent API `alice.enrollments.push()` automatically sets `studentId`.
    const mathEnrollment = alice.enrollments.push({ courseId: math.id, grade: 'In Progress' });
    alice.enrollments.push({ courseId: history.id, grade: 'In Progress' });
    console.log(`[Push] Enrolled "${alice.name}" in two courses.`);

    // 4. Reactive Editing: Directly modify the relationship entity itself.
    // The Proxy wrapper automatically persists the change to the database.
    console.log(`\n[Reactively Editing] Updating the grade for the math course...`);
    mathEnrollment.grade = 'A';
    console.log(` -> New grade set directly on the enrollment object: "${mathEnrollment.grade}"`);

    // Verify the subscription fired and the data is correct.
    expect(updatedEnrollmentFromSub).not.toBeNull();
    expect(updatedEnrollmentFromSub.grade).toBe('A');

    // 5. Query Through the Junction Table (Student -> Courses)
    // This is the core pattern: fetch the linking entities, then resolve the target.
    console.log(`\n[Query] What courses is "${alice.name}" taking?`);
    const aliceEnrollments = alice.enrollments();
    const aliceCourses = aliceEnrollments.map(e => e.course());
    const courseTitles = aliceCourses.map(c => c.title).sort();
    console.log(` -> Courses: [${courseTitles.join(', ')}]`);
    expect(courseTitles).toEqual(['Calculus I', 'World History']);

    // 6. Query Through the Junction Table (Course -> Students)
    // Demonstrate the inverse by finding all students in a course.
    const bob = db.students.insert({ name: 'Bob' });
    bob.enrollments.push({ courseId: math.id, grade: 'B+' });
    console.log(`\n[Query] Who is taking "${math.title}"?`);
    const mathStudents = math.enrollments().map(e => e.student());
    const studentNames = mathStudents.map(s => s.name).sort();
    console.log(` -> Students: [${studentNames.join(', ')}]`);
    expect(studentNames).toEqual(['Alice', 'Bob']);

    console.log('\n✅ All core library features demonstrated successfully!');
  });
});