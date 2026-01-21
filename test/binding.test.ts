/**
 * SatiDB Update Issue - Minimal Reproduction
 * 
 * This test demonstrates the behavior of SatiDB's update() method
 * with dynamically constructed objects.
 * 
 * The test verifies that update operations work correctly with
 * dynamic object patterns commonly used in PATCH handlers.
 */

import { describe, it, expect } from "bun:test";
import { SatiDB, z } from "../src/satidb";
import { randomUUID } from "crypto";

// Define a Jobs schema for testing
const JobSchema = z.object({
    job_id: z.string(),
    server_id: z.string(),
    instance_id: z.string(),
    user_id: z.string(),
    prompt: z.string(),
    status: z.string(),
    started_at: z.number().optional(),
    completed_at: z.number().optional(),
    generation_count: z.number().optional(),
    last_generation_at: z.number().optional(),
});

describe("SatiDB Update Binding Issue - In-Memory Database", () => {
    // Create a fresh in-memory database for each test suite
    const db = new SatiDB(':memory:', {
        jobs: JobSchema,
    });

    it("should handle dynamic object update correctly", () => {
        // Create a job in the database
        const jobId = `test-${randomUUID()}`;
        const instanceId = "17ea4d22-948f-4750-9a4e-0d6724a0c3ee";

        // First, insert a test job
        const insertedJob = db.jobs.insert({
            job_id: jobId,
            server_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
            instance_id: instanceId,
            user_id: "test-user",
            prompt: "test prompt",
            status: "pending",
            started_at: Date.now(),
        });

        console.log("\n=== Test: Dynamic Update ===");
        console.log("Created job:", jobId, "with id:", insertedJob.id);

        // Simulate what a PATCH handler does - build update object dynamically
        const requestBody = {
            status: "completed",
            generationCount: 1,
        };

        // This is the pattern used in PATCH handlers:
        const updateData: Record<string, any> = {};

        if (requestBody.status) {
            updateData.status = requestBody.status;
            if (requestBody.status === "completed") {
                updateData.completed_at = Date.now();
            }
        }

        if (typeof requestBody.generationCount === "number") {
            updateData.generation_count = requestBody.generationCount;
            updateData.last_generation_at = Date.now();
        }

        console.log("Dynamic updateData:", JSON.stringify(updateData, null, 2));

        // Try updating using the entity's update method
        let errorOccurred = false;
        let errorMessage = "";

        try {
            insertedJob.update(updateData);
            console.log("SatiDB update succeeded");
        } catch (error: any) {
            errorOccurred = true;
            errorMessage = error.message;
            console.log("SatiDB update FAILED:", error.message);
        }

        // Verify the update worked
        const job = db.jobs.findOne({ job_id: jobId });

        if (errorOccurred) {
            console.log("❌ Error occurred during update:", errorMessage);
            // Fail the test if update didn't work
            expect(errorOccurred).toBe(false);
        } else {
            console.log("✅ Update succeeded");
            expect(job?.status).toBe("completed");
            expect(job?.generation_count).toBe(1);
            expect(job?.completed_at).toBeDefined();
        }
    });

    it("should handle update via table accessor with numeric id", () => {
        // Create a test job
        const jobId = `test-${randomUUID()}`;

        const insertedJob = db.jobs.insert({
            job_id: jobId,
            server_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
            instance_id: "17ea4d22-948f-4750-9a4e-0d6724a0c3ee",
            user_id: "test-user",
            prompt: "test prompt",
            status: "pending",
            started_at: Date.now(),
        });

        console.log("\n=== Test: Table Accessor Update ===");
        console.log("Created job:", jobId, "with id:", insertedJob.id);

        // Same request body pattern
        const requestBody = {
            status: "completed",
            generationCount: 5,
        };

        // Build update dynamically
        const updateData: Record<string, any> = {};

        if (requestBody.status) {
            updateData.status = requestBody.status;
            if (requestBody.status === "completed") {
                updateData.completed_at = Date.now();
            }
        }

        if (typeof requestBody.generationCount === "number") {
            updateData.generation_count = requestBody.generationCount;
            updateData.last_generation_at = Date.now();
        }

        console.log("Dynamic updateData:", JSON.stringify(updateData, null, 2));

        // Update using the table accessor's update method with numeric id
        db.jobs.update(insertedJob.id, updateData);
        console.log("Table accessor update succeeded");

        // Verify the update worked
        const job = db.jobs.findOne({ job_id: jobId });
        console.log("Retrieved job:", JSON.stringify(job, null, 2));

        expect(job?.status).toBe("completed");
        expect(job?.generation_count).toBe(5);
        expect(job?.completed_at).toBeDefined();

        console.log("✅ Verification passed - job status:", job?.status);
    });

    it("should handle property-based update on entity", () => {
        // Create a test job
        const jobId = `test-${randomUUID()}`;

        const job = db.jobs.insert({
            job_id: jobId,
            server_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
            instance_id: "17ea4d22-948f-4750-9a4e-0d6724a0c3ee",
            user_id: "test-user",
            prompt: "test prompt",
            status: "pending",
            started_at: Date.now(),
        });

        console.log("\n=== Test: Property-based Update ===");
        console.log("Created job:", jobId);

        // Update using direct property assignment (if supported)
        job.status = "completed";
        job.generation_count = 3;
        job.completed_at = Date.now();

        // Verify the update persisted
        const retrievedJob = db.jobs.findOne({ job_id: jobId });

        expect(retrievedJob?.status).toBe("completed");
        expect(retrievedJob?.generation_count).toBe(3);
        expect(retrievedJob?.completed_at).toBeDefined();

        console.log("✅ Property-based update passed");
    });

    it("should handle update with filter object (Prisma-style)", () => {
        // Create a test job
        const jobId = `test-${randomUUID()}`;

        db.jobs.insert({
            job_id: jobId,
            server_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
            instance_id: "17ea4d22-948f-4750-9a4e-0d6724a0c3ee",
            user_id: "test-user",
            prompt: "test prompt",
            status: "pending",
            started_at: Date.now(),
        });

        console.log("\n=== Test: Filter-based Update ===");
        console.log("Created job:", jobId);

        // Build update data dynamically (like in a PATCH handler)
        const requestBody = {
            status: "completed",
            generationCount: 10,
        };

        const updateData: Record<string, any> = {};

        if (requestBody.status) {
            updateData.status = requestBody.status;
            if (requestBody.status === "completed") {
                updateData.completed_at = Date.now();
            }
        }

        if (typeof requestBody.generationCount === "number") {
            updateData.generation_count = requestBody.generationCount;
            updateData.last_generation_at = Date.now();
        }

        console.log("Filter:", JSON.stringify({ job_id: jobId }));
        console.log("Update data:", JSON.stringify(updateData, null, 2));

        // Use the filter-based update pattern: update({ filter }, data)
        const updatedJob = db.jobs.update({ job_id: jobId }, updateData);
        console.log("Filter-based update succeeded");

        // Verify the update worked
        expect(updatedJob).not.toBeNull();
        expect(updatedJob?.status).toBe("completed");
        expect(updatedJob?.generation_count).toBe(10);
        expect(updatedJob?.completed_at).toBeDefined();

        // Also verify by fetching again
        const retrievedJob = db.jobs.findOne({ job_id: jobId });
        expect(retrievedJob?.status).toBe("completed");
        expect(retrievedJob?.generation_count).toBe(10);

        console.log("✅ Filter-based update passed - job status:", retrievedJob?.status);
    });

    it("should return null when filter matches no rows", () => {
        console.log("\n=== Test: Filter No Match ===");

        // Try to update a non-existent job
        const nonExistentJobId = `non-existent-${randomUUID()}`;
        const result = db.jobs.update({ job_id: nonExistentJobId }, { status: "completed" });

        expect(result).toBeNull();
        console.log("✅ Correctly returned null for non-matching filter");
    });
});

/**
 * EXPLANATION:
 * 
 * This test file verifies SatiDB's update functionality with three patterns:
 * 1. Entity's update() method with a dynamic object
 * 2. Table accessor's update() method with numeric id and dynamic object
 * 3. Direct property assignment on the entity
 * 
 * These patterns are commonly used in PATCH handlers where the update
 * object is constructed dynamically based on the request body.
 * 
 * Run test:
 *   bun test test/binding.test.ts
 */
