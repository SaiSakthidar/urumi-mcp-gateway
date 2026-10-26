import pg from "pg";

// bigint/bigserial columns come back as strings by default; our ids fit in a JS number.
pg.types.setTypeParser(20, (value: string) => Number.parseInt(value, 10));

export const pool = new pg.Pool({ max: 5 });
