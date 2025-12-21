import { describe } from "vitest";
import * as z from "zod";
import {
	event,
	type InferEventData,
	type InferInput,
	type InferOutput,
	method,
} from "../src/schema.js";

describe("Schema Helpers", (it) => {
	describe("method()", (it) => {
		it("should create a method definition with input and output schemas", ({
			expect,
		}) => {
			const myMethod = method({
				input: z.object({ id: z.string() }),
				output: z.object({ name: z.string() }),
			});

			expect(myMethod._type).toBe("method");
			expect(myMethod.input).toBeDefined();
			expect(myMethod.output).toBeDefined();
		});

		it("should preserve Zod schema validation", ({ expect }) => {
			const myMethod = method({
				input: z.object({ id: z.string() }),
				output: z.object({ success: z.boolean() }),
			});

			// Input validation
			const validInput = myMethod.input.safeParse({ id: "123" });
			expect(validInput.success).toBe(true);

			const invalidInput = myMethod.input.safeParse({ id: 123 });
			expect(invalidInput.success).toBe(false);

			// Output validation
			const validOutput = myMethod.output.safeParse({ success: true });
			expect(validOutput.success).toBe(true);

			const invalidOutput = myMethod.output.safeParse({ success: "yes" });
			expect(invalidOutput.success).toBe(false);
		});

		it("should support complex schemas", ({ expect }) => {
			const complexMethod = method({
				input: z.object({
					user: z.object({
						name: z.string(),
						age: z.number().min(0),
						tags: z.array(z.string()),
					}),
					options: z.object({
						notify: z.boolean().optional(),
					}),
				}),
				output: z.union([
					z.object({ status: z.literal("success"), id: z.string() }),
					z.object({ status: z.literal("error"), message: z.string() }),
				]),
			});

			const validInput = complexMethod.input.safeParse({
				user: { name: "Alice", age: 30, tags: ["admin"] },
				options: { notify: true },
			});
			expect(validInput.success).toBe(true);

			const successOutput = complexMethod.output.safeParse({
				status: "success",
				id: "123",
			});
			expect(successOutput.success).toBe(true);

			const errorOutput = complexMethod.output.safeParse({
				status: "error",
				message: "Failed",
			});
			expect(errorOutput.success).toBe(true);
		});
	});

	describe("event()", (it) => {
		it("should create an event definition with data schema", ({ expect }) => {
			const myEvent = event({
				data: z.object({ price: z.number() }),
			});

			expect(myEvent._type).toBe("event");
			expect(myEvent.data).toBeDefined();
		});

		it("should preserve Zod schema validation", ({ expect }) => {
			const tradeEvent = event({
				data: z.object({
					timestamp: z.number(),
					price: z.number(),
					size: z.string(),
				}),
			});

			const valid = tradeEvent.data.safeParse({
				timestamp: Date.now(),
				price: 0.5,
				size: "100",
			});
			expect(valid.success).toBe(true);

			const invalid = tradeEvent.data.safeParse({
				timestamp: "now",
				price: 0.5,
			});
			expect(invalid.success).toBe(false);
		});
	});
});

describe("Type Inference", (it) => {
	// These tests verify TypeScript type inference at compile time
	// The assertions are at runtime but the types are checked by TS

	describe("InferInput", (it) => {
		it("should infer input type from method definition", ({ expect }) => {
			const myMethod = method({
				input: z.object({ id: z.string(), count: z.number() }),
				output: z.object({ success: z.boolean() }),
			});

			// Type test - this will cause compile error if types don't match
			type ExpectedInput = { id: string; count: number };
			type ActualInput = InferInput<typeof myMethod>;

			// Runtime check that schema works as expected
			const testInput: ActualInput = { id: "test", count: 5 };
			const result = myMethod.input.safeParse(testInput);
			expect(result.success).toBe(true);

			// Verify the inferred type matches expected
			const expectedInput: ExpectedInput = testInput;
			expect(expectedInput).toEqual(testInput);
		});
	});

	describe("InferOutput", (it) => {
		it("should infer output type from method definition", ({ expect }) => {
			const myMethod = method({
				input: z.object({}),
				output: z.object({
					users: z.array(z.object({ name: z.string() })),
				}),
			});

			type ActualOutput = InferOutput<typeof myMethod>;

			const testOutput: ActualOutput = {
				users: [{ name: "Alice" }, { name: "Bob" }],
			};
			const result = myMethod.output.safeParse(testOutput);
			expect(result.success).toBe(true);
		});
	});

	describe("InferEventData", (it) => {
		it("should infer event data type from event definition", ({ expect }) => {
			const tradeEvent = event({
				data: z.object({
					price: z.number(),
					timestamp: z.number(),
				}),
			});

			type ActualData = InferEventData<typeof tradeEvent>;

			const testData: ActualData = { price: 0.5, timestamp: Date.now() };
			const result = tradeEvent.data.safeParse(testData);
			expect(result.success).toBe(true);
		});
	});
});

describe("RpcSchema Integration", (it) => {
	it("should work with a complete schema definition", ({ expect }) => {
		// Define a complete schema like we would in the real code
		const TestSchema = {
			methods: {
				getUser: method({
					input: z.object({ id: z.string() }),
					output: z.object({ name: z.string(), email: z.string() }),
				}),
				createUser: method({
					input: z.object({ name: z.string(), email: z.string() }),
					output: z.object({ id: z.string() }),
				}),
			},
			events: {
				userCreated: event({
					data: z.object({ id: z.string(), name: z.string() }),
				}),
				userDeleted: event({
					data: z.object({ id: z.string() }),
				}),
			},
		} as const;

		// Verify methods work
		expect(TestSchema.methods.getUser._type).toBe("method");
		expect(TestSchema.methods.createUser._type).toBe("method");

		// Verify events work
		expect(TestSchema.events.userCreated._type).toBe("event");
		expect(TestSchema.events.userDeleted._type).toBe("event");

		// Verify validation works on schema methods
		const getUserInput = TestSchema.methods.getUser.input.safeParse({
			id: "123",
		});
		expect(getUserInput.success).toBe(true);

		const createUserInput = TestSchema.methods.createUser.input.safeParse({
			name: "Alice",
			email: "alice@example.com",
		});
		expect(createUserInput.success).toBe(true);

		// Verify event data validation
		const userCreatedData = TestSchema.events.userCreated.data.safeParse({
			id: "123",
			name: "Alice",
		});
		expect(userCreatedData.success).toBe(true);
	});
});
