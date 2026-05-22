// tests/unit/iso-week.test.ts
import { describe, expect, it } from "bun:test";
import {
  formatIsoWeek,
  isoWeekOf,
  lastCompleteWeek,
  parseIsoWeek,
  previousWeek,
  weekBounds,
  weeksInIsoYear,
} from "../../src/stats/iso-week.ts";

describe("iso-week", () => {
  it("isoWeekOf uses the Thursday rule", () => {
    expect(isoWeekOf(new Date("2026-01-01T12:00:00Z"))).toEqual({ year: 2026, week: 1 });
    expect(isoWeekOf(new Date("2021-01-01T12:00:00Z"))).toEqual({ year: 2020, week: 53 });
  });

  it("weekBounds is a half-open Monday→Monday UTC range", () => {
    expect(weekBounds(2026, 20)).toEqual({
      since: "2026-05-11T00:00:00.000Z",
      until: "2026-05-18T00:00:00.000Z",
    });
  });

  it("weeksInIsoYear returns 52 or 53", () => {
    expect(weeksInIsoYear(2026)).toBe(53);
    expect(weeksInIsoYear(2025)).toBe(52);
  });

  it("weekBounds AND parseIsoWeek reject out-of-range weeks", () => {
    expect(() => weekBounds(2026, 54)).toThrow();
    expect(() => weekBounds(2026, 0)).toThrow();
    expect(() => parseIsoWeek("2026-W54")).toThrow();
    expect(() => parseIsoWeek("2026-W00")).toThrow();
    expect(() => parseIsoWeek("garbage")).toThrow();
  });

  it("parse/format roundtrip", () => {
    expect(formatIsoWeek({ year: 2026, week: 20 })).toBe("2026-W20");
    expect(parseIsoWeek("2026-W20")).toEqual({ year: 2026, week: 20 });
    expect(parseIsoWeek("2026-W05")).toEqual({ year: 2026, week: 5 });
  });

  it("previousWeek of W01 rolls into the prior ISO year's last week", () => {
    expect(previousWeek({ year: 2026, week: 1 })).toEqual({ year: 2025, week: 52 });
    expect(previousWeek({ year: 2021, week: 1 })).toEqual({ year: 2020, week: 53 });
    expect(previousWeek({ year: 2026, week: 20 })).toEqual({ year: 2026, week: 19 });
  });

  it("lastCompleteWeek picks the ended week, even on a Sunday UTC", () => {
    expect(lastCompleteWeek(new Date("2026-05-17T23:59:00Z"))).toEqual({ year: 2026, week: 19 });
    expect(lastCompleteWeek(new Date("2026-05-18T00:00:00Z"))).toEqual({ year: 2026, week: 20 });
  });
});
