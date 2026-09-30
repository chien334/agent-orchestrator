import { z } from "zod";
import { isAbsolute, posix } from "node:path";

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
export const modelSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_./:#-]*$/)
  .refine(
    (value) => !value.includes("..") && !value.includes("//"),
    "Invalid model selector",
  );
const relative = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => {
    const parts = value.split(/[\\/]/);
    return (
      !isAbsolute(value) &&
      !value.includes("\\") &&
      !parts.includes("..") &&
      !parts.includes(".") &&
      !parts.includes("") &&
      !value.includes("\0") &&
      !value.startsWith("~") &&
      posix.normalize(value) === value
    );
  }, "Must be a normalized repository-relative path");

export const taskSchema = z
  .object({
    task_id: identifier,
    description: z.string().min(1).max(12000),
    worker: z.enum(["opencode", "agy"]),
    model: modelSchema.optional(),
    allowed_paths: z.array(relative).min(1).max(100),
    allowed_tests: z
      .array(z.array(z.string().min(1).max(512)).min(1).max(32))
      .max(20)
      .default([]),
  })
  .strict();

export const dispatchSchema = z
  .object({ tasks: z.array(taskSchema).min(1).max(50) })
  .strict();
export const runSchema = z.object({ run_id: z.string().uuid() }).strict();
export type TaskInput = z.infer<typeof taskSchema>;
export type Status =
  "queued" | "running" | "completed" | "failed" | "blocked" | "cancelled";
export type TestResult = {
  command: string[];
  exit_code: number | null;
  status: "passed" | "failed";
  error?: string;
};
export type Report = {
  run_id: string;
  task_id: string;
  worker: TaskInput["worker"];
  model: string | null;
  status: Status;
  summary: string;
  worktree_path: string;
  branch: string;
  changed_files: string[];
  tests: TestResult[];
  exit_code: number | null;
  started_at: string | null;
  finished_at: string | null;
  log_path: string;
  diff_path: string;
  errors: string[];
  final_response: string;
  base_commit: string;
};

export function assertUnique(tasks: TaskInput[]): void {
  if (new Set(tasks.map((task) => task.task_id)).size !== tasks.length)
    throw new Error("Duplicate task_id");
}
