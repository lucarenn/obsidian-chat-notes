import { describe, expect, it } from "vitest";
import { compareNumericIds, incrementNumericId, isNumericId } from "../src/util";

/* An imported Discord snowflake is 19 digits, past Number.MAX_SAFE_INTEGER (16 digits), so
   the float path silently rounds. These two ids are distinct as strings and identical as
   numbers - which is the whole reason the arithmetic is done digit by digit. */
const SNOWFLAKE = "1234567890123456789";
const SNOWFLAKE_BELOW = "1234567890123456788";

describe("compareNumericIds", () => {
	it("separates two snowflakes that collapse to the same JS number", () => {
		// the bug this guards, spelled out: as floats these are equal
		expect(Number(SNOWFLAKE)).toBe(Number(SNOWFLAKE_BELOW));

		expect(compareNumericIds(SNOWFLAKE, SNOWFLAKE_BELOW)).toBeGreaterThan(0);
		expect(compareNumericIds(SNOWFLAKE_BELOW, SNOWFLAKE)).toBeLessThan(0);
		expect(compareNumericIds(SNOWFLAKE, SNOWFLAKE)).toBe(0);
	});

	it("orders by length before content, so 100 beats 99", () => {
		expect(compareNumericIds("100", "99")).toBeGreaterThan(0);
		expect(compareNumericIds("99", "100")).toBeLessThan(0);
	});

	it("compares equal lengths lexicographically", () => {
		expect(compareNumericIds("199", "200")).toBeLessThan(0);
		expect(compareNumericIds("200", "199")).toBeGreaterThan(0);
	});

	it("ignores leading zeros on both sides", () => {
		expect(compareNumericIds("007", "7")).toBe(0);
		expect(compareNumericIds("0000000000000000042", "42")).toBe(0);
	});

	it("treats an all-zero id as zero", () => {
		expect(compareNumericIds("000", "0")).toBe(0);
	});
});

describe("incrementNumericId", () => {
	/* nextMessageId feeds this the highest id in the file. Off by one here means a new
	   message either overwrites an existing one or skips a number. */
	it("is exact at snowflake length, where +1 on a number is not", () => {
		expect(incrementNumericId(SNOWFLAKE)).toBe("1234567890123456790");

		// what the float path would have produced
		expect(String(Number(SNOWFLAKE) + 1)).not.toBe("1234567890123456790");
	});

	it("carries across a full run of nines", () => {
		expect(incrementNumericId("999")).toBe("1000");
		expect(incrementNumericId("9")).toBe("10");
		expect(incrementNumericId("9999999999999999999")).toBe("10000000000000000000");
	});

	it("carries a single column without touching the rest", () => {
		expect(incrementNumericId("1099")).toBe("1100");
	});

	it("starts a fresh file at 1", () => {
		expect(incrementNumericId("0")).toBe("1");
	});

	it("strips leading zeros rather than preserving them", () => {
		expect(incrementNumericId("007")).toBe("8");
	});
});

describe("isNumericId", () => {
	it("accepts a plain run of digits", () => {
		expect(isNumericId("0")).toBe(true);
		expect(isNumericId(SNOWFLAKE)).toBe(true);
	});

	// a non-numeric id is legal in a file; it simply takes no part in the maximum
	it("rejects anything else, so it cannot enter the id arithmetic", () => {
		expect(isNumericId("")).toBe(false);
		expect(isNumericId("12a")).toBe(false);
		expect(isNumericId("-1")).toBe(false);
		expect(isNumericId("1.0")).toBe(false);
		expect(isNumericId(" 1")).toBe(false);
	});
});
