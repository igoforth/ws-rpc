/**
 * Schema Definition Utilities
 *
 * Provides helpers to define RPC methods and events with Zod schemas,
 * enabling TypeScript type inference for the entire RPC contract.
 */

import type { LiteralUnion } from "type-fest";
import type * as z from "zod";

export type StringKeys<T> = keyof T extends string ? keyof T : never;
export type LiteralString = "" | (string & Record<never, never>);
export type LiteralStringUnion<T> = LiteralUnion<T, string>;

/**
 * Method definition with input and output schemas
 */
export interface MethodDef<
	TInput extends z.ZodType = z.ZodType,
	TOutput extends z.ZodType = z.ZodType,
> {
	_type: "method";
	input: TInput;
	output: TOutput;
}

/**
 * Event definition with data schema
 */
export interface EventDef<TData extends z.ZodType = z.ZodType> {
	_type: "event";
	data: TData;
}

/**
 * Define an RPC method with input/output schemas
 *
 * @param def - Object containing input and output Zod schemas
 * @returns MethodDef with preserved type information
 *
 * @example
 * ```ts
 * const getUser = method({
 *   input: z.object({ id: z.string() }),
 *   output: z.object({ name: z.string(), email: z.string() }),
 * });
 * ```
 */
export function method<
	TInput extends z.ZodType,
	TOutput extends z.ZodType,
>(def: { input: TInput; output: TOutput }): MethodDef<TInput, TOutput> {
	return { _type: "method", ...def };
}

/**
 * Define a fire-and-forget event with data schema
 *
 * @param def - Object containing data Zod schema
 * @returns EventDef with preserved type information
 *
 * @example
 * ```ts
 * const userCreated = event({
 *   data: z.object({ id: z.string(), name: z.string() }),
 * });
 * ```
 */
export function event<TData extends z.ZodType>(def: {
	data: TData;
}): EventDef<TData> {
	return { _type: "event", ...def };
}

/**
 * Schema definition containing methods and events
 */
export interface RpcSchema {
	methods?: Record<string, MethodDef>;
	events?: Record<string, EventDef>;
}

/**
 * Infer the input type from a method definition
 *
 * @typeParam T - A MethodDef type to extract the input from
 */
export type InferInput<T> =
	T extends MethodDef<infer TInput, z.ZodType> ? z.infer<TInput> : never;

/**
 * Infer the output type from a method definition
 *
 * @typeParam T - A MethodDef type to extract the output from
 */
export type InferOutput<T> =
	T extends MethodDef<z.ZodType, infer TOutput> ? z.infer<TOutput> : never;

/**
 * Infer the data type from an event definition
 *
 * @typeParam T - An EventDef type to extract the data type from
 */
export type InferEventData<T> =
	T extends EventDef<infer TData> ? z.infer<TData> : never;

/**
 * Infer method signatures from a schema's methods
 */
export type InferMethods<T extends RpcSchema> =
	T["methods"] extends Record<string, MethodDef>
		? {
				[K in StringKeys<T["methods"]>]: (
					input: InferInput<T["methods"][K]>,
				) => Promise<InferOutput<T["methods"][K]>>;
			}
		: object;

/**
 * Infer event emitter signatures from a schema's events
 */
export type InferEvents<T extends RpcSchema> =
	T["events"] extends Record<string, EventDef>
		? {
				[K in StringKeys<T["events"]>]: InferEventData<T["events"][K]>;
			}
		: object;

/**
 * Provider type - implements the local methods defined in a schema
 */
export type Provider<T extends RpcSchema> = InferMethods<T>;

/**
 * Driver type - proxy to call remote methods defined in a schema
 */
export type Driver<T extends RpcSchema> = InferMethods<T>;

/**
 * Event handler type - handles incoming events
 */
export type EventHandler<T extends RpcSchema, ExtraArgs extends any[] = []> = <
	K extends StringKeys<T["events"]>,
>(
	...args: [
		...ExtraArgs,
		event: K,
		data: T["events"] extends Record<string, EventDef>
			? InferEventData<T["events"][K]>
			: never,
	]
) => void;

/**
 * Event emitter type - emits outgoing events
 */
export type EventEmitter<T extends RpcSchema, ExtraArgs extends any[] = []> = <
	K extends StringKeys<T["events"]>,
>(
	...args: [
		event: K,
		data: T["events"] extends Record<string, EventDef>
			? InferEventData<T["events"][K]>
			: never,
		...ExtraArgs,
	]
) => void;
