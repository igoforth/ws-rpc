import { describe } from "vitest";
import {
	RpcConnectionClosed,
	RpcError,
	RpcMethodNotFoundError,
	RpcRemoteError,
	RpcTimeoutError,
	RpcValidationError,
} from "../src/errors.js";
import { RpcErrorCodes } from "../src/protocol.js";

describe("RpcError", (it) => {
	it("should create error with code and message", ({ expect }) => {
		const error = new RpcError(
			RpcErrorCodes.INTERNAL_ERROR,
			"Something went wrong",
		);

		expect(error).toBeInstanceOf(Error);
		expect(error).toBeInstanceOf(RpcError);
		expect(error.code).toBe(RpcErrorCodes.INTERNAL_ERROR);
		expect(error.message).toBe("Something went wrong");
		expect(error.name).toBe("RpcError");
	});

	it("should create error with optional data", ({ expect }) => {
		const data = { field: "name", reason: "required" };
		const error = new RpcError(
			RpcErrorCodes.INVALID_PARAMS,
			"Validation failed",
			data,
		);

		expect(error.data).toEqual(data);
	});

	it("should work with try/catch", ({ expect }) => {
		try {
			throw new RpcError(RpcErrorCodes.PARSE_ERROR, "Parse error");
		} catch (e) {
			expect(e).toBeInstanceOf(RpcError);
			if (e instanceof RpcError) {
				expect(e.code).toBe(RpcErrorCodes.PARSE_ERROR);
			}
		}
	});
});

describe("RpcTimeoutError", (it) => {
	it("should create timeout error with method name and timeout", ({
		expect,
	}) => {
		const error = new RpcTimeoutError("getUser", 5000);

		expect(error).toBeInstanceOf(Error);
		expect(error).toBeInstanceOf(RpcError);
		expect(error).toBeInstanceOf(RpcTimeoutError);
		expect(error.name).toBe("RpcTimeoutError");
		expect(error.code).toBe(RpcErrorCodes.TIMEOUT);
		expect(error.method).toBe("getUser");
		expect(error.timeoutMs).toBe(5000);
		expect(error.message).toContain("getUser");
		expect(error.message).toContain("5000");
	});
});

describe("RpcRemoteError", (it) => {
	it("should create remote error with method, code, and message", ({
		expect,
	}) => {
		const error = new RpcRemoteError(
			"createUser",
			RpcErrorCodes.INVALID_PARAMS,
			"Email already exists",
		);

		expect(error).toBeInstanceOf(Error);
		expect(error).toBeInstanceOf(RpcError);
		expect(error).toBeInstanceOf(RpcRemoteError);
		expect(error.name).toBe("RpcRemoteError");
		expect(error.method).toBe("createUser");
		expect(error.code).toBe(RpcErrorCodes.INVALID_PARAMS);
		expect(error.message).toBe("Email already exists");
	});

	it("should include optional data", ({ expect }) => {
		const error = new RpcRemoteError(
			"validateInput",
			RpcErrorCodes.VALIDATION_ERROR,
			"Invalid input",
			{ fields: ["name", "email"] },
		);

		expect(error.data).toEqual({ fields: ["name", "email"] });
	});
});

describe("RpcConnectionClosed", (it) => {
	it("should create connection closed error with default message", ({
		expect,
	}) => {
		const error = new RpcConnectionClosed();

		expect(error).toBeInstanceOf(Error);
		expect(error).toBeInstanceOf(RpcError);
		expect(error).toBeInstanceOf(RpcConnectionClosed);
		expect(error.name).toBe("RpcConnectionClosed");
		expect(error.code).toBe(RpcErrorCodes.CONNECTION_CLOSED);
		expect(error.message).toBe("WebSocket connection closed");
	});

	it("should accept custom message", ({ expect }) => {
		const error = new RpcConnectionClosed("Connection lost unexpectedly");

		expect(error.message).toBe("Connection lost unexpectedly");
	});
});

describe("RpcValidationError", (it) => {
	it("should create validation error with message", ({ expect }) => {
		const error = new RpcValidationError("Invalid input for method 'test'");

		expect(error).toBeInstanceOf(Error);
		expect(error).toBeInstanceOf(RpcError);
		expect(error).toBeInstanceOf(RpcValidationError);
		expect(error.name).toBe("RpcValidationError");
		expect(error.code).toBe(RpcErrorCodes.VALIDATION_ERROR);
	});

	it("should include validation details in data", ({ expect }) => {
		const zodError = {
			issues: [{ path: ["name"], message: "Required" }],
		};
		const error = new RpcValidationError("Validation failed", zodError);

		expect(error.data).toEqual(zodError);
	});
});

describe("RpcMethodNotFoundError", (it) => {
	it("should create method not found error", ({ expect }) => {
		const error = new RpcMethodNotFoundError("unknownMethod");

		expect(error).toBeInstanceOf(Error);
		expect(error).toBeInstanceOf(RpcError);
		expect(error).toBeInstanceOf(RpcMethodNotFoundError);
		expect(error.name).toBe("RpcMethodNotFoundError");
		expect(error.code).toBe(RpcErrorCodes.METHOD_NOT_FOUND);
		expect(error.method).toBe("unknownMethod");
		expect(error.message).toContain("unknownMethod");
	});
});

describe("Error Inheritance", (it) => {
	it("should maintain proper prototype chain", ({ expect }) => {
		const timeoutError = new RpcTimeoutError("test", 1000);
		const remoteError = new RpcRemoteError("test", -1, "error");
		const connectionError = new RpcConnectionClosed();
		const validationError = new RpcValidationError("error");
		const methodNotFoundError = new RpcMethodNotFoundError("test");

		// All should be instances of Error
		expect(timeoutError).toBeInstanceOf(Error);
		expect(remoteError).toBeInstanceOf(Error);
		expect(connectionError).toBeInstanceOf(Error);
		expect(validationError).toBeInstanceOf(Error);
		expect(methodNotFoundError).toBeInstanceOf(Error);

		// All should be instances of RpcError
		expect(timeoutError).toBeInstanceOf(RpcError);
		expect(remoteError).toBeInstanceOf(RpcError);
		expect(connectionError).toBeInstanceOf(RpcError);
		expect(validationError).toBeInstanceOf(RpcError);
		expect(methodNotFoundError).toBeInstanceOf(RpcError);
	});

	it("should have proper stack traces", ({ expect }) => {
		const error = new RpcTimeoutError("test", 1000);

		expect(error.stack).toBeDefined();
		expect(error.stack).toContain("RpcTimeoutError");
	});
});
