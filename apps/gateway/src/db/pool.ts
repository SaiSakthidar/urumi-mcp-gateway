import pg from "pg";

// bigint/bigserial columns come back as strings by default; our ids fit in a JS number.
const INT8_OID = 20;
pg.types.setTypeParser(INT8_OID, (value: string) => Number.parseInt(value, 10));

// Connection settings come from PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE.
export const pool = new pg.Pool({ max: 10 });
